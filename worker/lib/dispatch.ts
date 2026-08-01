/**
 * The single posting path.
 *
 * Both callers go through here: the `/x/post` route (a Mind or a human, posting now) and
 * the cron dispatcher (a queued draft reaching its slot). There is deliberately no second
 * implementation — the guardrails, the idempotency ordering and the audit trail are the
 * whole value of this service, and a scheduler that reimplemented them would drift.
 *
 * This layer returns plain result objects rather than Responses, so the cron can use it
 * without pretending to be an HTTP request. Serialising to JSON is the route's job.
 *
 * ORDER OF OPERATIONS — see §8.2 of STATUS.md. Do not reorder:
 *
 *   validate (pure) -> [dry run exit] -> idempotency claim -> quotas/dedupe/budget
 *     -> [approval fork] -> fresh token -> X call -> persist -> audit
 *
 * The claim comes BEFORE dedupe and quotas. Reversed, a legitimate retry carrying the same
 * key trips `duplicate_recent_text` against its own row, and the playbook reads that code
 * as "rewrite and post again" — producing exactly the double-post the layer prevents.
 */
import { hmacHex, sha256Hex } from './crypto.ts';
import { addSpend, audit } from './db.ts';
import { RelayError } from './errors.ts';
import {
  checkQuotas,
  containsUrl,
  costFor,
  countCodepoints,
  normalizeText,
  validateText,
} from './guardrails.ts';
import {
  claimIdempotency,
  discardClaim,
  markDone,
  markFailed,
  markPendingApproval,
  releaseFailedClaim,
  synthesizeIdemKey,
  tweetUrl,
} from './idempotency.ts';
import { getFreshAccessToken } from './tokens.ts';
import { createPost } from './xclient.ts';
import type { Env, UserRow, Via } from '../types.ts';

export interface DispatchArgs {
  text: string;
  idempotencyKey?: string;
  allowUrl?: boolean;
  dryRun?: boolean;
  replyToTweetId?: string;
  /** Caller-supplied proof-of-execution token; echoed into audit.detail. See §8.4. */
  nonce?: string | null;
}

export type DispatchResult =
  | {
      kind: 'dry_run';
      text: string;
      chars: number;
      hasUrl: boolean;
      costEstimateUsd: number;
      requireApproval: boolean;
    }
  | {
      kind: 'posted';
      postId: number;
      tweetId: string;
      url: string;
      costUsd: number;
      /** True when this exact intent had already been sent; no new tweet was created. */
      idempotent: boolean;
    }
  | {
      kind: 'pending_approval';
      postId: number;
      approveUrl: string;
      chars: number;
      costUsd: number;
      idempotent: boolean;
    };

/** Nonces are echoed into audit.detail, so keep them short and harmless. */
export function safeNonce(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

/** Append the nonce to an audit detail string so verification can match on it. */
function withNonce(detail: string | null, nonce: string | null): string | null {
  if (!nonce) return detail;
  return detail ? `${detail} nonce=${nonce}` : `nonce=${nonce}`;
}

export async function approvalUrl(env: Env, postId: number): Promise<string> {
  const sig = await hmacHex(env.APPROVAL_HMAC_KEY, `draft:${postId}`);
  return `${env.RELAY_BASE_URL}/approve/${postId}?t=${sig}`;
}

export async function dispatchPost(
  env: Env,
  user: UserRow,
  via: Via,
  args: DispatchArgs,
): Promise<DispatchResult> {
  const text = args.text;
  const nonce = args.nonce ?? null;
  const allowUrl = args.allowUrl === true;
  const hasUrl = containsUrl(text);
  const textSha256 = await sha256Hex(normalizeText(text));

  // Pure validation first: no DB access, so an invalid request never consumes a key.
  validateText(text, hasUrl, allowUrl);

  if (args.dryRun === true) {
    // Audit dry runs too. This used to return before writing a row, which made a
    // legitimate dry run indistinguishable from a caller that never called at all — so
    // the loop's "did this really happen" check cried wolf every time (§8.7).
    await audit(env, {
      userId: user.user_id,
      route: 'x/post',
      via,
      code: 'dry_run',
      httpStatus: 200,
      detail: withNonce(null, nonce),
    });
    return {
      kind: 'dry_run',
      text,
      chars: countCodepoints(text),
      hasUrl,
      costEstimateUsd: costFor(hasUrl),
      requireApproval: Boolean(user.require_approval),
    };
  }

  // Absent an explicit key, synthesise one from the text so a naive retry within five
  // minutes is physically unable to double-post.
  const idemKey = args.idempotencyKey?.trim() || (await synthesizeIdemKey(user.user_id, text));
  const needsApproval = Boolean(user.require_approval);

  const claim = await claimIdempotency(env, {
    userId: user.user_id,
    idemKey,
    text,
    textSha256,
    hasUrl,
    via,
    initialStatus: needsApproval ? 'pending_approval' : 'in_flight',
  });

  if (claim.kind === 'replay') {
    const p = claim.post;
    if (p.status === 'done' && p.x_tweet_id) {
      await audit(env, {
        userId: user.user_id,
        route: 'x/post',
        via,
        code: 'idempotent_replay',
        httpStatus: 200,
        detail: withNonce(null, nonce),
      });
      return {
        kind: 'posted',
        postId: p.id,
        tweetId: p.x_tweet_id,
        url: tweetUrl(user.x_handle, p.x_tweet_id),
        costUsd: p.cost_usd ?? costFor(hasUrl),
        idempotent: true,
      };
    }
    if (p.status === 'pending_approval') {
      return {
        kind: 'pending_approval',
        postId: p.id,
        approveUrl: await approvalUrl(env, p.id),
        chars: countCodepoints(p.text),
        costUsd: costFor(Boolean(p.has_url)),
        idempotent: true,
      };
    }
    if (p.status === 'rejected') {
      throw new RelayError(
        'relay_forbidden',
        409,
        'This draft was rejected by the account owner. Do not resend it.',
      );
    }
    // 'failed' fell through to a fresh claim in claimIdempotency, so this is unexpected.
    throw new RelayError('relay_internal', 500, `Unexpected replay state: ${p.status}`);
  }

  const postId = claim.postId;

  // On failure the claim row is removed entirely, so a rejected post neither counts
  // toward the cap nor blocks its own idempotency key.
  let costUsd: number;
  try {
    ({ costUsd } = await checkQuotas(env, { user, textSha256, hasUrl, excludePostId: postId }));
  } catch (err) {
    await discardClaim(env, postId);
    throw err;
  }

  if (needsApproval) {
    await markPendingApproval(env, postId);
    const url = await approvalUrl(env, postId);
    await audit(env, {
      userId: user.user_id,
      route: 'x/post',
      via,
      code: 'pending_approval',
      httpStatus: 202,
      detail: withNonce(null, nonce),
    });
    return {
      kind: 'pending_approval',
      postId,
      approveUrl: url,
      chars: countCodepoints(text),
      costUsd,
      idempotent: false,
    };
  }

  return sendNow(env, user, via, postId, text, costUsd, args.replyToTweetId, nonce);
}

/** Token fetch, X call, persistence and audit. Every failure path leaves a trace. */
async function sendNow(
  env: Env,
  user: UserRow,
  via: Via,
  postId: number,
  text: string,
  costUsd: number,
  replyToTweetId: string | undefined,
  nonce: string | null,
): Promise<DispatchResult> {
  let accessToken: string;
  try {
    ({ accessToken } = await getFreshAccessToken(env, user));
  } catch (err) {
    await failAndAudit(env, user, via, postId, err, nonce);
    throw err;
  }

  try {
    const result = await createPost({ accessToken, text, replyToTweetId });
    await markDone(env, postId, result.tweetId, result.raw, costUsd);
    await addSpend(env, user.user_id, costUsd);
    await audit(env, {
      userId: user.user_id,
      route: 'x/post',
      via,
      code: 'posted',
      httpStatus: 201,
      detail: withNonce(result.tweetId, nonce),
    });
    return {
      kind: 'posted',
      postId,
      tweetId: result.tweetId,
      url: tweetUrl(user.x_handle, result.tweetId),
      costUsd,
      idempotent: false,
    };
  } catch (err) {
    await failAndAudit(env, user, via, postId, err, nonce);
    throw err;
  }
}

/**
 * Mark the row failed, free its idempotency key, and audit.
 *
 * Releasing the key matters: a transient 502 must not make that exact intent unretryable
 * forever. Auditing matters because the audit table is the ground truth for "did this
 * request happen" — a request that dies before reaching X must still leave a trace.
 */
async function failAndAudit(
  env: Env,
  user: UserRow,
  via: Via,
  postId: number,
  err: unknown,
  nonce: string | null,
): Promise<void> {
  const code = err instanceof RelayError ? err.code : 'x_upstream_error';
  const msg = err instanceof Error ? err.message : String(err);
  await markFailed(env, postId, code, msg);
  await releaseFailedClaim(env, postId);
  await audit(env, {
    userId: user.user_id,
    route: 'x/post',
    via,
    code,
    httpStatus: err instanceof RelayError ? err.httpStatus : 502,
    detail: withNonce(msg, nonce),
  });
}
