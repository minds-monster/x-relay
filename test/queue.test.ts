import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeTestDb, seedUser, type TestDb } from './helpers/d1.ts';
import {
  bindToSlot,
  dueForDispatch,
  expireStale,
  getQueueItem,
  insertQueued,
  listPending,
  setStatus,
  slotIsBound,
  vetoIfHeld,
  vetoSignature,
} from '../worker/lib/queue.ts';
import { timingSafeEqual } from '../worker/lib/crypto.ts';
import { claimIdempotency } from '../worker/lib/idempotency.ts';
import { slotAt, slotIdemKey } from '../worker/lib/schedule.ts';

const NOW = () => Math.floor(Date.now() / 1000);

let db: TestDb;

beforeEach(() => {
  db = makeTestDb();
  seedUser(db);
});
afterEach(() => db.close());

/** Enqueue a draft. Distinct text by default so dedupe never interferes. */
async function enqueue(
  opts: Partial<{
    submissionId: string;
    text: string;
    priority: number;
    expiresAt: number;
    source: string;
  }> = {},
) {
  return insertQueued(db.env, {
    userId: 'adam',
    submissionId: opts.submissionId ?? `s-${Math.random().toString(36).slice(2)}`,
    source: opts.source ?? 'test-mind',
    text: opts.text ?? `draft ${Math.random()}`,
    textSha256: `sha-${Math.random()}`,
    hasUrl: false,
    allowUrl: false,
    priority: opts.priority ?? 0,
    expiresAt: opts.expiresAt ?? NOW() + 86_400,
  });
}

describe('submission idempotency', () => {
  // A content Mind retrying its submit must enqueue once. This is enforced by the unique
  // index, not by application code, so it is worth asserting against the real schema.
  it('refuses a second row for the same submissionId', async () => {
    await enqueue({ submissionId: 'news-2026-08-01-a' });
    await expect(enqueue({ submissionId: 'news-2026-08-01-a' })).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('allows the same submissionId for a different user', async () => {
    seedUser(db, { userId: 'beta' });
    await enqueue({ submissionId: 'shared-id' });
    await expect(
      insertQueued(db.env, {
        userId: 'beta',
        submissionId: 'shared-id',
        source: null,
        text: 'other',
        textSha256: 'sha-other',
        hasUrl: false,
        allowUrl: false,
        priority: 0,
        expiresAt: NOW() + 3600,
      }),
    ).resolves.toBeTypeOf('number');
  });
});

describe('binding a slot', () => {
  it('picks the oldest draft when priorities are equal', async () => {
    const first = await enqueue({ text: 'first' });
    await enqueue({ text: 'second' });

    const bound = await bindToSlot(db.env, 'adam', 'adam:2026-08-01T09:00Z', NOW() + 600);
    expect(bound?.id).toBe(first);
    expect(bound?.status).toBe('held');
  });

  it('lets priority jump the line without starving the rest', async () => {
    const old = await enqueue({ text: 'old' });
    const urgent = await enqueue({ text: 'urgent', priority: 5 });

    expect((await bindToSlot(db.env, 'adam', 'adam:2026-08-01T09:00Z', NOW() + 600))?.id).toBe(urgent);
    expect((await bindToSlot(db.env, 'adam', 'adam:2026-08-01T13:00Z', NOW() + 600))?.id).toBe(old);
  });

  // Cloudflare may run two ticks close together or overlap them. The unique index is what
  // makes that safe; without it a slot could bind two drafts and post twice.
  it('cannot bind the same slot twice', async () => {
    await enqueue();
    await enqueue();
    const slot = 'adam:2026-08-01T09:00Z';

    expect(await bindToSlot(db.env, 'adam', slot, NOW() + 600)).not.toBeNull();
    expect(await bindToSlot(db.env, 'adam', slot, NOW() + 600)).toBeNull();
  });

  it('reports a bound slot, including one whose draft was vetoed', async () => {
    const slot = 'adam:2026-08-01T09:00Z';
    expect(await slotIsBound(db.env, 'adam', slot)).toBe(false);

    await enqueue();
    const bound = await bindToSlot(db.env, 'adam', slot, NOW() + 600);
    expect(await slotIsBound(db.env, 'adam', slot)).toBe(true);

    // A vetoed slot stays occupied on purpose: the next draft waits for the next slot
    // rather than being substituted into one a human just rejected.
    await vetoIfHeld(db.env, bound!.id);
    expect(await slotIsBound(db.env, 'adam', slot)).toBe(true);
  });

  it('returns null on an empty queue rather than throwing', async () => {
    expect(await bindToSlot(db.env, 'adam', 'adam:2026-08-01T09:00Z', NOW() + 600)).toBeNull();
  });

  it('will not bind an already-expired draft', async () => {
    await enqueue({ expiresAt: NOW() - 60 });
    expect(await bindToSlot(db.env, 'adam', 'adam:2026-08-01T09:00Z', NOW() + 600)).toBeNull();
  });
});

describe('expiry', () => {
  // A draft written on Tuesday about Tuesday's news must not surface on Friday.
  it('expires queued drafts past their ttl and leaves fresh ones alone', async () => {
    const stale = await enqueue({ expiresAt: NOW() - 1 });
    const fresh = await enqueue({ expiresAt: NOW() + 3600 });

    expect(await expireStale(db.env, 'adam')).toBe(1);
    expect((await getQueueItem(db.env, stale))?.status).toBe('expired');
    expect((await getQueueItem(db.env, fresh))?.status).toBe('queued');
  });

  it('does not expire a held draft, which is already bound to an imminent slot', async () => {
    const id = await enqueue({ expiresAt: NOW() + 3600 });
    await bindToSlot(db.env, 'adam', 'adam:2026-08-01T09:00Z', NOW() + 60);
    await db.raw.prepare('UPDATE queue SET expires_at = ? WHERE id = ?').run(NOW() - 1, id);

    expect(await expireStale(db.env, 'adam')).toBe(0);
    expect((await getQueueItem(db.env, id))?.status).toBe('held');
  });
});

describe('dispatch selection', () => {
  it('returns only held drafts whose slot has arrived', async () => {
    await enqueue();
    await enqueue();

    const due = await bindToSlot(db.env, 'adam', 'adam:2026-08-01T09:00Z', NOW() - 10);
    await bindToSlot(db.env, 'adam', 'adam:2026-08-01T13:00Z', NOW() + 600);

    const ready = await dueForDispatch(db.env, NOW());
    expect(ready.map((r) => r.id)).toEqual([due!.id]);
  });

  it('ignores drafts that are queued but never bound', async () => {
    await enqueue();
    expect(await dueForDispatch(db.env, NOW() + 86_400)).toEqual([]);
  });

  it('stops returning a draft once it is marked posted', async () => {
    await enqueue();
    const bound = await bindToSlot(db.env, 'adam', 'adam:2026-08-01T09:00Z', NOW() - 10);
    await setStatus(db.env, bound!.id, 'posted', { postId: 42 });

    expect(await dueForDispatch(db.env, NOW())).toEqual([]);
    expect((await getQueueItem(db.env, bound!.id))?.post_id).toBe(42);
  });
});

describe('veto', () => {
  it('stops a held draft', async () => {
    await enqueue();
    const bound = await bindToSlot(db.env, 'adam', 'adam:2026-08-01T09:00Z', NOW() + 600);

    expect(await vetoIfHeld(db.env, bound!.id)).toBe(true);
    expect((await getQueueItem(db.env, bound!.id))?.status).toBe('vetoed');
    expect(await dueForDispatch(db.env, NOW() + 3600)).toEqual([]);
  });

  // Clicking the link twice, or clicking it in the seconds after the cron already sent
  // the post, must report the truth rather than appearing to have worked.
  it('is a no-op the second time, and after the post is already out', async () => {
    await enqueue();
    const bound = await bindToSlot(db.env, 'adam', 'adam:2026-08-01T09:00Z', NOW() + 600);

    expect(await vetoIfHeld(db.env, bound!.id)).toBe(true);
    expect(await vetoIfHeld(db.env, bound!.id)).toBe(false);

    await enqueue();
    const other = await bindToSlot(db.env, 'adam', 'adam:2026-08-01T13:00Z', NOW() + 600);
    await setStatus(db.env, other!.id, 'posted', { postId: 7 });
    expect(await vetoIfHeld(db.env, other!.id)).toBe(false);
  });

  it('cannot stop a draft that has not been bound to a slot yet', async () => {
    const id = await enqueue();
    expect(await vetoIfHeld(db.env, id)).toBe(false);
  });
});

describe('veto link signature', () => {
  it('is per-draft, so one link cannot stop another draft', async () => {
    const a = await vetoSignature(db.env, 1);
    const b = await vetoSignature(db.env, 2);
    expect(a).not.toBe(b);
  });

  it('rejects a tampered token', async () => {
    const sig = await vetoSignature(db.env, 1);
    expect(timingSafeEqual(sig, await vetoSignature(db.env, 1))).toBe(true);
    expect(timingSafeEqual(sig.slice(0, -1) + '0', await vetoSignature(db.env, 1))).toBe(false);
    expect(timingSafeEqual(await vetoSignature(db.env, 2), sig)).toBe(false);
  });
});

describe('slot-based post idempotency', () => {
  // The §7.2 fix, at the layer that enforces it. The old key was `daily-<UTC date>`, so a
  // second post on the same day short-circuited to "already posted today". A slot key is
  // minute-precise, so N posts a day are natural — while two cron ticks landing in the
  // SAME slot still collapse to one.
  const claim = (idemKey: string) =>
    claimIdempotency(db.env, {
      userId: 'adam',
      idemKey,
      text: `text for ${idemKey}`,
      textSha256: `sha-${idemKey}`,
      hasUrl: false,
      via: 'cron',
      initialStatus: 'in_flight',
    });

  it('lets several slots post on the same UTC day', async () => {
    const day = Date.parse('2026-08-01T00:00:00Z');
    const keys = ['09:00', '13:00', '18:00'].map((h) => slotIdemKey(slotAt('adam', h, day)));

    for (const k of keys) expect((await claim(k)).kind).toBe('claimed');
  });

  it('collapses two ticks in the same slot to one post', async () => {
    const key = slotIdemKey(slotAt('adam', '09:00', Date.parse('2026-08-01T00:00:00Z')));

    const first = await claim(key);
    expect(first.kind).toBe('claimed');

    // A second tick within the in-flight window is told to stand down, not given a
    // second row — a duplicate tweet is not recoverable by an apology.
    await expect(claim(key)).rejects.toThrow(/already being sent/i);
  });

  it('gives the same slot on different days different keys', async () => {
    const a = slotIdemKey(slotAt('adam', '09:00', Date.parse('2026-08-01T00:00:00Z')));
    const b = slotIdemKey(slotAt('adam', '09:00', Date.parse('2026-08-02T00:00:00Z')));

    expect(a).not.toBe(b);
    expect((await claim(a)).kind).toBe('claimed');
    expect((await claim(b)).kind).toBe('claimed');
  });
});

describe('listPending', () => {
  it('shows queued and held, in the order they will go out', async () => {
    const normal = await enqueue({ text: 'normal' });
    const urgent = await enqueue({ text: 'urgent', priority: 3 });
    const gone = await enqueue({ text: 'withdrawn' });
    await setStatus(db.env, gone, 'withdrawn');

    const pending = await listPending(db.env, 'adam');
    expect(pending.map((p) => p.id)).toEqual([urgent, normal]);
  });

  it('drops items once they reach a terminal state', async () => {
    const id = await enqueue();
    await setStatus(db.env, id, 'posted', { postId: 1 });
    expect(await listPending(db.env, 'adam')).toEqual([]);
  });
});
