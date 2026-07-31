/**
 * Relay-key authentication.
 *
 * The key ends up inside Mind context, so it is treated as MEDIUM trust: it can only
 * post as one X account, every call is capped and audited, and rotation is a single
 * admin request. Only sha256(key) is ever stored.
 */
import type { Context, Next } from 'hono';
import type { Env, UserRow, Via } from '../types.ts';
import { b64uEncode, randomBytes, sha256Hex, timingSafeEqual } from './crypto.ts';
import { getUserByKeyHash, now } from './db.ts';
import { RelayError, unauthorized } from './errors.ts';

export interface AuthedVars {
  user: UserRow;
  keyId: string;
  via: Via;
}

export type AppEnv = { Bindings: Env; Variables: AuthedVars };

export function mintRelayKey(isProd: boolean): { key: string; keyId: string } {
  const prefix = isProd ? 'xr_live_' : 'xr_test_';
  return { key: prefix + b64uEncode(randomBytes(24)), keyId: 'rk_' + b64uEncode(randomBytes(6)) };
}

function bearerFrom(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m?.[1]) return m[1].trim();
  }
  // Fallback header, in case the Minds HTTP_Execute primitive strips or rewrites
  // `Authorization`. Capability there is undocumented; this costs nothing to support.
  const alt = c.req.header('x-relay-key');
  return alt ? alt.trim() : null;
}

/**
 * Best-effort provenance for the audit log. `via='mind'` is what distinguishes a real
 * Mind-driven post from a human running curl, so it must not be spoofable by accident:
 * we only trust an explicit marker the playbook sets.
 */
function detectVia(c: Context): Via {
  const marker = c.req.header('x-relay-via')?.toLowerCase();
  if (marker === 'mind' || marker === 'cron' || marker === 'approval') return marker;
  const ua = (c.req.header('user-agent') ?? '').toLowerCase();
  if (ua.includes('minds') || ua.includes('hellominds') || ua.includes('ethoswarm')) return 'mind';
  return 'curl';
}

/** Bearer auth for /x/* routes. */
export async function requireRelayKey(c: Context<AppEnv>, next: Next): Promise<void | Response> {
  const key = bearerFrom(c);
  if (!key) throw unauthorized('Missing relay key. Send `Authorization: Bearer <key>`.');

  const found = await getUserByKeyHash(c.env, await sha256Hex(key));
  if (!found) throw unauthorized();

  c.set('user', found.user);
  c.set('keyId', found.keyId);
  c.set('via', detectVia(c));
  await next();
}

/** Admin auth for /admin/* routes. */
export async function requireAdminKey(c: Context<AppEnv>, next: Next): Promise<void | Response> {
  const provided = c.req.header('x-admin-key') ?? '';
  const expected = c.env.ADMIN_KEY ?? '';
  if (!expected) {
    throw new RelayError('relay_internal', 500, 'ADMIN_KEY is not configured on this Worker.');
  }
  if (!provided || !timingSafeEqual(provided, expected)) {
    throw new RelayError('relay_forbidden', 403, 'Invalid admin key.');
  }
  c.set('via', 'admin');
  await next();
}

export async function insertRelayKey(
  env: Env,
  userId: string,
  key: string,
  keyId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO relay_keys (key_hash, user_id, key_id, created_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(await sha256Hex(key), userId, keyId, now())
    .run();
}

/** Rotation: the new key works immediately, the old one keeps working for `graceSec`. */
export async function expireOtherKeys(
  env: Env,
  userId: string,
  keepKeyId: string,
  graceSec: number,
): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE relay_keys SET expires_at = ?1
      WHERE user_id = ?2 AND key_id != ?3 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?1)`,
  )
    .bind(now() + graceSec, userId, keepKeyId)
    .run();
  return res.meta.changes ?? 0;
}
