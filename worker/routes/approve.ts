/**
 * Human-in-the-loop approval.
 *
 * The Mind never posts directly when require_approval is set: it gets a 202 with a
 * signed link, and clicking Approve here is what calls X. The link is HMAC-signed over
 * the draft id, so it needs no session and no login, and it cannot be guessed.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth.ts';
import { hmacHex, timingSafeEqual } from '../lib/crypto.ts';
import { audit, getPostById, getUser, now } from '../lib/db.ts';
import { RelayError, notFound } from '../lib/errors.ts';
import { costFor, countCodepoints } from '../lib/guardrails.ts';
import { markDone, markFailed, tweetUrl } from '../lib/idempotency.ts';
import { addSpend } from '../lib/db.ts';
import { getFreshAccessToken } from '../lib/tokens.ts';
import { createPost } from '../lib/xclient.ts';
import { escapeHtml, page as shell } from '../lib/html.ts';
import { setStatus } from '../lib/queue.ts';

export const approve = new Hono<AppEnv>();

/**
 * Keep the queue row in step when a draft it created is approved or rejected here.
 *
 * Without this a queued draft that went down the approval path would sit at `held`
 * forever, occupying its slot and never being reported as resolved. Best-effort: the
 * post itself is the outcome that matters.
 */
async function syncQueueRow(
  env: AppEnv['Bindings'],
  postId: number,
  status: 'posted' | 'vetoed' | 'failed',
  errorCode?: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT id FROM queue WHERE post_id = ?1 AND status = 'held' LIMIT 1`,
  )
    .bind(postId)
    .first<{ id: number }>();
  if (row) await setStatus(env, row.id, status, { errorCode: errorCode ?? null });
}

async function verifyOrThrow(c: { env: AppEnv['Bindings'] }, postId: string, token: string | undefined) {
  const id = Number(postId);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Invalid draft id.');
  const expected = await hmacHex(c.env.APPROVAL_HMAC_KEY, `draft:${id}`);
  if (!token || !timingSafeEqual(token, expected)) {
    throw new RelayError('relay_forbidden', 403, 'Invalid or missing approval signature.');
  }
  const row = await getPostById(c.env, id);
  if (!row) throw notFound('No such draft.');
  return row;
}

approve.get('/approve/:id', async (c) => {
  const row = await verifyOrThrow(c, c.req.param('id'), c.req.query('t'));
  const sig = c.req.query('t')!;

  if (row.status === 'done' && row.x_tweet_id) {
    const user = await getUser(c.env, row.user_id);
    return shell(
      'Already posted',
      `<h1 class="ok">Already posted</h1>
       <p><a href="${escapeHtml(tweetUrl(user?.x_handle ?? null, row.x_tweet_id))}">View on X</a></p>`,
    );
  }
  if (row.status === 'rejected') {
    return shell('Rejected', '<h1>Draft rejected</h1><p>Nothing was posted.</p>');
  }
  if (row.status !== 'pending_approval') {
    return shell('Not pending', `<h1 class="bad">This draft is not awaiting approval</h1><p>Status: <code>${escapeHtml(row.status)}</code></p>`, 409);
  }

  const cost = costFor(Boolean(row.has_url));
  return shell(
    'Approve post',
    `<h1>Approve this post?</h1>
     <div class="draft">${escapeHtml(row.text)}</div>
     <div class="meta">
       ${countCodepoints(row.text)} characters &middot;
       ${row.has_url ? 'contains a link &middot; ' : ''}
       estimated cost $${cost.toFixed(3)} &middot;
       drafted ${new Date(row.created_at * 1000).toISOString()}
     </div>
     <form method="POST" action="/approve/${row.id}?t=${escapeHtml(sig)}">
       <button class="go" name="action" value="approve" type="submit">Approve &amp; post</button>
       <button class="no" name="action" value="reject" type="submit">Reject</button>
     </form>`,
  );
});

approve.post('/approve/:id', async (c) => {
  const row = await verifyOrThrow(c, c.req.param('id'), c.req.query('t'));

  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const action = String(form.action ?? 'approve');

  if (row.status !== 'pending_approval') {
    return shell('Not pending', `<h1 class="bad">This draft is no longer awaiting approval</h1><p>Status: <code>${escapeHtml(row.status)}</code></p>`, 409);
  }

  if (action === 'reject') {
    await c.env.DB.prepare(
      `UPDATE posts SET status = 'rejected', completed_at = ?1 WHERE id = ?2`,
    )
      .bind(now(), row.id)
      .run();
    await syncQueueRow(c.env, row.id, 'vetoed');
    await audit(c.env, { userId: row.user_id, route: 'approve', via: 'approval', code: 'rejected', httpStatus: 200 });
    return shell('Rejected', '<h1>Rejected</h1><p>Nothing was posted.</p>');
  }

  const user = await getUser(c.env, row.user_id);
  if (!user) throw notFound('User vanished.');

  const cost = costFor(Boolean(row.has_url));

  try {
    const { accessToken } = await getFreshAccessToken(c.env, user);
    const result = await createPost({ accessToken, text: row.text });
    await markDone(c.env, row.id, result.tweetId, result.raw, cost);
    await addSpend(c.env, user.user_id, cost);
    await syncQueueRow(c.env, row.id, 'posted');
    await audit(c.env, {
      userId: user.user_id,
      route: 'approve',
      via: 'approval',
      code: 'posted',
      httpStatus: 201,
      detail: result.tweetId,
    });
    const url = tweetUrl(user.x_handle, result.tweetId);
    return shell(
      'Posted',
      `<h1 class="ok">Posted</h1><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
    );
  } catch (err) {
    const code = err instanceof RelayError ? err.code : 'x_upstream_error';
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(c.env, row.id, code, msg);
    await syncQueueRow(c.env, row.id, 'failed', code);
    await audit(c.env, {
      userId: user.user_id,
      route: 'approve',
      via: 'approval',
      code,
      httpStatus: err instanceof RelayError ? err.httpStatus : 502,
      detail: msg,
    });
    return shell(
      'Failed',
      `<h1 class="bad">X rejected the post</h1><p><code>${escapeHtml(code)}</code></p><p>${escapeHtml(msg)}</p>`,
      502,
    );
  }
});
