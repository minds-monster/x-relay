/**
 * Pre-flight checks that run before any X call.
 *
 * These exist for three separate reasons, worth keeping distinct:
 *  - ToS: X's automation rules prohibit duplicate content and aggressive bulk posting.
 *  - Cost: a URL in the body costs $0.20 instead of $0.015 — a 13x cliff.
 *  - Blast radius: a runaway generation loop should hit a 400, not a credit card.
 */
import type { Env, UserRow } from '../types.ts';
import { RelayError } from './errors.ts';
import {
  countPostsToday,
  findRecentDuplicate,
  lastPostAt,
  rollSpendMonth,
} from './db.ts';
import { COST_PER_POST_USD, COST_PER_POST_WITH_URL_USD } from './xclient.ts';

/** X counts weighted characters; 280 codepoints is the practical guard. */
export const MAX_POST_CODEPOINTS = 280;

/**
 * Detect anything X would linkify and bill at the URL rate. Deliberately broad —
 * a false positive costs one explicit `allowUrl: true`, a false negative costs $0.185.
 */
export function containsUrl(text: string): boolean {
  return (
    /https?:\/\/\S+/i.test(text) ||
    /\bwww\.\S+\.\S+/i.test(text) ||
    /\b[a-z0-9][a-z0-9-]*\.(com|net|org|io|ai|co|app|dev|xyz|so|gg|me|link|to|sh|fyi|news)\b(\/\S*)?/i.test(
      text,
    )
  );
}

export function costFor(hasUrl: boolean): number {
  return hasUrl ? COST_PER_POST_WITH_URL_USD : COST_PER_POST_USD;
}

export function countCodepoints(text: string): number {
  return [...text].length;
}

/** Normalise before hashing so trivial whitespace edits don't defeat dedupe. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Pure validation — no database access, no side effects. Runs BEFORE the idempotency
 * claim so an invalid request never consumes an idempotency key.
 */
export function validateText(text: string, hasUrl: boolean, allowUrl: boolean): void {
  if (!text.trim()) {
    throw new RelayError('text_empty', 400, 'Post text is empty.');
  }

  const len = countCodepoints(text);
  if (len > MAX_POST_CODEPOINTS) {
    throw new RelayError(
      'text_too_long',
      400,
      `Post is ${len} characters; the limit is ${MAX_POST_CODEPOINTS}.`,
    );
  }

  // The cost cliff is opt-in, never implicit.
  if (hasUrl && !allowUrl) {
    throw new RelayError(
      'url_not_allowed',
      400,
      `This post contains a link, which costs $${COST_PER_POST_WITH_URL_USD.toFixed(3)} instead of $${COST_PER_POST_USD.toFixed(3)}. Resend with "allowUrl": true only if a link was explicitly requested.`,
    );
  }
}

export interface GuardInput {
  user: UserRow;
  textSha256: string;
  hasUrl: boolean;
  /** The row just claimed, excluded from dedupe so a post never matches itself. */
  excludePostId: number;
}

/**
 * Quota, dedupe and budget checks. These hit the database and must run AFTER the
 * idempotency claim, so that a retry of an already-claimed intent short-circuits to the
 * stored result instead of tripping the duplicate-content check against its own row.
 */
export async function checkQuotas(
  env: Env,
  input: GuardInput,
): Promise<{ user: UserRow; costUsd: number }> {
  const { hasUrl, textSha256, excludePostId } = input;
  let user = input.user;

  const dup = await findRecentDuplicate(env, user.user_id, textSha256, undefined, excludePostId);
  if (dup) {
    throw new RelayError(
      'duplicate_recent_text',
      409,
      `This text was already posted within the last 7 days (post ${dup.id}). X prohibits duplicate content — rewrite it materially and use a new idempotencyKey.`,
    );
  }

  const todayCount = await countPostsToday(env, user.user_id, excludePostId);
  if (todayCount >= user.daily_cap) {
    throw new RelayError(
      'daily_cap_reached',
      429,
      `Daily cap of ${user.daily_cap} posts reached (${todayCount} in the last 24h).`,
    );
  }

  const last = await lastPostAt(env, user.user_id);
  if (last !== null) {
    const elapsed = Math.floor(Date.now() / 1000) - last;
    if (elapsed < user.min_interval_sec) {
      const wait = user.min_interval_sec - elapsed;
      throw new RelayError(
        'min_interval_not_elapsed',
        429,
        `Minimum interval between posts is ${user.min_interval_sec}s; ${wait}s remaining.`,
        true,
        { retryAfterSec: wait },
      );
    }
  }

  user = await rollSpendMonth(env, user);
  const costUsd = costFor(hasUrl);
  if (user.spend_usd_month + costUsd > user.budget_usd_month) {
    throw new RelayError(
      'budget_exceeded',
      402,
      `Monthly budget of $${user.budget_usd_month.toFixed(2)} would be exceeded (spent $${user.spend_usd_month.toFixed(3)}).`,
    );
  }

  return { user, costUsd };
}
