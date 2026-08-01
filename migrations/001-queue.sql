-- One-shot migration: adds the queue table and the scheduling columns on `users`.
--
-- schema.sql is idempotent via CREATE TABLE IF NOT EXISTS, but SQLite has no
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so columns added to an EXISTING users table
-- need this file. Fresh databases get the same columns from schema.sql and should skip it.
--
--   npx wrangler d1 execute x-relay --local  --file=migrations/001-queue.sql
--   npx wrangler d1 execute x-relay --remote --file=migrations/001-queue.sql
--
-- Re-running it fails on the ALTERs with "duplicate column name". That is the intended
-- signal that it has already been applied; nothing is corrupted.

ALTER TABLE users ADD COLUMN slots_utc TEXT;
ALTER TABLE users ADD COLUMN hold_sec INTEGER NOT NULL DEFAULT 2700;
ALTER TABLE users ADD COLUMN queue_ttl_sec INTEGER NOT NULL DEFAULT 172800;

CREATE TABLE IF NOT EXISTS queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  source        TEXT,
  text          TEXT NOT NULL,
  text_sha256   TEXT NOT NULL,
  has_url       INTEGER NOT NULL DEFAULT 0,
  allow_url     INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  slot_id       TEXT,
  hold_until    INTEGER,
  expires_at    INTEGER NOT NULL,
  post_id       INTEGER,
  error_code    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (user_id, submission_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS queue_slot_unique
  ON queue(user_id, slot_id) WHERE slot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS queue_pick ON queue(user_id, status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS queue_due ON queue(status, hold_until);
