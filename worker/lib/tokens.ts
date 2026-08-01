/**
 * Token storage, rotation persistence, and refresh serialisation.
 *
 * This is the highest-risk logic in the system. X rotates refresh tokens on EVERY
 * refresh and invalidates the previous one immediately, which creates two hazards:
 *
 *  1. Lost write -> the account is permanently unusable. Mitigated by persisting the
 *     new pair before it is used for anything, and by keeping exactly one previous
 *     generation in tokens_prev_enc so a torn write is recoverable.
 *
 *  2. Concurrent refresh -> two callers each burn a token the other still needs.
 *     Mitigated by a compare-and-swap lock on the user row: the loser waits for the
 *     winner's result instead of refreshing too.
 *
 * A Durable Object with blockConcurrencyWhile() is the stronger version of (2) and is
 * the upgrade path if this ever serves more than a handful of users. The CAS is correct
 * for the current scale and adds no extra binding.
 */
import type { Env, TokenEnvelope, UserRow, XClientCredentials } from '../types.ts';
import { decryptForUser, encryptForUser, randomBytes, b64uEncode } from './crypto.ts';
import { audit, now } from './db.ts';
import { notify } from './notify.ts';
import { RefreshError, refreshTokens, toEnvelope } from './xclient.ts';
import { RelayError } from './errors.ts';

/** Refresh when the access token has less than this long to live. */
const REFRESH_SKEW_SEC = 300;
/** How long a CAS lock is held before another caller may steal it. */
const LOCK_TTL_SEC = 30;
/** How long a losing caller waits for the winner to publish a fresh token. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 250;

export async function readTokens(env: Env, user: UserRow): Promise<TokenEnvelope> {
  if (!user.tokens_enc) {
    throw new RelayError(
      'user_not_connected',
      409,
      'This user has not connected an X account yet.',
    );
  }
  const json = await decryptForUser(
    env.MASTER_KEY_B64,
    user.tokens_enc,
    'tokens',
    user.user_id,
    env.MASTER_KEY_B64_PREV,
  );
  return JSON.parse(json) as TokenEnvelope;
}

export async function readClientCreds(
  env: Env,
  user: UserRow,
): Promise<XClientCredentials> {
  if (!user.client_id_enc) {
    throw new RelayError(
      'x_client_invalid',
      409,
      'No X client credentials stored for this user.',
    );
  }
  const clientId = await decryptForUser(
    env.MASTER_KEY_B64,
    user.client_id_enc,
    'client',
    user.user_id,
    env.MASTER_KEY_B64_PREV,
  );
  const clientSecret = user.client_secret_enc
    ? await decryptForUser(
        env.MASTER_KEY_B64,
        user.client_secret_enc,
        'client',
        user.user_id,
        env.MASTER_KEY_B64_PREV,
      )
    : null;
  return { clientId, clientSecret, clientType: user.client_type };
}

/**
 * Persist a token envelope, demoting the current ciphertext to tokens_prev_enc in the
 * same statement so there is always one recoverable generation.
 */
export async function persistTokens(
  env: Env,
  user: UserRow,
  envelope: TokenEnvelope,
  expiresAt: number,
  extra: { xUserId?: string; xHandle?: string } = {},
): Promise<void> {
  const enc = await encryptForUser(
    env.MASTER_KEY_B64,
    JSON.stringify(envelope),
    'tokens',
    user.user_id,
  );
  await env.DB.prepare(
    `UPDATE users
        SET tokens_prev_enc = tokens_enc,
            tokens_enc = ?1,
            scope = ?2,
            expires_at = ?3,
            status = 'active',
            reauth_url = NULL,
            refresh_fail_count = 0,
            x_user_id = COALESCE(?4, x_user_id),
            x_handle  = COALESCE(?5, x_handle),
            updated_at = ?6
      WHERE user_id = ?7`,
  )
    .bind(
      enc,
      envelope.scope,
      expiresAt,
      extra.xUserId ?? null,
      extra.xHandle ?? null,
      now(),
      user.user_id,
    )
    .run();
}

/** Try to take the refresh lock. Returns the token if we won, null if someone else holds it. */
async function tryAcquireLock(env: Env, userId: string): Promise<string | null> {
  const token = b64uEncode(randomBytes(12));
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE users
        SET refresh_lock = ?1, refresh_lock_until = ?2, updated_at = ?3
      WHERE user_id = ?4
        AND (refresh_lock_until IS NULL OR refresh_lock_until < ?5)`,
  )
    .bind(token, t + LOCK_TTL_SEC, t, userId, t)
    .run();
  return res.meta.changes === 1 ? token : null;
}

async function releaseLock(env: Env, userId: string, token: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET refresh_lock = NULL, refresh_lock_until = NULL, updated_at = ?1
      WHERE user_id = ?2 AND refresh_lock = ?3`,
  )
    .bind(now(), userId, token)
    .run();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Return a usable access token, refreshing if it is close to expiry.
 *
 * Callers should treat this as the only way to obtain an access token — it is what
 * guarantees rotation is persisted and refreshes are serialised.
 */
export async function getFreshAccessToken(
  env: Env,
  user: UserRow,
): Promise<{ accessToken: string; user: UserRow }> {
  if (user.status === 'disabled') {
    throw new RelayError('user_disabled', 403, 'This relay user is disabled.');
  }
  if (user.status === 'reauth_required') {
    throw new RelayError(
      'x_reauth_required',
      409,
      'X access has lapsed. The account owner must re-authorize.',
      false,
      { reauthUrl: user.reauth_url ?? undefined },
    );
  }
  if (user.status === 'client_invalid') {
    throw new RelayError(
      'x_client_invalid',
      409,
      'The stored X client credentials are rejected by X. Update them via the admin route.',
    );
  }

  const tokens = await readTokens(env, user);
  const expiresAt = user.expires_at ?? 0;
  if (expiresAt - now() > REFRESH_SKEW_SEC) {
    return { accessToken: tokens.access_token, user };
  }

  return refreshWithLock(env, user);
}

/** Force a refresh regardless of expiry (used by /x/refresh and the cron sweep). */
export async function refreshWithLock(
  env: Env,
  user: UserRow,
): Promise<{ accessToken: string; user: UserRow }> {
  const lock = await tryAcquireLock(env, user.user_id);

  if (!lock) {
    // Someone else is refreshing. Wait for their result rather than burning a second
    // rotation, which would invalidate the token they are about to store.
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_MS);
      const fresh = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?1')
        .bind(user.user_id)
        .first<UserRow>();
      if (!fresh) break;
      if (fresh.status === 'reauth_required') {
        throw new RelayError(
          'x_reauth_required',
          409,
          'X access has lapsed. The account owner must re-authorize.',
          false,
          { reauthUrl: fresh.reauth_url ?? undefined },
        );
      }
      if ((fresh.expires_at ?? 0) - now() > REFRESH_SKEW_SEC) {
        const t = await readTokens(env, fresh);
        return { accessToken: t.access_token, user: fresh };
      }
    }
    throw new RelayError(
      'x_upstream_error',
      503,
      'Token refresh is in progress. Retry shortly.',
      true,
      { retryAfterSec: 5 },
    );
  }

  try {
    const tokens = await readTokens(env, user);
    const creds = await readClientCreds(env, user);
    const res = await refreshTokens({ refreshToken: tokens.refresh_token, creds });
    const envelope = toEnvelope(res, tokens.refresh_token);
    const expiresAt = now() + (res.expires_in ?? 7200);

    // Persist BEFORE returning: the token we just received is the only valid one.
    await persistTokens(env, user, envelope, expiresAt);

    const updated = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?1')
      .bind(user.user_id)
      .first<UserRow>();
    return { accessToken: envelope.access_token, user: updated ?? user };
  } catch (err) {
    await handleRefreshFailure(env, user, err);
    throw err;
  } finally {
    await releaseLock(env, user.user_id, lock);
  }
}

/**
 * Classify a refresh failure. The classic footgun is clearing tokens on a transient
 * error, which turns a 30-second X outage into a permanent disconnection. Only a
 * genuinely dead grant clears them.
 */
async function handleRefreshFailure(env: Env, user: UserRow, err: unknown): Promise<void> {
  if (!(err instanceof RefreshError)) return;

  if (err.kind === 'dead_grant') {
    const reauthUrl = `${env.RELAY_BASE_URL}/x/oauth/start?user=${encodeURIComponent(user.user_id)}`;
    await env.DB.prepare(
      `UPDATE users
          SET status = 'reauth_required', tokens_enc = NULL, reauth_url = ?1, updated_at = ?2
        WHERE user_id = ?3`,
    )
      .bind(reauthUrl, now(), user.user_id)
      .run();
    await audit(env, {
      userId: user.user_id,
      route: 'refresh',
      via: 'cron',
      code: 'x_reauth_required',
      xStatus: err.status,
      detail: err.message,
    });
    await notify(env, `X relay: ${user.user_id} needs re-authorization. ${err.message}`);
    return;
  }

  if (err.kind === 'client_invalid') {
    await env.DB.prepare(
      `UPDATE users SET status = 'client_invalid', updated_at = ?1 WHERE user_id = ?2`,
    )
      .bind(now(), user.user_id)
      .run();
    await audit(env, {
      userId: user.user_id,
      route: 'refresh',
      via: 'cron',
      code: 'x_client_invalid',
      xStatus: err.status,
      detail: err.message,
    });
    await notify(env, `X relay: ${user.user_id} client credentials rejected. ${err.message}`);
    return;
  }

  // Transient: keep the tokens, count the failure, let cron back off.
  await env.DB.prepare(
    `UPDATE users SET refresh_fail_count = refresh_fail_count + 1, updated_at = ?1
      WHERE user_id = ?2`,
  )
    .bind(now(), user.user_id)
    .run();
  await audit(env, {
    userId: user.user_id,
    route: 'refresh',
    via: 'cron',
    code: 'x_upstream_error',
    xStatus: err.status,
    detail: err.message,
  });
}

/**
 * Cron sweep: refresh everything inside the window so /x/post almost never pays
 * refresh latency. That matters because HTTP_Execute's timeout budget is undocumented.
 */
export async function sweepRefresh(env: Env): Promise<{ checked: number; refreshed: number; failed: number }> {
  const horizon = now() + 30 * 60;
  const { results } = await env.DB.prepare(
    `SELECT * FROM users
      WHERE status = 'active' AND tokens_enc IS NOT NULL AND expires_at IS NOT NULL
        AND expires_at < ?1
        AND refresh_fail_count < 10
      ORDER BY expires_at ASC LIMIT 50`,
  )
    .bind(horizon)
    .all<UserRow>();

  let refreshed = 0;
  let failed = 0;
  for (const user of results ?? []) {
    // Exponential backoff on consecutive transient failures.
    if (user.refresh_fail_count > 0) {
      const backoff = Math.min(2 ** user.refresh_fail_count, 3600);
      if (now() - user.updated_at < backoff) continue;
    }
    try {
      await refreshWithLock(env, user);
      refreshed++;
    } catch (err) {
      failed++;
      console.error(`[sweep] ${user.user_id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked: results?.length ?? 0, refreshed, failed };
}
