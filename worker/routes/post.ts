/**
 * The main route. Order of operations matters:
 *
 *   auth -> paywall (inert in v1) -> validate -> guardrails -> idempotency claim
 *        -> [approval fork] -> fresh token -> X call -> persist -> audit
 *
 * The approval fork is one boolean, not a second architecture: an autonomous post and
 * a human-in-the-loop draft take the identical request and differ only in whether the
 * relay calls X now or parks the row for a signed approval link. The Mind's contract,
 * error handling, and retry rules are unchanged either way.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth.ts';
import { requireRelayKey } from '../lib/auth.ts';
import { hmacHex, sha256Hex } from '../lib/crypto.ts';
import { addSpend, audit, getPostByIdem } from '../lib/db.ts';
import { RelayError, badRequest } from '../lib/errors.ts';
import {
  checkQuotas,
  containsUrl,
  costFor,
  countCodepoints,
  normalizeText,
  validateText,
} from '../lib/guardrails.ts';
import {
  claimIdempotency,
  discardClaim,
  markDone,
  markFailed,
  markPendingApproval,
  releaseFailedClaim,
  synthesizeIdemKey,
  tweetUrl,
} from '../lib/idempotency.ts';
import { paywall } from '../lib/paywall.ts';
import { getFreshAccessToken, readTokens, refreshWithLock } from '../lib/tokens.ts';
import { createPost, deletePost } from '../lib/xclient.ts';

export const post = new Hono<AppEnv>();

post.use('/x/*', requireRelayKey);
post.use('/x/post', paywall());

interface PostBody {
  text?: string;
  idempotencyKey?: string;
  allowUrl?: boolean;
  dryRun?: boolean;
  replyToTweetId?: string;
}

/** Free state check. Costs no X credits — the playbook is told to prefer it. */
post.get('/x/me', async (c) => {
  const user = c.get('user');
  const { countPostsToday } = await import('../lib/db.ts');
  const postsToday = await countPostsToday(c.env, user.user_id);

  return c.json({
    ok: true,
    userId: user.user_id,
    status: user.status,
    xHandle: user.x_handle,
    postsToday,
    dailyCap: user.daily_cap,
    minIntervalSec: user.min_interval_sec,
    requireApproval: Boolean(user.require_approval),
    budgetUsdMonth: user.budget_usd_month,
    spendUsdMonth: Number(user.spend_usd_month.toFixed(4)),
    tokenExpiresAt: user.expires_at ? new Date(user.expires_at * 1000).toISOString() : null,
    ...(user.status === 'reauth_required' && user.reauth_url ? { reauthUrl: user.reauth_url } : {}),
  });
});

post.post('/x/post', async (c) => {
  const user = c.get('user');
  const via = c.get('via');
  const body = (await c.req.json().catch(() => ({}))) as PostBody;

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text) throw badRequest('Field "text" is required.', 'text_empty');

  const allowUrl = body.allowUrl === true;
  const hasUrl = containsUrl(text);
  const textSha256 = await sha256Hex(normalizeText(text));

  // Pure validation first: no DB access, so an invalid request never consumes an
  // idempotency key.
  validateText(text, hasUrl, allowUrl);

  if (body.dryRun === true) {
    return c.json({
      ok: true,
      dryRun: true,
      wouldPost: text,
      chars: countCodepoints(text),
      hasUrl,
      costEstimateUsd: costFor(hasUrl),
      requireApproval: Boolean(user.require_approval),
    });
  }

  // Absent an explicit key, synthesise one from the text so a naive retry within five
  // minutes is physically unable to double-post.
  const idemKey = body.idempotencyKey?.trim() || (await synthesizeIdemKey(user.user_id, text));

  const needsApproval = Boolean(user.require_approval);

  // The claim comes BEFORE the quota and dedupe checks. Order matters: a retry carrying
  // the same idempotencyKey must short-circuit to the stored result, not trip the
  // duplicate-content check against its own row — which would tell the Mind to rewrite
  // and post again, producing exactly the double-post this layer exists to prevent.
  const claim = await claimIdempotency(c.env, {
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
      await audit(c.env, {
        userId: user.user_id,
        route: 'x/post',
        via,
        code: 'idempotent_replay',
        httpStatus: 200,
      });
      return c.json({
        ok: true,
        idempotent: true,
        id: p.x_tweet_id,
        url: tweetUrl(user.x_handle, p.x_tweet_id),
        costEstimateUsd: p.cost_usd ?? costFor(hasUrl),
        note: 'This exact post already went out. Do not retry.',
      });
    }
    if (p.status === 'pending_approval') {
      return c.json(
        {
          ok: true,
          idempotent: true,
          status: 'pending_approval',
          draftId: String(p.id),
          approveUrl: await approvalUrl(c.env, p.id),
          note: 'This draft is already awaiting human approval. It is NOT live.',
        },
        202,
      );
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

  // Quota, dedupe and budget checks. On failure the claim row is removed entirely, so a
  // rejected post neither counts toward the daily cap nor blocks its own idempotency key.
  let costUsd: number;
  try {
    ({ costUsd } = await checkQuotas(c.env, {
      user,
      textSha256,
      hasUrl,
      excludePostId: postId,
    }));
  } catch (err) {
    await discardClaim(c.env, postId);
    throw err;
  }

  if (needsApproval) {
    await markPendingApproval(c.env, postId);
    const url = await approvalUrl(c.env, postId);
    await audit(c.env, {
      userId: user.user_id,
      route: 'x/post',
      via,
      code: 'pending_approval',
      httpStatus: 202,
    });
    return c.json(
      {
        ok: true,
        status: 'pending_approval',
        draftId: String(postId),
        approveUrl: url,
        chars: countCodepoints(text),
        costEstimateUsd: costUsd,
        note: 'NOT posted. Report this draft and approveUrl to the human, then stop.',
      },
      202,
    );
  }

  return sendNow(c, postId, text, costUsd, body.replyToTweetId);
});

/** Retract a post. */
post.delete('/x/post/:tweetId', async (c) => {
  const user = c.get('user');
  const via = c.get('via');
  const tweetId = c.req.param('tweetId');

  const { accessToken } = await getFreshAccessToken(c.env, user);
  const deleted = await deletePost({ accessToken, tweetId });

  await c.env.DB.prepare(
    `UPDATE posts SET status = 'rejected', error_code = 'deleted' WHERE user_id = ?1 AND x_tweet_id = ?2`,
  )
    .bind(user.user_id, tweetId)
    .run();

  await audit(c.env, { userId: user.user_id, route: 'x/post/delete', via, code: 'deleted', httpStatus: 200 });
  return c.json({ ok: true, deleted, tweetId });
});

/** Force a refresh. Debug/verification aid — see verification step 5. */
post.post('/x/refresh', async (c) => {
  const user = c.get('user');
  const before = await readTokens(c.env, user).catch(() => null);
  const { user: updated } = await refreshWithLock(c.env, user);
  const after = await readTokens(c.env, updated);

  return c.json({
    ok: true,
    userId: user.user_id,
    expiresAt: updated.expires_at ? new Date(updated.expires_at * 1000).toISOString() : null,
    accessTokenChanged: before ? before.access_token !== after.access_token : null,
    refreshTokenRotated: before ? before.refresh_token !== after.refresh_token : null,
  });
});

/**
 * Shared by the autonomous path and the approval path, so an approved draft goes out
 * through exactly the same code as an autonomous post.
 */
export async function sendNow(
  c: { env: AppEnv['Bindings']; get: (k: 'user' | 'via') => any; json: any },
  postId: number,
  text: string,
  costUsd: number,
  replyToTweetId?: string,
): Promise<Response> {
  const user = c.get('user');
  const via = c.get('via');

  let accessToken: string;
  try {
    ({ accessToken } = await getFreshAccessToken(c.env, user));
  } catch (err) {
    await markFailed(c.env, postId, 'token', err instanceof Error ? err.message : String(err));
    await releaseFailedClaim(c.env, postId);
    throw err;
  }

  try {
    const result = await createPost({ accessToken, text, replyToTweetId });
    await markDone(c.env, postId, result.tweetId, result.raw, costUsd);
    await addSpend(c.env, user.user_id, costUsd);
    await audit(c.env, {
      userId: user.user_id,
      route: 'x/post',
      via,
      code: 'posted',
      httpStatus: 201,
      detail: result.tweetId,
    });
    return c.json(
      {
        ok: true,
        id: result.tweetId,
        url: tweetUrl(user.x_handle, result.tweetId),
        costEstimateUsd: costUsd,
      },
      201,
    );
  } catch (err) {
    const code = err instanceof RelayError ? err.code : 'x_upstream_error';
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(c.env, postId, code, msg);
    // A transient failure must not permanently burn the idempotency key, or that exact
    // intent could never be retried.
    await releaseFailedClaim(c.env, postId);
    await audit(c.env, {
      userId: user.user_id,
      route: 'x/post',
      via,
      code,
      httpStatus: err instanceof RelayError ? err.httpStatus : 502,
      detail: msg,
    });
    throw err;
  }
}

export async function approvalUrl(env: AppEnv['Bindings'], postId: number): Promise<string> {
  const sig = await hmacHex(env.APPROVAL_HMAC_KEY, `draft:${postId}`);
  return `${env.RELAY_BASE_URL}/approve/${postId}?t=${sig}`;
}
