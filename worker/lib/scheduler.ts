/**
 * The cron body: what turns a queue of drafts into posts that go out on time, with nobody
 * watching.
 *
 * TWO PHASES PER TICK, IN THIS ORDER — bind-and-hold, then dispatch.
 *
 *   Phase A  A slot is approaching. Pick the best waiting draft, bind it to that slot, and
 *            announce it with a veto link. Nothing is sent.
 *   Phase B  A held draft's slot has arrived. Send it through the normal post path.
 *
 * The order is not arbitrary and must not be swapped. Binding first means a draft is
 * always announced at least one tick before it can be dispatched, so the hold window is
 * never zero even for a draft submitted moments before its slot. Dispatching first would
 * let a draft bound and sent within the same tick reach X before the alert reached a
 * phone, which quietly removes the only human check in an otherwise unattended system.
 *
 * Ticks are every 5 minutes and are assumed to be unreliable: Cloudflare may skip one,
 * run one late, or overlap two. So every operation is idempotent —
 *
 *   - binding is guarded by a unique index on (user_id, slot_id);
 *   - dispatch uses `slot:<slotId>` as the post idempotency key, so two ticks landing in
 *     the same slot produce one tweet;
 *   - a missed slot is simply skipped rather than posted late, because a 09:00 post
 *     arriving at 14:00 is usually worse than no post.
 */
import { dispatchPost } from './dispatch.ts';
import { RelayError } from './errors.ts';
import { notify } from './notify.ts';
import {
  bindToSlot,
  dueForDispatch,
  expireStale,
  setStatus,
  slotIsBound,
  vetoUrl,
} from './queue.ts';
import { parseSlots, ScheduleError, slotIdemKey, slotsInWindow } from './schedule.ts';
import type { Env, UserRow } from '../types.ts';

/**
 * How late a slot may be dispatched before it is abandoned.
 *
 * Generous enough to absorb a skipped tick or a slow X call, short enough that a post
 * still lands when it was meant to be read. A slot missed by more than this is dropped
 * and reported, not silently posted hours out of context.
 */
const DISPATCH_GRACE_SEC = 30 * 60;

/** The configured cron interval. Keep in step with `triggers.crons` in wrangler.jsonc. */
const CRON_INTERVAL_SEC = 5 * 60;

/**
 * Never look less than this far ahead when binding, whatever `hold_sec` says.
 *
 * One cron interval plus a margin. A shorter lookahead than the tick gap means slots that
 * no tick ever sees, and a slot that is never bound is never dispatched and never
 * reported — a post that silently does not happen.
 */
const MIN_BIND_LOOKAHEAD_SEC = CRON_INTERVAL_SEC + 60;

/**
 * A draft must have been held for at least this long before it may be dispatched.
 *
 * Without it, a slot falling on a tick boundary would be bound and published within the
 * same tick: the alert and the tweet leave together, and the veto window — the only human
 * check in an unattended system — is zero. The floor guarantees the announcement lands at
 * least one tick before the post. A slot caught this way goes out one tick late, well
 * inside DISPATCH_GRACE_SEC.
 */
const MIN_NOTICE_SEC = 60;

export interface SchedulerResult {
  expired: number;
  bound: number;
  posted: number;
  failed: number;
  skipped: number;
}

export async function runScheduler(env: Env, atSec: number): Promise<SchedulerResult> {
  const result: SchedulerResult = { expired: 0, bound: 0, posted: 0, failed: 0, skipped: 0 };

  const { results: users } = await env.DB.prepare(
    `SELECT * FROM users
      WHERE status = 'active' AND slots_utc IS NOT NULL AND slots_utc != '' AND slots_utc != '[]'
      LIMIT 50`,
  ).all<UserRow>();

  for (const user of users ?? []) {
    try {
      await bindAndHold(env, user, atSec, result);
    } catch (err) {
      console.error(`[scheduler] bind failed for ${user.user_id}:`, err);
    }
  }

  await dispatchDue(env, atSec, result);
  return result;
}

// ---------------------------------------------------------------------------
// Phase A — bind and hold
// ---------------------------------------------------------------------------

async function bindAndHold(
  env: Env,
  user: UserRow,
  atSec: number,
  result: SchedulerResult,
): Promise<void> {
  let slots: string[];
  try {
    slots = parseSlots(user.slots_utc);
  } catch (err) {
    // A malformed schedule would otherwise silently stop this account posting forever.
    if (err instanceof ScheduleError) {
      await notify(env, `X relay: ${user.user_id} has an invalid posting schedule — ${err.message}`);
      return;
    }
    throw err;
  }
  if (slots.length === 0) return;

  result.expired += await expireStale(env, user.user_id);

  // Slots to bind on this tick: those firing within the lookahead.
  //
  // The lookahead is `hold_sec`, but never less than one cron interval plus a margin.
  // That floor is not cosmetic. Binding only happens on a tick, so a lookahead shorter
  // than the gap between ticks leaves gaps no tick ever observes: with hold_sec=60 and
  // 5-minute ticks, roughly four slots in five would never be bound, never dispatched,
  // and never reported — the post would simply not happen. Widening the lookahead binds
  // earlier than requested, which only ever means MORE warning before publication, so
  // erring long is the safe direction.
  const lookahead = Math.max(user.hold_sec, MIN_BIND_LOOKAHEAD_SEC);

  for (const slot of slotsInWindow(user.user_id, slots, atSec, atSec + lookahead)) {
    if (await slotIsBound(env, user.user_id, slot.id)) continue;

    const bound = await bindToSlot(env, user.user_id, slot.id, slot.atSec);
    if (!bound) continue; // empty queue, or another tick got there first

    result.bound++;

    const when = new Date(slot.atSec * 1000).toISOString();
    const minutes = Math.max(1, Math.round((slot.atSec - atSec) / 60));
    await notify(
      env,
      `X relay — posting in ${minutes} min (${when})\n` +
        (bound.source ? `from: ${bound.source}\n` : '') +
        `\n${bound.text}\n\n` +
        `Stop it: ${await vetoUrl(env, bound.id)}\n` +
        `Do nothing and it goes out.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase B — dispatch
// ---------------------------------------------------------------------------

async function dispatchDue(env: Env, atSec: number, result: SchedulerResult): Promise<void> {
  for (const item of await dueForDispatch(env, atSec, MIN_NOTICE_SEC)) {
    const slotSec = item.hold_until ?? atSec;

    // Too late to be worth sending. Report it — a slot that silently does nothing is the
    // failure mode that erodes trust in a scheduler fastest.
    if (atSec - slotSec > DISPATCH_GRACE_SEC) {
      await setStatus(env, item.id, 'expired', { errorCode: 'missed_slot' });
      result.skipped++;
      await notify(
        env,
        `X relay: missed the ${new Date(slotSec * 1000).toISOString()} slot by ` +
          `${Math.round((atSec - slotSec) / 60)} minutes. Draft was dropped, not posted late.\n\n${item.text}`,
      );
      continue;
    }

    const user = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?1')
      .bind(item.user_id)
      .first<UserRow>();
    if (!user) {
      await setStatus(env, item.id, 'failed', { errorCode: 'user_missing' });
      result.failed++;
      continue;
    }

    try {
      const outcome = await dispatchPost(env, user, 'cron', {
        text: item.text,
        // The slot IS the idempotency key. Minute-precise UTC, unique per slot per day —
        // so N posts a day are natural and no calendar question is ever asked.
        idempotencyKey: slotIdemKey(item.slot_id ?? `${item.user_id}:${slotSec}`),
        allowUrl: Boolean(item.allow_url),
        nonce: `q${item.id}`,
      });

      if (outcome.kind === 'posted') {
        await setStatus(env, item.id, 'posted', { postId: outcome.postId });
        result.posted++;
      } else if (outcome.kind === 'pending_approval') {
        // require_approval is still on for this account. The hold window was meant to
        // replace the click, so this is a configuration mismatch rather than a normal
        // path — leave the row held, point at the approval page, and say so plainly.
        await env.DB.prepare(`UPDATE queue SET post_id = ?1, updated_at = ?2 WHERE id = ?3`)
          .bind(outcome.postId, atSec, item.id)
          .run();
        await notify(
          env,
          `X relay: slot reached but requireApproval is still on, so nothing was posted.\n` +
            `Approve: ${outcome.approveUrl}\n` +
            `To let the hold window handle this instead: relay.sh set '{"requireApproval":false}'`,
        );
      }
    } catch (err) {
      const code = err instanceof RelayError ? err.code : 'x_upstream_error';
      const msg = err instanceof Error ? err.message : String(err);
      await setStatus(env, item.id, 'failed', { errorCode: code });
      result.failed++;

      // Deliberately no cascade to the next queued draft. Substituting different content
      // into a slot a human already reviewed would defeat the veto window, and a failing
      // account would burn the whole queue one draft per tick.
      await notify(
        env,
        `X relay: dispatch failed for the ${new Date(slotSec * 1000).toISOString()} slot ` +
          `(${code}). The slot is empty; nothing was posted.\n\n${msg}`,
      );
    }
  }
}
