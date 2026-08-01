/**
 * The content-Mind facing API, plus the human veto page.
 *
 * A content Mind's entire contract is: POST a draft, get told which slot it will land in,
 * stop. It never chooses a moment, never retries into a rate limit, never sees /x/post.
 * Everything about cadence is the relay's business.
 *
 * Guardrails run TWICE by design: cheap ones here at submit time, so a Mind is told
 * "that's 340 characters" while it still has the context to fix it rather than discovering
 * it from a log six hours later; and the full set again at dispatch, because the world
 * moves between submit and slot — the budget can be spent, the same text can arrive from
 * another Mind, the account can need re-auth.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { audit, findRecentDuplicate } from '../lib/db.ts';
import { safeNonce } from '../lib/dispatch.ts';
import { RelayError, badRequest, notFound } from '../lib/errors.ts';
import { containsUrl, costFor, countCodepoints, normalizeText, validateText } from '../lib/guardrails.ts';
import { escapeHtml, page } from '../lib/html.ts';
import {
  getBySubmissionId,
  getQueueItem,
  insertQueued,
  listPending,
  setStatus,
  vetoIfHeld,
  vetoSignature,
} from '../lib/queue.ts';
import { nextSlotAfter, nthSlotAfter, parseSlots } from '../lib/schedule.ts';
import { timingSafeEqual } from '../lib/crypto.ts';

export const queue = new Hono<AppEnv>();

/** Beyond this, a "queue" is a backlog nobody is reading. Push back instead of hoarding. */
const MAX_PENDING = 25;

interface SubmitBody {
  text?: string;
  submissionId?: string;
  source?: string;
  allowUrl?: boolean;
  priority?: number;
  ttlSec?: number;
  clientNonce?: string;
}

function isoOrNull(sec: number | null | undefined): string | null {
  return sec ? new Date(sec * 1000).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

queue.post('/x/queue', async (c) => {
  const user = c.get('user');
  const via = c.get('via');
  const body = (await c.req.json().catch(() => ({}))) as SubmitBody;

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text) throw badRequest('Field "text" is required.', 'text_empty');

  const submissionId = body.submissionId?.trim();
  if (!submissionId) {
    throw badRequest(
      'Field "submissionId" is required. Use a stable id for this draft (e.g. "news-2026-08-01-a") ' +
        'and reuse it verbatim on any retry — that is what makes retrying safe.',
      'submission_id_required',
    );
  }
  if (submissionId.length > 128) throw badRequest('submissionId must be 128 characters or fewer.');

  const nonce = safeNonce(body.clientNonce);
  const source = body.source?.trim().slice(0, 64) || null;
  const allowUrl = body.allowUrl === true;
  const hasUrl = containsUrl(text);

  // Pure checks first — length and the URL cost cliff. Same function the post path uses,
  // so a draft that passes here cannot fail these at dispatch.
  validateText(text, hasUrl, allowUrl);

  const slots = parseSlots(user.slots_utc);
  if (slots.length === 0) {
    throw new RelayError(
      'no_schedule_configured',
      409,
      'This account has no posting slots configured, so a queued draft would never go out. ' +
        'The operator must set slotsUtc first.',
      false,
    );
  }

  // Retry of an existing submission: report the same answer, enqueue nothing.
  const existing = await getBySubmissionId(c.env, user.user_id, submissionId);
  if (existing) {
    await audit(c.env, {
      userId: user.user_id,
      route: 'x/queue',
      via,
      code: 'submission_replay',
      httpStatus: 200,
      detail: nonce ? `id=${existing.id} nonce=${nonce}` : `id=${existing.id}`,
    });
    return c.json({
      ok: true,
      idempotent: true,
      queueId: existing.id,
      status: existing.status,
      slotUtc: isoOrNull(existing.hold_until),
      note: 'This submissionId was already accepted. Do not resubmit and do not rewrite it.',
    });
  }

  const textSha256 = await sha256Hex(normalizeText(text));

  // Thematic repetition is a content problem, but byte-identical repetition is a ToS
  // problem — X's automation rules prohibit duplicate content. Catch it now rather than
  // paying for a 403 at the slot.
  const dup = await findRecentDuplicate(c.env, user.user_id, textSha256);
  if (dup) {
    throw new RelayError(
      'duplicate_recent_text',
      409,
      `This text was already posted within the last 7 days (post ${dup.id}). Rewrite it ` +
        'materially and submit with a new submissionId.',
    );
  }

  const pending = await listPending(c.env, user.user_id, MAX_PENDING + 1);
  if (pending.length >= MAX_PENDING) {
    throw new RelayError(
      'queue_full',
      429,
      `The queue already holds ${pending.length} drafts, which is more than the schedule ` +
        'will drain before they expire. Wait for it to clear.',
      true,
    );
  }
  // A duplicate of something already waiting is the same ToS problem, one slot earlier.
  if (pending.some((p) => p.text_sha256 === textSha256)) {
    throw new RelayError(
      'duplicate_recent_text',
      409,
      'An identical draft is already waiting in the queue. Rewrite it materially or leave it be.',
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(body.ttlSec) && body.ttlSec! > 0 ? body.ttlSec! : user.queue_ttl_sec;
  const priority = Number.isFinite(body.priority) ? Math.trunc(body.priority!) : 0;

  const queueId = await insertQueued(c.env, {
    userId: user.user_id,
    submissionId,
    source,
    text,
    textSha256,
    hasUrl,
    allowUrl,
    priority,
    expiresAt: nowSec + ttl,
  });

  // Position is only meaningful as a slot. Higher-priority drafts already ahead of this
  // one push it back, so count those rather than reporting a raw queue length.
  const ahead = pending.filter(
    (p) => p.priority > priority || (p.priority === priority && p.created_at <= nowSec),
  ).length;
  const estimated = nthSlotAfter(user.user_id, slots, nowSec, ahead);

  await audit(c.env, {
    userId: user.user_id,
    route: 'x/queue',
    via,
    code: 'queued',
    httpStatus: 201,
    detail: nonce ? `id=${queueId} nonce=${nonce}` : `id=${queueId}`,
  });

  return c.json(
    {
      ok: true,
      queueId,
      status: 'queued',
      position: ahead + 1,
      estimatedSlotUtc: estimated ? new Date(estimated.atSec * 1000).toISOString() : null,
      chars: countCodepoints(text),
      costEstimateUsd: costFor(hasUrl),
      expiresAtUtc: new Date((nowSec + ttl) * 1000).toISOString(),
      ...(nonce ? { clientNonce: nonce } : {}),
      note: 'Accepted. The relay will post this at its slot. Do not submit it again.',
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// Inspect and withdraw
// ---------------------------------------------------------------------------

/** Free — no X credits. */
queue.get('/x/queue', async (c) => {
  const user = c.get('user');
  const nowSec = Math.floor(Date.now() / 1000);
  const slots = parseSlots(user.slots_utc);
  const pending = await listPending(c.env, user.user_id);

  return c.json({
    ok: true,
    userId: user.user_id,
    slotsUtc: slots,
    nextSlotUtc: isoOrNull(nextSlotAfter(user.user_id, slots, nowSec)?.atSec),
    pending: pending.map((p, i) => ({
      queueId: p.id,
      submissionId: p.submission_id,
      source: p.source,
      status: p.status,
      priority: p.priority,
      chars: countCodepoints(p.text),
      text: p.text,
      slotUtc:
        isoOrNull(p.hold_until) ??
        isoOrNull(nthSlotAfter(user.user_id, slots, nowSec, i)?.atSec),
      expiresAtUtc: isoOrNull(p.expires_at),
    })),
  });
});

queue.delete('/x/queue/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const row = await getQueueItem(c.env, id);
  if (!row || row.user_id !== user.user_id) throw notFound('No such queue item.');

  if (row.status !== 'queued' && row.status !== 'held') {
    throw new RelayError(
      'relay_bad_request',
      409,
      `That draft is "${row.status}" and can no longer be withdrawn.`,
      false,
    );
  }

  await setStatus(c.env, id, 'withdrawn');
  await audit(c.env, {
    userId: user.user_id,
    route: 'x/queue/delete',
    via: c.get('via'),
    code: 'withdrawn',
    httpStatus: 200,
    detail: `id=${id}`,
  });
  return c.json({ ok: true, queueId: id, status: 'withdrawn' });
});

// ---------------------------------------------------------------------------
// Veto page — human-facing, unauthenticated but HMAC-signed
// ---------------------------------------------------------------------------
//
// Reached from a Slack alert, usually on a phone, in the window between a draft being
// bound to a slot and that slot firing. Signed over the queue id with the same key and
// the same scheme as the approval link, so it needs no session and cannot be guessed.
//
// Note the inversion versus /approve: there, silence means nothing is published. Here,
// silence means it publishes. That is the point of the hold window — it makes the relay
// unattended without making it unaccountable — but it does mean the page must be blunt
// about what happens if you close the tab.

async function verifyVetoOrThrow(env: AppEnv['Bindings'], rawId: string, token: string | undefined) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Invalid draft id.');
  const expected = await vetoSignature(env, id);
  if (!token || !timingSafeEqual(token, expected)) {
    throw new RelayError('relay_forbidden', 403, 'Invalid or missing veto signature.');
  }
  const row = await getQueueItem(env, id);
  if (!row) throw notFound('No such draft.');
  return row;
}

function statusExplanation(status: string): string {
  switch (status) {
    case 'posted':
      return 'It has already gone out. Use <code>relay.sh delete &lt;tweetId&gt;</code> to retract it from X.';
    case 'vetoed':
      return 'It was already vetoed. Nothing was posted.';
    case 'withdrawn':
      return 'The Mind that submitted it withdrew it. Nothing was posted.';
    case 'expired':
      return 'It expired before reaching a slot. Nothing was posted.';
    case 'failed':
      return 'Dispatch failed. Nothing is live. Check the audit log.';
    case 'queued':
      return 'It is still waiting and has not been assigned a slot yet, so there is nothing to stop. It will be announced again when it is.';
    default:
      return '';
  }
}

queue.get('/queue/:id/veto', async (c) => {
  const row = await verifyVetoOrThrow(c.env, c.req.param('id'), c.req.query('t'));
  const sig = c.req.query('t')!;

  if (row.status !== 'held') {
    return page(
      'Nothing to stop',
      `<h1>Nothing to stop</h1>
       <div class="draft">${escapeHtml(row.text)}</div>
       <p>Status: <code>${escapeHtml(row.status)}</code>. ${statusExplanation(row.status)}</p>`,
      409,
    );
  }

  const slot = row.hold_until ? new Date(row.hold_until * 1000).toISOString() : 'its slot';
  return page(
    'Stop this post?',
    `<h1>This posts automatically at ${escapeHtml(slot)}</h1>
     <div class="draft">${escapeHtml(row.text)}</div>
     <div class="meta">
       ${countCodepoints(row.text)} characters &middot;
       ${row.has_url ? 'contains a link &middot; ' : ''}
       estimated cost $${costFor(Boolean(row.has_url)).toFixed(3)}
       ${row.source ? `&middot; from ${escapeHtml(row.source)}` : ''}
     </div>
     <p><strong>You do not need to do anything for this to go out.</strong> Press Stop only
        if it should not.</p>
     <form method="POST" action="/queue/${row.id}/veto?t=${escapeHtml(sig)}">
       <button class="no" type="submit">Stop this post</button>
     </form>`,
  );
});

queue.post('/queue/:id/veto', async (c) => {
  const row = await verifyVetoOrThrow(c.env, c.req.param('id'), c.req.query('t'));
  const stopped = await vetoIfHeld(c.env, row.id);

  if (!stopped) {
    const fresh = await getQueueItem(c.env, row.id);
    return page(
      'Too late',
      `<h1 class="bad">Could not stop it</h1>
       <p>Status: <code>${escapeHtml(fresh?.status ?? 'unknown')}</code>.
          ${statusExplanation(fresh?.status ?? '')}</p>`,
      409,
    );
  }

  await audit(c.env, {
    userId: row.user_id,
    route: 'queue/veto',
    via: 'approval',
    code: 'vetoed',
    httpStatus: 200,
    detail: `id=${row.id}`,
  });

  return page(
    'Stopped',
    `<h1 class="ok">Stopped</h1>
     <p>Nothing was posted. The slot will stay empty — the next draft waits for the next slot
        rather than being pulled forward, so a veto never turns into a surprise substitution.</p>
     <div class="draft">${escapeHtml(row.text)}</div>`,
  );
});
