import type { Env, PostRow, UserRow, Via } from '../types.ts';

export const now = () => Math.floor(Date.now() / 1000);

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

export async function getUser(env: Env, userId: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE user_id = ?1')
    .bind(userId)
    .first<UserRow>();
}

/** Look up by sha256(key) only — the plaintext key is never stored or compared. */
export async function getUserByKeyHash(
  env: Env,
  keyHash: string,
): Promise<{ user: UserRow; keyId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT u.*, k.key_id AS _key_id
       FROM relay_keys k
       JOIN users u ON u.user_id = k.user_id
      WHERE k.key_hash = ?1
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > ?2)`,
  )
    .bind(keyHash, now())
    .first<UserRow & { _key_id: string }>();

  if (!row) return null;
  const { _key_id, ...user } = row;
  return { user: user as UserRow, keyId: _key_id };
}

export async function audit(
  env: Env,
  entry: {
    userId?: string | null;
    route: string;
    via?: Via | null;
    code?: string | null;
    httpStatus?: number | null;
    xStatus?: number | null;
    detail?: string | null;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit (ts, user_id, route, via, code, http_status, x_status, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        now(),
        entry.userId ?? null,
        entry.route,
        entry.via ?? null,
        entry.code ?? null,
        entry.httpStatus ?? null,
        entry.xStatus ?? null,
        entry.detail?.slice(0, 2000) ?? null,
      )
      .run();
  } catch (err) {
    // Auditing must never be the reason a request fails.
    console.error('[audit] write failed', err);
  }
}

export async function getPostByIdem(
  env: Env,
  userId: string,
  idemKey: string,
): Promise<PostRow | null> {
  return env.DB.prepare('SELECT * FROM posts WHERE user_id = ?1 AND idem_key = ?2')
    .bind(userId, idemKey)
    .first<PostRow>();
}

export async function getPostById(env: Env, id: number): Promise<PostRow | null> {
  return env.DB.prepare('SELECT * FROM posts WHERE id = ?1').bind(id).first<PostRow>();
}

/**
 * Posts in the ROLLING last 24 hours. Named for what it measures.
 *
 * It was `countPostsToday`, which invited the reading "posts so far on the current
 * calendar day" — a different number, and the source of the two-definitions-of-day
 * confusion this scheduler exists to remove. The calendar-day question is now answered by
 * the slot schedule (lib/schedule.ts); this function only backs the safety ceiling.
 */
export async function countPostsRolling24h(
  env: Env,
  userId: string,
  excludePostId = 0,
): Promise<number> {
  const since = now() - 86_400;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM posts
      WHERE user_id = ?1 AND created_at > ?2
        AND status IN ('done','in_flight','pending_approval')
        AND id != ?3`,
  )
    .bind(userId, since, excludePostId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function lastPostAt(env: Env, userId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT MAX(created_at) AS t FROM posts WHERE user_id = ?1 AND status = 'done'`,
  )
    .bind(userId)
    .first<{ t: number | null }>();
  return row?.t ?? null;
}

/** X's automation rules prohibit duplicate content; catch it before paying for a 403. */
export async function findRecentDuplicate(
  env: Env,
  userId: string,
  textSha256: string,
  windowSec = 7 * 86_400,
  excludePostId = 0,
): Promise<PostRow | null> {
  return env.DB.prepare(
    `SELECT * FROM posts
      WHERE user_id = ?1 AND text_sha256 = ?2 AND created_at > ?3
        AND status IN ('done','in_flight','pending_approval')
        AND id != ?4
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId, textSha256, now() - (windowSec ?? 7 * 86_400), excludePostId)
    .first<PostRow>();
}

/** Reset the monthly spend counter when the calendar month rolls over. */
export async function rollSpendMonth(env: Env, user: UserRow): Promise<UserRow> {
  const month = currentMonth();
  if (user.spend_month === month) return user;
  await env.DB.prepare(
    `UPDATE users SET spend_usd_month = 0, spend_month = ?1, updated_at = ?2 WHERE user_id = ?3`,
  )
    .bind(month, now(), user.user_id)
    .run();
  return { ...user, spend_usd_month: 0, spend_month: month };
}

export async function addSpend(env: Env, userId: string, usd: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET spend_usd_month = spend_usd_month + ?1, updated_at = ?2 WHERE user_id = ?3`,
  )
    .bind(usd, now(), userId)
    .run();
}
