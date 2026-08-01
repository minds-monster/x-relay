/**
 * One response envelope for every route, so the Mind's playbook can branch
 * deterministically on `error.code` instead of parsing prose.
 *
 *   { "ok": false, "error": { code, message, retryable, retryAfterSec? } }
 */

export type ErrorCode =
  // relay-side
  | 'relay_unauthorized'
  | 'relay_forbidden'
  | 'relay_not_found'
  | 'relay_bad_request'
  | 'relay_internal'
  | 'relay_payment_required' // reserved for x402 — never used for X billing
  // guardrails
  | 'text_too_long'
  | 'text_empty'
  | 'url_not_allowed'
  | 'daily_cap_reached'
  | 'min_interval_not_elapsed'
  | 'budget_exceeded'
  | 'duplicate_recent_text'
  | 'post_in_flight'
  // queue
  | 'submission_id_required'
  | 'no_schedule_configured'
  | 'queue_full'
  // account state
  | 'x_reauth_required'
  | 'x_client_invalid'
  | 'user_disabled'
  | 'user_not_connected'
  // X upstream
  | 'x_rate_limited'
  | 'x_duplicate_content'
  | 'x_forbidden'
  | 'x_credits_exhausted'
  | 'x_upstream_error'
  | 'x_bad_request';

export interface ErrorBody {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSec?: number;
    reauthUrl?: string;
  };
}

export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly retryable = false,
    readonly extra: { retryAfterSec?: number; reauthUrl?: string } = {},
  ) {
    super(message);
    this.name = 'RelayError';
  }

  toBody(): ErrorBody {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.extra.retryAfterSec !== undefined
          ? { retryAfterSec: this.extra.retryAfterSec }
          : {}),
        ...(this.extra.reauthUrl ? { reauthUrl: this.extra.reauthUrl } : {}),
      },
    };
  }
}

export const badRequest = (msg: string, code: ErrorCode = 'relay_bad_request') =>
  new RelayError(code, 400, msg);

export const unauthorized = (msg = 'Invalid or revoked relay key.') =>
  new RelayError('relay_unauthorized', 401, msg);

export const notFound = (msg = 'Not found.') => new RelayError('relay_not_found', 404, msg);

/**
 * Map an X API failure onto the relay's error vocabulary.
 *
 * X returns two error shapes and it is not consistent about which, so read both:
 *   { title, detail, type, status }        (problem+json)
 *   { errors: [{ message, code }, ...] }   (legacy)
 */
export function mapXError(status: number, body: unknown, headers: Headers): RelayError {
  const detail = extractXDetail(body).toLowerCase();

  if (status === 429) {
    // Prefer the delta header; fall back to the absolute reset epoch.
    const resetHeader =
      headers.get('x-rate-limit-reset') ?? headers.get('x-user-limit-24hour-reset');
    const retryAfter = headers.get('retry-after');
    let retryAfterSec = 900;
    if (retryAfter && Number.isFinite(Number(retryAfter))) {
      retryAfterSec = Number(retryAfter);
    } else if (resetHeader && Number.isFinite(Number(resetHeader))) {
      const delta = Number(resetHeader) - Math.floor(Date.now() / 1000);
      if (delta > 0 && delta < 86_400) retryAfterSec = delta;
    }
    return new RelayError(
      'x_rate_limited',
      429,
      'X rate limit reached.',
      true,
      { retryAfterSec },
    );
  }

  // Credit exhaustion under the Feb-2026 pay-per-use model. The exact shape is not
  // yet documented, so match defensively on status AND text.
  const looksLikeCredits =
    /credit|insufficient fund|payment required|quota|billing|not enough/.test(detail);
  if (status === 402 || (status === 403 && looksLikeCredits)) {
    return new RelayError(
      'x_credits_exhausted',
      402,
      'X prepaid API credits are exhausted. Top up in the X developer portal.',
      false,
    );
  }

  if (status === 403) {
    if (/duplicate/.test(detail)) {
      return new RelayError(
        'x_duplicate_content',
        409,
        'X rejected this as duplicate content. Rewrite materially before retrying.',
        false,
      );
    }
    return new RelayError(
      'x_forbidden',
      403,
      `X refused this request: ${extractXDetail(body) || 'forbidden'}`,
      false,
    );
  }

  if (status === 401) {
    return new RelayError(
      'x_reauth_required',
      409,
      'X rejected the access token. Re-authorization is required.',
      false,
    );
  }

  if (status >= 500) {
    return new RelayError('x_upstream_error', 502, `X returned ${status}.`, true);
  }

  return new RelayError(
    'x_bad_request',
    400,
    `X rejected this request (${status}): ${extractXDetail(body) || 'unknown error'}`,
    false,
  );
}

export function extractXDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const o = body as Record<string, unknown>;

  const parts: string[] = [];
  if (typeof o.detail === 'string') parts.push(o.detail);
  if (typeof o.title === 'string') parts.push(o.title);
  if (typeof o.error_description === 'string') parts.push(o.error_description);
  if (typeof o.error === 'string') parts.push(o.error);

  if (Array.isArray(o.errors)) {
    for (const e of o.errors) {
      if (e && typeof e === 'object') {
        const eo = e as Record<string, unknown>;
        if (typeof eo.message === 'string') parts.push(eo.message);
        else if (typeof eo.detail === 'string') parts.push(eo.detail);
      }
    }
  }
  return [...new Set(parts)].join('; ');
}
