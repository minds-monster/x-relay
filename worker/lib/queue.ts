/**
 * The draft queue: what content Minds submit into, and what the cron drains.
 *
 * The relay's job is to post WELL — right cadence, right spacing, no duplicates, nothing
 * stale, nothing unreviewed. Content is somebody else's job. So a content Mind hands over
 * text and stops; this module decides when, and the cron carries it out.
 *
 * Two properties are enforced by the database rather than by application logic, because
 * both failure modes are unrecoverable in public:
 *
 *   UNIQUE(user_id, submission_id)   a content Mind retrying its submit enqueues once.
 *   UNIQUE(user_id, slot_id)         two cron ticks cannot bind the same slot twice.
 *
 * The second is the partial index `queue_slot_unique`, and it is the reason binding is an
 * UPDATE guarded by a conditional rather than a read-then-write.
 */
import type { Env, QueueRow, QueueStatus } from '../types.ts';
import { hmacHex } from './crypto.ts';
import { now } from './db.ts';

/** Statuses that still occupy a place in line. */
export const PENDING_STATUSES: QueueStatus[] = ['queued', 'held'];

export async function getQueueItem(env: Env, id: number): Promise<QueueRow | null> {
  return env.DB.prepare('SELECT * FROM queue WHERE id = ?1').bind(id).first<QueueRow>();
}

export async function getBySubmissionId(
  env: Env,
  userId: string,
  submissionId: string,
): Promise<QueueRow | null> {
  return env.DB.prepare('SELECT * FROM queue WHERE user_id = ?1 AND submission_id = ?2')
    .bind(userId, submissionId)
    .first<QueueRow>();
}

export async function listPending(env: Env, userId: string, limit = 50): Promise<QueueRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM queue
      WHERE user_id = ?1 AND status IN ('queued','held')
      ORDER BY priority DESC, created_at ASC
      LIMIT ?2`,
  )
    .bind(userId, limit)
    .all<QueueRow>();
  return results ?? [];
}

export async function insertQueued(
  env: Env,
  args: {
    userId: string;
    submissionId: string;
    source: string | null;
    text: string;
    textSha256: string;
    hasUrl: boolean;
    allowUrl: boolean;
    priority: number;
    expiresAt: number;
  },
): Promise<number> {
  const t = now();
  const res = await env.DB.prepare(
    `INSERT INTO queue (user_id, submission_id, source, text, text_sha256, has_url,
                        allow_url, priority, status, expires_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9, ?10, ?10)`,
  )
    .bind(
      args.userId,
      args.submissionId,
      args.source,
      args.text,
      args.textSha256,
      args.hasUrl ? 1 : 0,
      args.allowUrl ? 1 : 0,
      args.priority,
      args.expiresAt,
      t,
    )
    .run();
  return Number(res.meta.last_row_id);
}

/**
 * Mark everything past its TTL as expired.
 *
 * A draft written on Tuesday about Tuesday's news must not surface on Friday because the
 * queue happened to be long. Expiry is what makes a backlog safe to accumulate. Only
 * `queued` rows expire: a `held` row is already bound to an imminent slot.
 */
export async function expireStale(env: Env, userId: string): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE queue SET status = 'expired', updated_at = ?1
      WHERE user_id = ?2 AND status = 'queued' AND expires_at <= ?1`,
  )
    .bind(now(), userId)
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Bind the best available draft to a slot, atomically.
 *
 * "Best" is highest priority, then oldest — so an urgent submission jumps the line but
 * equal-priority drafts keep FIFO order and nothing starves.
 *
 * The UPDATE is conditional on the row still being `queued`, and the unique index on
 * (user_id, slot_id) means a concurrent tick that picked the same row loses the write
 * rather than producing a second binding. Returns null when the queue is empty or the
 * slot was already taken.
 */
export async function bindToSlot(
  env: Env,
  userId: string,
  slotId: string,
  holdUntil: number,
): Promise<QueueRow | null> {
  const candidate = await env.DB.prepare(
    `SELECT * FROM queue
      WHERE user_id = ?1 AND status = 'queued' AND expires_at > ?2
      ORDER BY priority DESC, created_at ASC
      LIMIT 1`,
  )
    .bind(userId, now())
    .first<QueueRow>();

  if (!candidate) return null;

  try {
    const res = await env.DB.prepare(
      `UPDATE queue SET status = 'held', slot_id = ?1, hold_until = ?2, updated_at = ?3
        WHERE id = ?4 AND status = 'queued'`,
    )
      .bind(slotId, holdUntil, now(), candidate.id)
      .run();
    if ((res.meta.changes ?? 0) === 0) return null; // another tick took it first
  } catch (err) {
    // Unique-index violation on (user_id, slot_id): this slot is already bound. Not an
    // error — it is the concurrency control doing its job.
    if (/UNIQUE|constraint/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }

  return { ...candidate, status: 'held', slot_id: slotId, hold_until: holdUntil };
}

/** Is a slot already spoken for? Includes terminal states, so a vetoed slot stays empty. */
export async function slotIsBound(env: Env, userId: string, slotId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT id FROM queue WHERE user_id = ?1 AND slot_id = ?2 LIMIT 1',
  )
    .bind(userId, slotId)
    .first<{ id: number }>();
  return row !== null;
}

/** Held drafts whose slot time has arrived. */
export async function dueForDispatch(env: Env, atSec: number, limit = 10): Promise<QueueRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM queue
      WHERE status = 'held' AND hold_until IS NOT NULL AND hold_until <= ?1
      ORDER BY hold_until ASC LIMIT ?2`,
  )
    .bind(atSec, limit)
    .all<QueueRow>();
  return results ?? [];
}

export async function setStatus(
  env: Env,
  id: number,
  status: QueueStatus,
  extra: { postId?: number | null; errorCode?: string | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE queue SET status = ?1, post_id = COALESCE(?2, post_id),
            error_code = ?3, updated_at = ?4
      WHERE id = ?5`,
  )
    .bind(status, extra.postId ?? null, extra.errorCode ?? null, now(), id)
    .run();
}

/**
 * Veto a held draft, only if it is still held.
 *
 * Conditional on status so that clicking the link a second time — or clicking it in the
 * seconds after the cron already sent the post — reports the truth instead of silently
 * appearing to have worked. Returns false when there was nothing left to stop.
 */
export async function vetoIfHeld(env: Env, id: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE queue SET status = 'vetoed', updated_at = ?1 WHERE id = ?2 AND status = 'held'`,
  )
    .bind(now(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Signed veto link. Same mechanism and same key as the approval link. */
export async function vetoUrl(env: Env, queueId: number): Promise<string> {
  const sig = await hmacHex(env.APPROVAL_HMAC_KEY, `queue:${queueId}`);
  return `${env.RELAY_BASE_URL}/queue/${queueId}/veto?t=${sig}`;
}

export async function vetoSignature(env: Env, queueId: number): Promise<string> {
  return hmacHex(env.APPROVAL_HMAC_KEY, `queue:${queueId}`);
}
