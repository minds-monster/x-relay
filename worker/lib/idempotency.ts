/**
 * Idempotency for POST /x/post — mandatory, not optional.
 *
 * The Minds `HTTP_Execute` primitive has no documented retry semantics, so we assume
 * it retries. A duplicate tweet is not recoverable by an apology, so the design assumes
 * the worst case: even a caller that omits `idempotencyKey` entirely cannot double-post
 * within a five-minute window, because we synthesise a key from the text itself.
 */
import type { Env, PostRow, PostStatus } from '../types.ts';
import { sha256Hex } from './crypto.ts';
import { getPostByIdem, now } from './db.ts';
import { normalizeText } from './guardrails.ts';
import { RelayError } from './errors.ts';

/** An in_flight row older than this is assumed abandoned and may be taken over. */
const IN_FLIGHT_STALE_SEC = 60;

/**
 * Synthesised key for callers that omit one: same user + same text within the same
 * 5-minute bucket collapses to one post.
 */
export async function synthesizeIdemKey(userId: string, text: string): Promise<string> {
  const bucket = Math.floor(Date.now() / 1000 / 300);
  return 'auto_' + (await sha256Hex(`${userId}|${normalizeText(text)}|${bucket}`)).slice(0, 32);
}

export type ClaimResult =
  | { kind: 'claimed'; postId: number }
  | { kind: 'replay'; post: PostRow };

/**
 * Insert-first claim. The UNIQUE(user_id, idem_key) constraint is the actual mutual
 * exclusion; everything else is interpretation of the conflict.
 */
export async function claimIdempotency(
  env: Env,
  args: {
    userId: string;
    idemKey: string;
    text: string;
    textSha256: string;
    hasUrl: boolean;
    via: string;
    initialStatus: PostStatus;
  },
): Promise<ClaimResult> {
  const t = now();
  try {
    const res = await env.DB.prepare(
      `INSERT INTO posts (user_id, idem_key, status, text, text_sha256, has_url, via, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        args.userId,
        args.idemKey,
        args.initialStatus,
        args.text,
        args.textSha256,
        args.hasUrl ? 1 : 0,
        args.via,
        t,
      )
      .run();
    const postId = Number(res.meta.last_row_id);
    return { kind: 'claimed', postId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/UNIQUE|constraint/i.test(msg)) throw err;

    const existing = await getPostByIdem(env, args.userId, args.idemKey);
    if (!existing) throw err; // conflict with nothing to read: genuinely unexpected

    if (existing.status === 'in_flight' && t - existing.created_at < IN_FLIGHT_STALE_SEC) {
      throw new RelayError(
        'post_in_flight',
        409,
        'An identical post is already being sent. Do not retry.',
        false,
      );
    }

    if (existing.status === 'in_flight') {
      // Stale claim from a crashed request — take it over.
      await env.DB.prepare(`UPDATE posts SET created_at = ?1, via = ?2 WHERE id = ?3`)
        .bind(t, args.via, existing.id)
        .run();
      return { kind: 'claimed', postId: existing.id };
    }

    return { kind: 'replay', post: existing };
  }
}

/**
 * Remove a claim outright. Used when post-claim quota checks reject the request, so the
 * row neither counts toward the daily cap nor blocks that idempotency key.
 */
export async function discardClaim(env: Env, postId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM posts WHERE id = ?1 AND status IN ('in_flight','pending_approval')`)
    .bind(postId)
    .run();
}

export async function markDone(
  env: Env,
  postId: number,
  tweetId: string,
  raw: unknown,
  costUsd: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE posts SET status = 'done', x_tweet_id = ?1, response_json = ?2,
            cost_usd = ?3, completed_at = ?4, error_code = NULL
      WHERE id = ?5`,
  )
    .bind(tweetId, JSON.stringify(raw).slice(0, 8000), costUsd, now(), postId)
    .run();
}

export async function markFailed(
  env: Env,
  postId: number,
  code: string,
  detail: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE posts SET status = 'failed', error_code = ?1, response_json = ?2, completed_at = ?3
      WHERE id = ?4`,
  )
    .bind(code, detail.slice(0, 2000), now(), postId)
    .run();
}

export async function markPendingApproval(env: Env, postId: number): Promise<void> {
  await env.DB.prepare(`UPDATE posts SET status = 'pending_approval' WHERE id = ?1`)
    .bind(postId)
    .run();
}

/**
 * A failed post must not permanently occupy its idempotency key — otherwise a
 * transient 502 would make that exact intent unretryable forever.
 */
export async function releaseFailedClaim(env: Env, postId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE posts SET idem_key = 'failed:' || id || ':' || idem_key WHERE id = ?1 AND status = 'failed'`,
  )
    .bind(postId)
    .run();
}

export function tweetUrl(handle: string | null, tweetId: string): string {
  return `https://x.com/${handle || 'i'}/status/${tweetId}`;
}
