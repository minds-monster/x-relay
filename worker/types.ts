export interface Env {
  DB: D1Database;
  PKCE: KVNamespace;

  // vars
  PAYMENTS_ENABLED: string;
  RELAY_BASE_URL: string;
  RELAY_VERSION: string;
  /** Set to "false" to disable /debug/echo once HTTP_Execute behaviour is settled. */
  DEBUG_ECHO_ENABLED?: string;

  // secrets
  MASTER_KEY_B64: string;
  MASTER_KEY_B64_PREV?: string;
  ADMIN_KEY: string;
  APPROVAL_HMAC_KEY: string;
  ALERT_WEBHOOK_URL?: string;
}

export type UserStatus =
  | 'pending'
  | 'active'
  | 'reauth_required'
  | 'client_invalid'
  | 'disabled';

export type ClientType = 'confidential' | 'public';

export interface UserRow {
  user_id: string;
  label: string | null;
  x_user_id: string | null;
  x_handle: string | null;
  client_type: ClientType;
  client_id_enc: string | null;
  client_secret_enc: string | null;
  redirect_uri: string | null;
  tokens_enc: string | null;
  tokens_prev_enc: string | null;
  scope: string | null;
  expires_at: number | null;
  status: UserStatus;
  reauth_url: string | null;
  refresh_lock: string | null;
  refresh_lock_until: number | null;
  refresh_fail_count: number;
  require_approval: number;
  daily_cap: number;
  min_interval_sec: number;
  budget_usd_month: number;
  spend_usd_month: number;
  spend_month: string | null;
  /** JSON array of UTC "HH:MM" strings. Read it through parseSlots() in lib/schedule.ts. */
  slots_utc: string | null;
  hold_sec: number;
  queue_ttl_sec: number;
  created_at: number;
  updated_at: number;
}

export type QueueStatus =
  | 'queued'
  | 'held'
  | 'posted'
  | 'vetoed'
  | 'expired'
  | 'failed'
  | 'withdrawn';

export interface QueueRow {
  id: number;
  user_id: string;
  submission_id: string;
  source: string | null;
  text: string;
  text_sha256: string;
  has_url: number;
  allow_url: number;
  priority: number;
  status: QueueStatus;
  slot_id: string | null;
  hold_until: number | null;
  expires_at: number;
  post_id: number | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

/** Decrypted token envelope, stored and rotated as one unit. */
export interface TokenEnvelope {
  access_token: string;
  refresh_token: string;
  scope: string;
  x_user_id?: string;
}

export interface XClientCredentials {
  clientId: string;
  clientSecret: string | null;
  clientType: ClientType;
}

export type PostStatus =
  | 'in_flight'
  | 'done'
  | 'failed'
  | 'pending_approval'
  | 'rejected';

export interface PostRow {
  id: number;
  user_id: string;
  idem_key: string;
  status: PostStatus;
  text: string;
  text_sha256: string;
  has_url: number;
  x_tweet_id: string | null;
  response_json: string | null;
  cost_usd: number | null;
  error_code: string | null;
  via: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface PkceState {
  userId: string;
  verifier: string;
  redirectUri: string;
  ts: number;
}

/** Where a request came from — `via='mind'` in the audit log is how we prove the
 *  Mind actually called the relay rather than a human running curl. */
export type Via = 'mind' | 'curl' | 'cron' | 'approval' | 'admin';
