/**
 * A D1 adapter over node:sqlite, so queue and scheduler logic can be tested against the
 * real schema.sql rather than a mock.
 *
 * This matters more than it might look. The two properties the queue depends on for
 * correctness are enforced by the DATABASE, not by application code:
 *
 *   UNIQUE(user_id, submission_id)   a resubmitting Mind enqueues once
 *   UNIQUE(user_id, slot_id)         two cron ticks cannot bind the same slot
 *
 * A hand-written fake would have to reimplement both, which would mean testing the fake.
 * Running the actual DDL means a schema change that breaks an invariant fails the suite.
 *
 * Only the slice of the D1 surface this codebase uses is implemented: prepare().bind()
 * with ?N parameters, then .run() / .first() / .all().
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Env } from '../../worker/types.ts';

/**
 * Translate D1's numbered `?N` placeholders into plain positional `?`.
 *
 * node:sqlite binds arguments in order and ignores the numbering, so a query that reuses
 * an index — `VALUES (..., ?10, ?10)` for created_at and updated_at, which this codebase
 * does — binds the wrong values or errors outright. Expanding to one `?` per occurrence,
 * with the argument list reordered to match, makes both dialects agree.
 *
 * Naive about `?N` inside string literals; no query here contains one.
 */
function toPositional(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  const order: number[] = [];
  const rewritten = sql.replace(/\?(\d+)/g, (_m, n: string) => {
    order.push(Number(n) - 1);
    return '?';
  });
  if (order.length === 0) return { sql, args };
  return { sql: rewritten, args: order.map((i) => args[i]) };
}

class Stmt {
  private args: unknown[] = [];
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): Stmt {
    // D1 accepts booleans and undefined; SQLite accepts neither.
    this.args = args.map((a) =>
      typeof a === 'boolean' ? (a ? 1 : 0) : a === undefined ? null : a,
    );
    return this;
  }

  private prepared() {
    const { sql, args } = toPositional(this.sql, this.args);
    return { stmt: this.db.prepare(sql), args: args as any[] };
  }

  async run() {
    const { stmt, args } = this.prepared();
    const res = stmt.run(...args);
    return { meta: { last_row_id: Number(res.lastInsertRowid), changes: Number(res.changes) } };
  }

  async first<T>(): Promise<T | null> {
    const { stmt, args } = this.prepared();
    return (stmt.get(...args) as T) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const { stmt, args } = this.prepared();
    return { results: stmt.all(...args) as T[] };
  }
}

export interface TestDb {
  env: Env;
  raw: DatabaseSync;
  close(): void;
}

/** A fresh in-memory database with schema.sql applied. */
export function makeTestDb(overrides: Partial<Env> = {}): TestDb {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
  db.exec(schema);

  const env = {
    DB: { prepare: (sql: string) => new Stmt(db, sql) },
    PKCE: {},
    PAYMENTS_ENABLED: 'false',
    RELAY_BASE_URL: 'https://relay.example.test',
    RELAY_VERSION: 'test',
    MASTER_KEY_B64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ADMIN_KEY: 'test-admin-key',
    APPROVAL_HMAC_KEY: 'test-hmac-key',
    ...overrides,
  } as unknown as Env;

  return { env, raw: db, close: () => db.close() };
}

/** Insert a minimally-viable active user. Only fields the tests care about are settable. */
export function seedUser(
  db: TestDb,
  opts: Partial<{
    userId: string;
    slotsUtc: string[] | null;
    holdSec: number;
    queueTtlSec: number;
    dailyCap: number;
    minIntervalSec: number;
    requireApproval: boolean;
  }> = {},
): string {
  const userId = opts.userId ?? 'adam';
  const t = Math.floor(Date.now() / 1000);
  db.raw
    .prepare(
      `INSERT INTO users (user_id, label, x_handle, client_type, status, require_approval,
                          daily_cap, min_interval_sec, budget_usd_month, spend_usd_month,
                          spend_month, slots_utc, hold_sec, queue_ttl_sec, created_at, updated_at)
       VALUES (?, ?, ?, 'confidential', 'active', ?, ?, ?, 5.0, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      userId,
      userId,
      opts.requireApproval ? 1 : 0,
      opts.dailyCap ?? 10,
      opts.minIntervalSec ?? 600,
      new Date().toISOString().slice(0, 7),
      opts.slotsUtc === null ? null : JSON.stringify(opts.slotsUtc ?? ['09:00', '13:00', '18:00']),
      opts.holdSec ?? 2700,
      opts.queueTtlSec ?? 172_800,
      t,
      t,
    );
  return userId;
}
