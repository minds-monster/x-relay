/**
 * Raw X API surface. No storage, no locking — that lives in tokens.ts.
 */
import type { ClientType, TokenEnvelope, XClientCredentials } from '../types.ts';
import { mapXError, RelayError, extractXDetail } from './errors.ts';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_TWEETS_URL = 'https://api.x.com/2/tweets';
export const X_ME_URL = 'https://api.x.com/2/users/me';

/**
 * `offline.access` is not optional: without it X returns no refresh token at all and
 * the integration dies two hours after authorization.
 */
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

/** Feb-2026 pay-per-use rates. A URL in the body costs 13x. */
export const COST_PER_POST_USD = 0.015;
export const COST_PER_POST_WITH_URL_USD = 0.2;

/**
 * RFC 6749 §2.3.1: the client id and secret are form-encoded BEFORE base64. This looks
 * superstitious right up until a generated secret contains a reserved character.
 */
function basicAuthHeader(clientId: string, clientSecret: string): string {
  const enc = (s: string) => encodeURIComponent(s);
  return `Basic ${btoa(`${enc(clientId)}:${enc(clientSecret)}`)}`;
}

function tokenRequestInit(
  params: URLSearchParams,
  creds: XClientCredentials,
): RequestInit {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  // Confidential clients authenticate with Basic; public clients rely on client_id in
  // the body. client_id is sent in the body either way.
  if (creds.clientType === 'confidential') {
    if (!creds.clientSecret) {
      throw new RelayError(
        'x_client_invalid',
        409,
        'Client is marked confidential but no client secret is stored.',
      );
    }
    headers.authorization = basicAuthHeader(creds.clientId, creds.clientSecret);
  }
  params.set('client_id', creds.clientId);
  return { method: 'POST', headers, body: params.toString() };
}

export interface XTokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  scope: string;
  refresh_token?: string;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { detail: text.slice(0, 500) };
  }
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const u = new URL(X_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('scope', X_SCOPES.join(' '));
  u.searchParams.set('state', opts.state);
  u.searchParams.set('code_challenge', opts.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
  verifier: string;
  creds: XClientCredentials;
}): Promise<XTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    // Must match the authorize request byte-for-byte.
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  const res = await fetch(X_TOKEN_URL, tokenRequestInit(params, opts.creds));
  const body = await readJson(res);
  if (!res.ok) {
    throw new RelayError(
      'x_bad_request',
      400,
      `X token exchange failed (${res.status}): ${extractXDetail(body) || 'unknown error'}`,
    );
  }
  return body as XTokenResponse;
}

export type RefreshFailureKind = 'dead_grant' | 'client_invalid' | 'transient';

export class RefreshError extends Error {
  constructor(
    readonly kind: RefreshFailureKind,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RefreshError';
  }
}

/**
 * Exchange a refresh token. X ROTATES refresh tokens: the response carries a new one
 * and invalidates the one just used. Callers must persist the result before doing
 * anything else with it.
 */
export async function refreshTokens(opts: {
  refreshToken: string;
  creds: XClientCredentials;
}): Promise<XTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  });
  const res = await fetch(X_TOKEN_URL, tokenRequestInit(params, opts.creds));
  const body = await readJson(res);

  if (res.ok) return body as XTokenResponse;

  const detail = extractXDetail(body);
  const errKey = String((body as Record<string, unknown>)?.error ?? '').toLowerCase();

  // 400 invalid_grant / invalid_request: the refresh token is genuinely dead.
  if (res.status === 400 && /invalid_grant|invalid_request|invalid token/.test(errKey + detail.toLowerCase())) {
    throw new RefreshError('dead_grant', `Refresh token rejected: ${detail}`, res.status);
  }
  // 401: wrong client credentials — typically the secret was rotated in the X portal.
  if (res.status === 401 || errKey === 'invalid_client') {
    throw new RefreshError('client_invalid', `X client credentials rejected: ${detail}`, res.status);
  }
  // 429 / 5xx and anything else: transient. Never discard tokens on these.
  throw new RefreshError(
    'transient',
    `Refresh failed (${res.status}): ${detail || 'unknown error'}`,
    res.status,
  );
}

export interface CreatePostResult {
  tweetId: string;
  raw: unknown;
}

export async function createPost(opts: {
  accessToken: string;
  text: string;
  replyToTweetId?: string;
}): Promise<CreatePostResult> {
  const body: Record<string, unknown> = { text: opts.text };
  if (opts.replyToTweetId) body.reply = { in_reply_to_tweet_id: opts.replyToTweetId };

  const res = await fetch(X_TWEETS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await readJson(res);

  if (!res.ok) throw mapXError(res.status, json, res.headers);

  const id = (json as { data?: { id?: string } })?.data?.id;
  if (!id) {
    throw new RelayError(
      'x_upstream_error',
      502,
      'X returned success without a tweet id.',
      true,
    );
  }
  return { tweetId: id, raw: json };
}

export async function deletePost(opts: {
  accessToken: string;
  tweetId: string;
}): Promise<boolean> {
  const res = await fetch(`${X_TWEETS_URL}/${encodeURIComponent(opts.tweetId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${opts.accessToken}`, accept: 'application/json' },
  });
  const json = await readJson(res);
  if (!res.ok) throw mapXError(res.status, json, res.headers);
  return Boolean((json as { data?: { deleted?: boolean } })?.data?.deleted);
}

/** Reads of your OWN data cost $0.001 — cheap, but not free. */
export async function getMe(accessToken: string): Promise<{ id: string; username: string }> {
  const res = await fetch(X_ME_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const json = await readJson(res);
  if (!res.ok) throw mapXError(res.status, json, res.headers);
  const data = (json as { data?: { id?: string; username?: string } })?.data;
  if (!data?.id) throw new RelayError('x_upstream_error', 502, 'X /users/me returned no id.', true);
  return { id: data.id, username: data.username ?? '' };
}

export function toEnvelope(
  res: XTokenResponse,
  previousRefreshToken?: string,
): TokenEnvelope {
  return {
    access_token: res.access_token,
    // Defensive: if X ever omits a rotated token, keep the one we had rather than
    // writing `undefined` and bricking the account.
    refresh_token: res.refresh_token ?? previousRefreshToken ?? '',
    scope: res.scope,
  };
}

export function assertClientType(v: string): ClientType {
  if (v !== 'confidential' && v !== 'public') {
    throw new RelayError('relay_bad_request', 400, `clientType must be 'confidential' or 'public'`);
  }
  return v;
}
