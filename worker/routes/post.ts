/**
 * The immediate-post route.
 *
 * All logic lives in lib/dispatch.ts, which the cron dispatcher also calls — see the
 * ordering note there before changing anything. This file is the HTTP shape only:
 * parse the body, call dispatchPost, serialise the result. The wording of the responses
 * is load-bearing, though: the playbook tells the Mind how to read `note` and
 * `idempotent`, so keep them in step with playbooks/x-relay-v1.md.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth.ts';
import { requireRelayKey } from '../lib/auth.ts';
import { audit, countPostsRolling24h } from '../lib/db.ts';
import { badRequest } from '../lib/errors.ts';
import { dispatchPost, safeNonce } from '../lib/dispatch.ts';
import { parseSlots, nextSlotAfter } from '../lib/schedule.ts';
import { getFreshAccessToken, readTokens, refreshWithLock } from '../lib/tokens.ts';
import { deletePost } from '../lib/xclient.ts';
import { paywall } from '../lib/paywall.ts';

export const post = new Hono<AppEnv>();

post.use('/x/*', requireRelayKey);
post.use('/x/post', paywall());

interface PostBody {
  text?: string;
  idempotencyKey?: string;
  allowUrl?: boolean;
  dryRun?: boolean;
  replyToTweetId?: string;
  clientNonce?: string;
}

/** Free state check. Costs no X credits — the playbook is told to prefer it. */
post.get('/x/me', async (c) => {
  const user = c.get('user');
  const postsRolling24h = await countPostsRolling24h(c.env, user.user_id);
  const slots = parseSlots(user.slots_utc);
  const next = nextSlotAfter(user.user_id, slots, Math.floor(Date.now() / 1000));

  return c.json({
    ok: true,
    userId: user.user_id,
    status: user.status,
    xHandle: user.x_handle,

    // The schedule: a finite list of UTC slots. This is what bounds posts per day.
    slotsUtc: slots,
    nextSlotUtc: next ? new Date(next.atSec * 1000).toISOString() : null,
    holdSec: user.hold_sec,

    // A rolling-24h safety ceiling, NOT the schedule. Distinct on purpose — conflating
    // the two is what made the old daily-<date> idempotency key ambiguous.
    postsRolling24h,
    rate24hCap: user.daily_cap,

    // Legacy names, kept so the installed x-relay-v1 contract keeps parsing.
    postsToday: postsRolling24h,
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
  const body = (await c.req.json().catch(() => ({}))) as PostBody;
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text) throw badRequest('Field "text" is required.', 'text_empty');

  const nonce = safeNonce(body.clientNonce);
  const result = await dispatchPost(c.env, c.get('user'), c.get('via'), {
    text,
    idempotencyKey: body.idempotencyKey,
    allowUrl: body.allowUrl,
    dryRun: body.dryRun,
    replyToTweetId: body.replyToTweetId,
    nonce,
  });

  if (result.kind === 'dry_run') {
    return c.json({
      ok: true,
      dryRun: true,
      wouldPost: result.text,
      chars: result.chars,
      hasUrl: result.hasUrl,
      costEstimateUsd: result.costEstimateUsd,
      requireApproval: result.requireApproval,
      ...(nonce ? { clientNonce: nonce } : {}),
    });
  }

  if (result.kind === 'pending_approval') {
    return c.json(
      {
        ok: true,
        status: 'pending_approval',
        draftId: String(result.postId),
        approveUrl: result.approveUrl,
        chars: result.chars,
        costEstimateUsd: result.costUsd,
        ...(result.idempotent ? { idempotent: true } : {}),
        note: result.idempotent
          ? 'This draft is already awaiting human approval. It is NOT live.'
          : 'NOT posted. Report this draft and approveUrl to the human, then stop.',
      },
      202,
    );
  }

  if (result.idempotent) {
    return c.json({
      ok: true,
      idempotent: true,
      id: result.tweetId,
      url: result.url,
      costEstimateUsd: result.costUsd,
      note: 'This exact post already went out. Do not retry.',
    });
  }

  return c.json(
    {
      ok: true,
      id: result.tweetId,
      url: result.url,
      costEstimateUsd: result.costUsd,
      ...(nonce ? { clientNonce: nonce } : {}),
    },
    201,
  );
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
