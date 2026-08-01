-- X Relay schema (Cloudflare D1 / SQLite).
--
-- D1 rather than KV for everything durable: X invalidates a refresh token the moment
-- it is used, so an eventually-consistent read can permanently lose an account.
-- KV holds only short-lived PKCE state, where its native expirationTtl is the right fit.

CREATE TABLE IF NOT EXISTS users (
  user_id            TEXT PRIMARY KEY,
  label              TEXT,

  -- X identity, filled in at OAuth callback
  x_user_id          TEXT,
  x_handle           TEXT,

  -- The user's OWN X app credentials. BYO-credentials is the ToS spine of this design:
  -- the relay never provisions X apps and never shares a key across users.
  client_type        TEXT NOT NULL DEFAULT 'confidential', -- confidential | public
  client_id_enc      TEXT,
  client_secret_enc  TEXT,
  redirect_uri       TEXT,

  -- Encrypted token envelope: {access_token, refresh_token, scope, x_user_id}.
  -- tokens_prev_enc keeps exactly one generation so a torn write is recoverable
  -- rather than terminal.
  tokens_enc         TEXT,
  tokens_prev_enc    TEXT,
  scope              TEXT,
  expires_at         INTEGER,                              -- unix seconds, access token

  status             TEXT NOT NULL DEFAULT 'pending',
  -- pending | active | reauth_required | client_invalid | disabled
  reauth_url         TEXT,

  -- CAS lock serialising refreshes: the cron sweep and a concurrent /x/post will
  -- otherwise race, and a double refresh invalidates a token still in use.
  refresh_lock       TEXT,
  refresh_lock_until INTEGER,
  refresh_fail_count INTEGER NOT NULL DEFAULT 0,

  -- Guardrails. Approval-on by default: posts are reputationally irreversible and an
  -- unattended LLM is the riskiest day-one configuration under X's automation rules.
  require_approval   INTEGER NOT NULL DEFAULT 1,
  -- ROLLING 24h ceiling. This is a safety limit, NOT the schedule — the schedule is
  -- slots_utc below. Keeping the two separate is deliberate: conflating "how many posts
  -- may exist in any 24h window" with "when do posts go out" is what made the old
  -- daily-<UTC date> idempotency key ambiguous.
  daily_cap          INTEGER NOT NULL DEFAULT 3,
  min_interval_sec   INTEGER NOT NULL DEFAULT 3600,
  budget_usd_month   REAL    NOT NULL DEFAULT 5.0,
  spend_usd_month    REAL    NOT NULL DEFAULT 0,
  spend_month        TEXT,                                 -- 'YYYY-MM', for rollover

  -- Posting schedule. JSON array of UTC "HH:MM" strings, e.g. ["09:00","13:00","18:00"].
  -- UTC throughout, deliberately: a slot id derived from a fixed offset has no calendar
  -- ambiguity and no DST edge cases. NULL or [] means nothing is scheduled.
  slots_utc          TEXT,
  -- How long a draft is held, and announced, before its slot fires. The veto window.
  hold_sec           INTEGER NOT NULL DEFAULT 2700,
  -- A queued draft older than this is dropped rather than posted stale.
  queue_ttl_sec      INTEGER NOT NULL DEFAULT 172800,

  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Only sha256(key) is ever stored, so lookup is by hash: no timing-comparison
-- surface, and a database leak yields nothing usable.
CREATE TABLE IF NOT EXISTS relay_keys (
  key_hash   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  key_id     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  expires_at INTEGER,                                      -- rotation grace window
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS relay_keys_user ON relay_keys(user_id);

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  status        TEXT NOT NULL,
  -- in_flight | done | failed | pending_approval | rejected
  text          TEXT NOT NULL,
  text_sha256   TEXT NOT NULL,
  has_url       INTEGER NOT NULL DEFAULT 0,
  x_tweet_id    TEXT,
  response_json TEXT,
  cost_usd      REAL,
  error_code    TEXT,
  via           TEXT,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  UNIQUE (user_id, idem_key)
);
-- Near-duplicate detection: X's automation rules prohibit duplicate content.
CREATE INDEX IF NOT EXISTS posts_dedupe ON posts(user_id, text_sha256, created_at);
CREATE INDEX IF NOT EXISTS posts_recent ON posts(user_id, created_at);

-- Inbound drafts from content Minds, waiting for a slot.
--
-- Separate from `posts` on purpose. `posts` is the record of what the relay tried to send
-- to X and is the idempotency ledger; `queue` is intent that has not been dispatched yet.
-- Merging them would mean a withdrawn draft occupying an idempotency key it never used.
CREATE TABLE IF NOT EXISTS queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  -- Caller-supplied idempotency for the SUBMISSION, distinct from the post's idem_key
  -- (which is the slot). A content Mind that retries its submit must not enqueue twice.
  submission_id TEXT NOT NULL,
  source        TEXT,                                      -- which Mind submitted it
  text          TEXT NOT NULL,
  text_sha256   TEXT NOT NULL,
  has_url       INTEGER NOT NULL DEFAULT 0,
  allow_url     INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 0,                -- higher wins; ties -> oldest

  status        TEXT NOT NULL,
  -- queued -> held -> posted, with exits: vetoed | expired | failed | withdrawn

  slot_id       TEXT,                                      -- 'adam:2026-08-01T13:00Z'
  hold_until    INTEGER,                                   -- unix sec; the slot time
  expires_at    INTEGER NOT NULL,                          -- drop rather than post stale
  post_id       INTEGER,                                   -- posts.id once dispatched
  error_code    TEXT,

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (user_id, submission_id)
);
-- One row per slot: the partial unique index is what stops two cron ticks binding the
-- same slot twice. Enforced by the database, not by read-then-write.
CREATE UNIQUE INDEX IF NOT EXISTS queue_slot_unique
  ON queue(user_id, slot_id) WHERE slot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS queue_pick ON queue(user_id, status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS queue_due ON queue(status, hold_until);

-- `via` is how we prove a post came from the Mind rather than from a curl.
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  user_id     TEXT,
  route       TEXT NOT NULL,
  via         TEXT,                                        -- mind | curl | cron | approval
  code        TEXT,
  http_status INTEGER,
  x_status    INTEGER,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, ts DESC);
