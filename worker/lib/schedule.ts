/**
 * Slot arithmetic. Pure — no database, no clock of its own, no I/O.
 *
 * Everything here takes an explicit `atMs`, which is what makes the whole scheduler
 * testable without a D1 harness or a fake timer, mirroring the split already used in
 * guardrails.ts (pure `validateText` / DB-bound `checkQuotas`).
 *
 * WHY UTC, EVERYWHERE
 *
 * The old design had two different definitions of "day": the cap was a rolling 24-hour
 * window while the idempotency key was the UTC calendar date. At one post per day that is
 * invisible; the moment a second slot exists it is a live bug, because "have we already
 * posted today" has two answers.
 *
 * A slot id is therefore derived from UTC alone and is minute-precise:
 *
 *     adam:2026-08-01T13:00Z
 *
 * That string is the post's idempotency key. It is unique per slot per day, so N posts a
 * day are natural, no calendar question is ever asked, and there is no DST arithmetic to
 * get wrong. The two remaining counters are given separate names and separate jobs:
 *
 *   - `slots_utc`  the schedule. A finite list, so it bounds posts per UTC day.
 *   - `daily_cap`  a rolling-24h safety ceiling. NOT the schedule. See
 *                  countPostsRolling24h in db.ts.
 */

/** A slot bound to a specific day. */
export interface Slot {
  /** 'adam:2026-08-01T13:00Z' — also the post's idempotency key, via slotIdemKey(). */
  id: string;
  /** 'HH:MM' as configured. */
  hhmm: string;
  /** Unix seconds at which the post should go out. */
  atSec: number;
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ScheduleError extends Error {}

/** Parse and normalise the stored JSON array. Returns [] for null/empty/garbage-free. */
export function parseSlots(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScheduleError(`slots_utc is not valid JSON: ${raw.slice(0, 80)}`);
  }
  if (!Array.isArray(parsed)) throw new ScheduleError('slots_utc must be a JSON array.');
  return normalizeSlots(parsed);
}

/**
 * Validate, de-duplicate and sort. Sorting matters: gap checking and "next slot" both
 * assume ascending order, and a caller supplying ["18:00","09:00"] is not an error.
 */
export function normalizeSlots(slots: unknown[]): string[] {
  const out: string[] = [];
  for (const s of slots) {
    if (typeof s !== 'string' || !HHMM_RE.test(s.trim())) {
      throw new ScheduleError(
        `Invalid slot ${JSON.stringify(s)}. Slots are UTC "HH:MM", 24-hour, e.g. "09:00".`,
      );
    }
    const t = s.trim();
    if (!out.includes(t)) out.push(t);
  }
  return out.sort();
}

/** Minutes past UTC midnight. */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Reject a schedule the dispatcher could not honour.
 *
 * Two slots closer together than `min_interval_sec` would enqueue a post that is
 * guaranteed to fail its own `min_interval_not_elapsed` guardrail — a silently empty slot
 * every day. Better to refuse the configuration than to debug it later. The wrap-around
 * gap (last slot of one day to first of the next) is checked too, since 23:50 + 00:05 is
 * a 15-minute gap even though the numbers look far apart.
 */
export function validateSlots(slots: string[], minIntervalSec: number): void {
  if (slots.length < 2) return;

  const gaps: Array<[number, string, string]> = [];
  // Pair each slot with the next, wrapping the last around to the first of the next day.
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i]!;
    const b = slots[(i + 1) % slots.length]!;
    const raw = minutesOf(b) - minutesOf(a);
    gaps.push([raw > 0 ? raw : raw + 1440, a, b]);
  }

  for (const [gapMin, a, b] of gaps) {
    if (gapMin * 60 < minIntervalSec) {
      throw new ScheduleError(
        `Slots ${a} and ${b} are ${gapMin} minutes apart, but minIntervalSec is ` +
          `${minIntervalSec} (${Math.ceil(minIntervalSec / 60)} minutes). Every post in the ` +
          `tighter slot would be refused. Widen the gap or lower minIntervalSec.`,
      );
    }
  }
}

/** 'YYYY-MM-DD' in UTC. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Build the slot for a given UTC day. `dayMs` may be any instant within that day. */
export function slotAt(userId: string, hhmm: string, dayMs: number): Slot {
  const day = utcDate(dayMs);
  const atSec = Math.floor(Date.parse(`${day}T${hhmm}:00Z`) / 1000);
  return { id: `${userId}:${day}T${hhmm}Z`, hhmm, atSec };
}

/** The post idempotency key for a slot. One string, defined in one place. */
export function slotIdemKey(slot: Slot | string): string {
  return 'slot:' + (typeof slot === 'string' ? slot : slot.id);
}

const DAY_MS = 86_400_000;

/**
 * Every slot occurrence with `fromSec <= atSec < toSec`, across day boundaries.
 *
 * The cron looks a fixed distance ahead and behind, so a tick at 23:58 must be able to see
 * tomorrow's 00:05 slot and yesterday's 23:50 one. Yesterday and tomorrow are both scanned
 * rather than only today.
 */
export function slotsInWindow(
  userId: string,
  slots: string[],
  fromSec: number,
  toSec: number,
): Slot[] {
  const found: Slot[] = [];
  const anchor = fromSec * 1000;
  for (const dayOffset of [-DAY_MS, 0, DAY_MS]) {
    for (const hhmm of slots) {
      const slot = slotAt(userId, hhmm, anchor + dayOffset);
      if (slot.atSec >= fromSec && slot.atSec < toSec) found.push(slot);
    }
  }
  return found.sort((a, b) => a.atSec - b.atSec);
}

/**
 * The next slot strictly after `atSec`. Used for the `estimatedSlot` a content Mind gets
 * back on submit, so it can tell the human when its draft is expected to go out.
 */
export function nextSlotAfter(userId: string, slots: string[], atSec: number): Slot | null {
  if (slots.length === 0) return null;
  const anchor = atSec * 1000;
  for (const dayOffset of [0, DAY_MS]) {
    const candidates = slots
      .map((hhmm) => slotAt(userId, hhmm, anchor + dayOffset))
      .filter((s) => s.atSec > atSec)
      .sort((a, b) => a.atSec - b.atSec);
    const first = candidates[0];
    if (first) return first;
  }
  return null;
}

/**
 * The nth upcoming slot, 0-indexed. A draft sitting third in the queue is told which slot
 * it is likely to land in, which is the only genuinely useful thing to report about queue
 * position.
 */
export function nthSlotAfter(
  userId: string,
  slots: string[],
  atSec: number,
  n: number,
): Slot | null {
  if (slots.length === 0) return null;
  let cursor = atSec;
  let slot: Slot | null = null;
  for (let i = 0; i <= n; i++) {
    slot = nextSlotAfter(userId, slots, cursor);
    if (!slot) return null;
    cursor = slot.atSec;
  }
  return slot;
}
