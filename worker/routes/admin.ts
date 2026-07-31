/**
 * Admin routes: provision a relay user and rotate their key.
 *
 * The user supplies their OWN X app credentials here. The relay never creates X apps
 * and never shares one client across users — that is what keeps this outside the X
 * Developer Agreement III.A(e) service-bureau prohibition.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth.ts';
import { expireOtherKeys, insertRelayKey, mintRelayKey, requireAdminKey } from '../lib/auth.ts';
import { encryptForUser } from '../lib/crypto.ts';
import { audit, getUser, now } from '../lib/db.ts';
import { RelayError, badRequest, notFound } from '../lib/errors.ts';
import { assertClientType } from '../lib/xclient.ts';
import type { ClientType } from '../types.ts';

export const admin = new Hono<AppEnv>();
admin.use('/admin/*', requireAdminKey);

const ROTATION_GRACE_SEC = 24 * 3600;

interface CreateUserBody {
  userId?: string;
  label?: string;
  x?: { clientId?: string; clientSecret?: string; clientType?: string };
  redirectUri?: string;
  requireApproval?: boolean;
  dailyCap?: number;
  minIntervalSec?: number;
  budgetUsdMonth?: number;
}

admin.post('/admin/users', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateUserBody;

  const userId = (body.userId ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(userId)) {
    throw badRequest('userId must be 2-64 chars, alphanumeric plus _ and -');
  }
  if (await getUser(c.env, userId)) {
    throw new RelayError('relay_bad_request', 409, `User "${userId}" already exists.`);
  }

  const clientId = body.x?.clientId?.trim();
  if (!clientId) throw badRequest('x.clientId is required (the user\'s own X app client id)');

  const clientType: ClientType = assertClientType(body.x?.clientType ?? 'confidential');
  const clientSecret = body.x?.clientSecret?.trim() || null;
  if (clientType === 'confidential' && !clientSecret) {
    throw badRequest('x.clientSecret is required when clientType is "confidential"');
  }

  const redirectUri = (body.redirectUri ?? `${c.env.RELAY_BASE_URL}/x/oauth/callback`).trim();
  try {
    new URL(redirectUri);
  } catch {
    throw badRequest(`redirectUri is not a valid URL: ${redirectUri}`);
  }

  const clientIdEnc = await encryptForUser(c.env.MASTER_KEY_B64, clientId, 'client', userId);
  const clientSecretEnc = clientSecret
    ? await encryptForUser(c.env.MASTER_KEY_B64, clientSecret, 'client', userId)
    : null;

  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO users (
        user_id, label, client_type, client_id_enc, client_secret_enc, redirect_uri,
        status, require_approval, daily_cap, min_interval_sec, budget_usd_month,
        spend_usd_month, spend_month, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10, 0, ?11, ?12, ?12)`,
  )
    .bind(
      userId,
      body.label ?? null,
      clientType,
      clientIdEnc,
      clientSecretEnc,
      redirectUri,
      body.requireApproval === false ? 0 : 1, // approval-on unless explicitly disabled
      body.dailyCap ?? 3,
      body.minIntervalSec ?? 3600,
      body.budgetUsdMonth ?? 5.0,
      new Date().toISOString().slice(0, 7),
      t,
    )
    .run();

  const isProd = !c.env.RELAY_BASE_URL.includes('127.0.0.1') && !c.env.RELAY_BASE_URL.includes('localhost');
  const { key, keyId } = mintRelayKey(isProd);
  await insertRelayKey(c.env, userId, key, keyId);

  await audit(c.env, { userId, route: 'admin/users', via: 'admin', code: 'created', httpStatus: 201 });

  return c.json(
    {
      ok: true,
      userId,
      keyId,
      // Shown exactly once. Only sha256(key) is stored.
      relayKey: key,
      authorizeUrl: `${c.env.RELAY_BASE_URL}/x/oauth/start?user=${encodeURIComponent(userId)}`,
      next: 'Open authorizeUrl in the account owner\'s browser to connect their X account.',
    },
    201,
  );
});

admin.post('/admin/users/:id/rotate-key', async (c) => {
  const userId = c.req.param('id');
  const user = await getUser(c.env, userId);
  if (!user) throw notFound(`No such user: ${userId}`);

  const isProd = !c.env.RELAY_BASE_URL.includes('127.0.0.1') && !c.env.RELAY_BASE_URL.includes('localhost');
  const { key, keyId } = mintRelayKey(isProd);
  await insertRelayKey(c.env, userId, key, keyId);
  const expired = await expireOtherKeys(c.env, userId, keyId, ROTATION_GRACE_SEC);

  await audit(c.env, { userId, route: 'admin/rotate-key', via: 'admin', code: 'rotated' });

  return c.json({
    ok: true,
    userId,
    keyId,
    relayKey: key,
    previousKeysExpiringIn: `${ROTATION_GRACE_SEC}s`,
    previousKeyCount: expired,
    next: 'Re-send the playbook to the Mind with the new key, then confirm before the grace window closes.',
  });
});

/** Operational view. Deliberately returns no ciphertext and no secrets. */
admin.get('/admin/users/:id', async (c) => {
  const user = await getUser(c.env, c.req.param('id'));
  if (!user) throw notFound();
  return c.json({
    ok: true,
    user: {
      userId: user.user_id,
      label: user.label,
      status: user.status,
      xHandle: user.x_handle,
      xUserId: user.x_user_id,
      clientType: user.client_type,
      redirectUri: user.redirect_uri,
      tokenExpiresAt: user.expires_at ? new Date(user.expires_at * 1000).toISOString() : null,
      refreshFailCount: user.refresh_fail_count,
      requireApproval: Boolean(user.require_approval),
      dailyCap: user.daily_cap,
      minIntervalSec: user.min_interval_sec,
      budgetUsdMonth: user.budget_usd_month,
      spendUsdMonth: user.spend_usd_month,
      reauthUrl: user.reauth_url,
    },
  });
});

/**
 * Replace a user's X app credentials.
 *
 * Needed for two real cases: swapping placeholder credentials for real ones without
 * recreating the user, and recovering from status='client_invalid', which is what the
 * refresh loop sets when X rejects the client secret (typically because it was rotated
 * in the X developer portal). Without this route that state has no cure.
 *
 * Existing access/refresh tokens were issued by the OLD client, so they cannot survive a
 * client change: they are cleared and the user must re-authorize.
 */
admin.put('/admin/users/:id/x-credentials', async (c) => {
  const userId = c.req.param('id');
  const user = await getUser(c.env, userId);
  if (!user) throw notFound(`No such user: ${userId}`);

  const body = (await c.req.json().catch(() => ({}))) as {
    clientId?: string;
    clientSecret?: string;
    clientType?: string;
    redirectUri?: string;
  };

  const clientId = body.clientId?.trim();
  if (!clientId) throw badRequest('clientId is required');

  const clientType: ClientType = assertClientType(body.clientType ?? user.client_type);
  const clientSecret = body.clientSecret?.trim() || null;
  if (clientType === 'confidential' && !clientSecret) {
    throw badRequest('clientSecret is required when clientType is "confidential"');
  }

  const redirectUri = (body.redirectUri ?? user.redirect_uri ?? `${c.env.RELAY_BASE_URL}/x/oauth/callback`).trim();
  try {
    new URL(redirectUri);
  } catch {
    throw badRequest(`redirectUri is not a valid URL: ${redirectUri}`);
  }

  const clientIdEnc = await encryptForUser(c.env.MASTER_KEY_B64, clientId, 'client', userId);
  const clientSecretEnc = clientSecret
    ? await encryptForUser(c.env.MASTER_KEY_B64, clientSecret, 'client', userId)
    : null;

  await c.env.DB.prepare(
    `UPDATE users
        SET client_id_enc = ?1, client_secret_enc = ?2, client_type = ?3, redirect_uri = ?4,
            tokens_enc = NULL, tokens_prev_enc = NULL, expires_at = NULL,
            status = 'pending', reauth_url = NULL, refresh_fail_count = 0,
            updated_at = ?5
      WHERE user_id = ?6`,
  )
    .bind(clientIdEnc, clientSecretEnc, clientType, redirectUri, now(), userId)
    .run();

  await audit(c.env, {
    userId,
    route: 'admin/x-credentials',
    via: 'admin',
    code: 'credentials_replaced',
  });

  return c.json({
    ok: true,
    userId,
    clientType,
    redirectUri,
    status: 'pending',
    authorizeUrl: `${c.env.RELAY_BASE_URL}/x/oauth/start?user=${encodeURIComponent(userId)}`,
    note: 'Tokens were cleared because they belonged to the previous client. Re-authorize via authorizeUrl.',
  });
});

/**
 * Ground truth for what actually reached the relay.
 *
 * This exists because a Mind will sometimes answer from conversation context instead of
 * making the call — observed in testing: a dry run reported a 202 and an approveUrl from
 * an earlier request, with no corresponding audit row. Never treat a Mind's self-report
 * as evidence that a request happened; cross-check here.
 */
admin.get('/admin/users/:id/recent', async (c) => {
  const userId = c.req.param('id');
  const sinceSec = Number(c.req.query('sinceSec') ?? 900);

  const cutoff = now() - (Number.isFinite(sinceSec) ? sinceSec : 900);

  const { results: audits } = await c.env.DB.prepare(
    `SELECT ts, route, via, code, http_status, x_status, detail FROM audit
      WHERE user_id = ?1 AND ts >= ?2 ORDER BY ts DESC LIMIT 50`,
  )
    .bind(userId, cutoff)
    .all();

  const { results: posts } = await c.env.DB.prepare(
    `SELECT id, idem_key, status, text, has_url, x_tweet_id, cost_usd, error_code, via,
            created_at, completed_at
       FROM posts WHERE user_id = ?1 AND created_at >= ?2 ORDER BY id DESC LIMIT 25`,
  )
    .bind(userId, cutoff)
    .all();

  return c.json({
    ok: true,
    userId,
    sinceSec,
    serverTime: now(),
    audit: audits ?? [],
    posts: posts ?? [],
  });
});

interface PatchUserBody {
  requireApproval?: boolean;
  dailyCap?: number;
  minIntervalSec?: number;
  budgetUsdMonth?: number;
  status?: string;
}

admin.patch('/admin/users/:id', async (c) => {
  const userId = c.req.param('id');
  const user = await getUser(c.env, userId);
  if (!user) throw notFound();

  const body = (await c.req.json().catch(() => ({}))) as PatchUserBody;
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.requireApproval !== undefined) {
    sets.push(`require_approval = ?${sets.length + 1}`);
    vals.push(body.requireApproval ? 1 : 0);
  }
  if (body.dailyCap !== undefined) {
    sets.push(`daily_cap = ?${sets.length + 1}`);
    vals.push(body.dailyCap);
  }
  if (body.minIntervalSec !== undefined) {
    sets.push(`min_interval_sec = ?${sets.length + 1}`);
    vals.push(body.minIntervalSec);
  }
  if (body.budgetUsdMonth !== undefined) {
    sets.push(`budget_usd_month = ?${sets.length + 1}`);
    vals.push(body.budgetUsdMonth);
  }
  if (body.status !== undefined) {
    if (!['active', 'disabled'].includes(body.status)) {
      throw badRequest('status may only be set to "active" or "disabled" here');
    }
    sets.push(`status = ?${sets.length + 1}`);
    vals.push(body.status);
  }
  if (sets.length === 0) throw badRequest('No updatable fields provided.');

  sets.push(`updated_at = ?${sets.length + 1}`);
  vals.push(now());
  vals.push(userId);

  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?${vals.length}`)
    .bind(...vals)
    .run();

  await audit(c.env, { userId, route: 'admin/patch', via: 'admin', code: 'updated' });
  return c.json({ ok: true, userId, updated: sets.length - 1 });
});
