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
import { normalizeSlots, parseSlots, validateSlots, ScheduleError } from '../lib/schedule.ts';
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

      // The schedule: when posts go out.
      slotsUtc: parseSlots(user.slots_utc),
      holdSec: user.hold_sec,
      queueTtlSec: user.queue_ttl_sec,

      // A rolling-24h ceiling, not the schedule. Both names are shown so the distinction
      // is visible wherever this record is read.
      rate24hCap: user.daily_cap,
      dailyCap: user.daily_cap,

      minIntervalSec: user.min_interval_sec,
      budgetUsdMonth: user.budget_usd_month,
      spendUsdMonth: user.spend_usd_month,
      reauthUrl: user.reauth_url,
    },
  });
});

/**
 * Mint an ADDITIONAL relay key, leaving existing ones alone.
 *
 * One key per content Mind. `rotate-key` deliberately expires its siblings — that is what
 * makes rotation meaningful — but that is the wrong tool for adding a caller: revoking a
 * single misbehaving Mind should not take every other Mind offline with it.
 */
admin.post('/admin/users/:id/keys', async (c) => {
  const userId = c.req.param('id');
  const user = await getUser(c.env, userId);
  if (!user) throw notFound(`No such user: ${userId}`);

  const body = (await c.req.json().catch(() => ({}))) as { label?: string };

  const isProd = !c.env.RELAY_BASE_URL.includes('127.0.0.1') && !c.env.RELAY_BASE_URL.includes('localhost');
  const { key, keyId } = mintRelayKey(isProd);
  await insertRelayKey(c.env, userId, key, keyId);

  await audit(c.env, {
    userId,
    route: 'admin/keys',
    via: 'admin',
    code: 'key_added',
    detail: body.label?.slice(0, 64) ?? null,
  });

  return c.json(
    {
      ok: true,
      userId,
      keyId,
      // Shown exactly once. Only sha256(key) is stored.
      relayKey: key,
      label: body.label ?? null,
      note: 'Give this to exactly one caller. Revoking it will not affect the others.',
    },
    201,
  );
});

admin.get('/admin/users/:id/keys', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT key_id, created_at, revoked_at, expires_at FROM relay_keys
      WHERE user_id = ?1 ORDER BY created_at DESC`,
  )
    .bind(c.req.param('id'))
    .all();

  return c.json({
    ok: true,
    keys: (results ?? []).map((r: any) => ({
      keyId: r.key_id,
      createdAt: new Date(r.created_at * 1000).toISOString(),
      revokedAt: r.revoked_at ? new Date(r.revoked_at * 1000).toISOString() : null,
      expiresAt: r.expires_at ? new Date(r.expires_at * 1000).toISOString() : null,
      active: !r.revoked_at && (!r.expires_at || r.expires_at > now()),
    })),
  });
});

/** Revoke one key immediately. No grace window: revocation is for when you mean it. */
admin.delete('/admin/users/:id/keys/:keyId', async (c) => {
  const userId = c.req.param('id');
  const keyId = c.req.param('keyId');

  const res = await c.env.DB.prepare(
    `UPDATE relay_keys SET revoked_at = ?1
      WHERE user_id = ?2 AND key_id = ?3 AND revoked_at IS NULL`,
  )
    .bind(now(), userId, keyId)
    .run();

  if ((res.meta.changes ?? 0) === 0) throw notFound(`No active key ${keyId} for ${userId}.`);

  await audit(c.env, { userId, route: 'admin/keys', via: 'admin', code: 'key_revoked', detail: keyId });
  return c.json({ ok: true, userId, keyId, revoked: true });
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
  slotsUtc?: unknown[];
  holdSec?: number;
  queueTtlSec?: number;
}

admin.patch('/admin/users/:id', async (c) => {
  const userId = c.req.param('id');
  const user = await getUser(c.env, userId);
  if (!user) throw notFound();

  const body = (await c.req.json().catch(() => ({}))) as PatchUserBody;
  const sets: string[] = [];
  const vals: unknown[] = [];

  // Validate the schedule against whichever minInterval will be in force after this
  // request, not the one currently stored — otherwise setting both in a single call
  // checks the new slots against the old interval and can accept a schedule that is
  // guaranteed to fail at dispatch.
  const effectiveInterval = body.minIntervalSec ?? user.min_interval_sec;

  if (body.slotsUtc !== undefined) {
    if (!Array.isArray(body.slotsUtc)) throw badRequest('slotsUtc must be an array of "HH:MM" strings.');
    try {
      const slots = normalizeSlots(body.slotsUtc);
      validateSlots(slots, effectiveInterval);
      sets.push(`slots_utc = ?${sets.length + 1}`);
      vals.push(JSON.stringify(slots));
    } catch (err) {
      if (err instanceof ScheduleError) throw badRequest(err.message);
      throw err;
    }
  } else if (body.minIntervalSec !== undefined) {
    // Widening the interval can invalidate a schedule that was fine before.
    try {
      validateSlots(parseSlots(user.slots_utc), effectiveInterval);
    } catch (err) {
      if (err instanceof ScheduleError) throw badRequest(err.message);
      throw err;
    }
  }

  if (body.holdSec !== undefined) {
    if (!Number.isFinite(body.holdSec) || body.holdSec < 0) {
      throw badRequest('holdSec must be a non-negative number of seconds.');
    }
    sets.push(`hold_sec = ?${sets.length + 1}`);
    vals.push(Math.trunc(body.holdSec));
  }

  if (body.queueTtlSec !== undefined) {
    if (!Number.isFinite(body.queueTtlSec) || body.queueTtlSec <= 0) {
      throw badRequest('queueTtlSec must be a positive number of seconds.');
    }
    sets.push(`queue_ttl_sec = ?${sets.length + 1}`);
    vals.push(Math.trunc(body.queueTtlSec));
  }

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
