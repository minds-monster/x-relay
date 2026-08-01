import { describe, expect, it } from 'vitest';
import {
  ScheduleError,
  normalizeSlots,
  nextSlotAfter,
  nthSlotAfter,
  parseSlots,
  slotAt,
  slotIdemKey,
  slotsInWindow,
  validateSlots,
} from '../worker/lib/schedule.ts';

/** Unix seconds for a UTC instant, spelled out so the tests read as wall-clock times. */
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('normalizeSlots', () => {
  it('sorts and de-duplicates', () => {
    expect(normalizeSlots(['18:00', '09:00', '13:00', '09:00'])).toEqual([
      '09:00',
      '13:00',
      '18:00',
    ]);
  });

  it('rejects anything that is not a 24-hour UTC HH:MM', () => {
    for (const bad of ['9:00', '24:00', '12:60', '0900', 'noon', '09:00:00', 12, null]) {
      expect(() => normalizeSlots([bad]), String(bad)).toThrow(ScheduleError);
    }
  });

  it('accepts the edges of the day', () => {
    expect(normalizeSlots(['00:00', '23:59'])).toEqual(['00:00', '23:59']);
  });
});

describe('parseSlots', () => {
  it('treats null, empty and [] as "nothing scheduled"', () => {
    expect(parseSlots(null)).toEqual([]);
    expect(parseSlots('')).toEqual([]);
    expect(parseSlots('[]')).toEqual([]);
  });

  it('throws rather than silently posting nothing when the column is corrupt', () => {
    expect(() => parseSlots('not json')).toThrow(ScheduleError);
    expect(() => parseSlots('{"a":1}')).toThrow(ScheduleError);
  });
});

describe('validateSlots', () => {
  // A schedule tighter than minIntervalSec produces a post guaranteed to fail its own
  // guardrail — one silently empty slot per day, every day.
  it('rejects a gap below minIntervalSec', () => {
    expect(() => validateSlots(['09:00', '09:05'], 600)).toThrow(ScheduleError);
  });

  it('accepts a gap at exactly minIntervalSec', () => {
    expect(() => validateSlots(['09:00', '09:10'], 600)).not.toThrow();
  });

  // 23:50 and 00:05 look far apart numerically and are fifteen minutes apart in fact.
  it('checks the wrap-around gap across midnight', () => {
    expect(() => validateSlots(['00:05', '23:50'], 3600)).toThrow(/23:50 and 00:05/);
  });

  it('says which pair is too close, and by how much', () => {
    expect(() => validateSlots(['09:00', '13:00', '13:05'], 600)).toThrow(/13:00 and 13:05.*5 min/s);
  });

  it('has nothing to check with fewer than two slots', () => {
    expect(() => validateSlots(['09:00'], 86_400)).not.toThrow();
    expect(() => validateSlots([], 86_400)).not.toThrow();
  });
});

describe('slotAt', () => {
  it('builds a minute-precise UTC id and the matching instant', () => {
    const s = slotAt('adam', '13:00', Date.parse('2026-08-01T04:17:33Z'));
    expect(s.id).toBe('adam:2026-08-01T13:00Z');
    expect(s.atSec).toBe(at('2026-08-01T13:00:00Z'));
  });

  // The bug this whole module exists to prevent: two posts in one day sharing a key.
  it('gives two slots on the same day different ids', () => {
    const day = Date.parse('2026-08-01T00:00:00Z');
    const a = slotAt('adam', '09:00', day);
    const b = slotAt('adam', '18:00', day);
    expect(a.id).not.toBe(b.id);
    expect(slotIdemKey(a)).toBe('slot:adam:2026-08-01T09:00Z');
    expect(slotIdemKey(b)).toBe('slot:adam:2026-08-01T18:00Z');
  });

  it('lands on the right date at the midnight boundary', () => {
    // One second before midnight UTC still belongs to 31 July.
    expect(slotAt('adam', '00:00', Date.parse('2026-07-31T23:59:59Z')).id).toBe(
      'adam:2026-07-31T00:00Z',
    );
    expect(slotAt('adam', '00:00', Date.parse('2026-08-01T00:00:00Z')).id).toBe(
      'adam:2026-08-01T00:00Z',
    );
  });

  // No DST arithmetic anywhere: the same wall-clock slot is the same offset year-round.
  it('is stable across what would be a DST transition in a local timezone', () => {
    const winter = slotAt('adam', '09:00', Date.parse('2026-01-15T00:00:00Z'));
    const summer = slotAt('adam', '09:00', Date.parse('2026-07-15T00:00:00Z'));
    expect(new Date(winter.atSec * 1000).toISOString()).toContain('T09:00:00');
    expect(new Date(summer.atSec * 1000).toISOString()).toContain('T09:00:00');
  });

  it('scopes the id to the user, so two accounts never share an idempotency key', () => {
    const day = Date.parse('2026-08-01T00:00:00Z');
    expect(slotAt('adam', '09:00', day).id).not.toBe(slotAt('beta', '09:00', day).id);
  });
});

describe('slotsInWindow', () => {
  const slots = ['09:00', '13:00', '18:00'];

  it('finds the slots inside a half-open window', () => {
    const found = slotsInWindow(
      'adam',
      slots,
      at('2026-08-01T08:00:00Z'),
      at('2026-08-01T14:00:00Z'),
    );
    expect(found.map((s) => s.hhmm)).toEqual(['09:00', '13:00']);
  });

  it('excludes the end and includes the start', () => {
    expect(
      slotsInWindow('adam', slots, at('2026-08-01T09:00:00Z'), at('2026-08-01T13:00:00Z')).map(
        (s) => s.hhmm,
      ),
    ).toEqual(['09:00']);
  });

  // A tick at 23:58 must be able to see tomorrow's early slot, or it is never bound.
  it('crosses midnight', () => {
    const found = slotsInWindow(
      'adam',
      ['00:30', '23:50'],
      at('2026-08-01T23:40:00Z'),
      at('2026-08-02T01:00:00Z'),
    );
    expect(found.map((s) => s.id)).toEqual([
      'adam:2026-08-01T23:50Z',
      'adam:2026-08-02T00:30Z',
    ]);
  });

  it('returns them in chronological order', () => {
    const found = slotsInWindow(
      'adam',
      ['18:00', '09:00', '13:00'],
      at('2026-08-01T00:00:00Z'),
      at('2026-08-02T00:00:00Z'),
    );
    expect(found.map((s) => s.atSec)).toEqual([...found.map((s) => s.atSec)].sort((a, b) => a - b));
  });

  it('finds nothing when nothing is scheduled', () => {
    expect(
      slotsInWindow('adam', [], at('2026-08-01T00:00:00Z'), at('2026-08-02T00:00:00Z')),
    ).toEqual([]);
  });
});

describe('nextSlotAfter', () => {
  const slots = ['09:00', '13:00', '18:00'];

  it('picks the next one later today', () => {
    expect(nextSlotAfter('adam', slots, at('2026-08-01T10:00:00Z'))?.hhmm).toBe('13:00');
  });

  it('rolls to tomorrow once the day is spent', () => {
    const next = nextSlotAfter('adam', slots, at('2026-08-01T19:00:00Z'));
    expect(next?.id).toBe('adam:2026-08-02T09:00Z');
  });

  it('is strictly after — a slot happening right now is not "next"', () => {
    expect(nextSlotAfter('adam', slots, at('2026-08-01T13:00:00Z'))?.hhmm).toBe('18:00');
  });

  it('returns null with no schedule', () => {
    expect(nextSlotAfter('adam', [], at('2026-08-01T10:00:00Z'))).toBeNull();
  });
});

describe('nthSlotAfter', () => {
  const slots = ['09:00', '13:00', '18:00'];

  it('walks forward one slot per queued draft ahead', () => {
    const t = at('2026-08-01T10:00:00Z');
    expect(nthSlotAfter('adam', slots, t, 0)?.id).toBe('adam:2026-08-01T13:00Z');
    expect(nthSlotAfter('adam', slots, t, 1)?.id).toBe('adam:2026-08-01T18:00Z');
    expect(nthSlotAfter('adam', slots, t, 2)?.id).toBe('adam:2026-08-02T09:00Z');
  });

  it('keeps walking across several days for a long backlog', () => {
    expect(nthSlotAfter('adam', slots, at('2026-08-01T10:00:00Z'), 5)?.id).toBe(
      'adam:2026-08-03T09:00Z',
    );
  });
});
