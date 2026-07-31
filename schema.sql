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
  daily_cap          INTEGER NOT NULL DEFAULT 3,
  min_interval_sec   INTEGER NOT NULL DEFAULT 3600,
  budget_usd_month   REAL    NOT NULL DEFAULT 5.0,
  spend_usd_month    REAL    NOT NULL DEFAULT 0,
  spend_month        TEXT,                                 -- 'YYYY-MM', for rollover

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
