/**
 * Diagnostic echo. Unauthenticated by design — it must be reachable by a caller whose
 * auth handling is exactly what we are trying to measure.
 *
 * Purpose: settle the one undocumented assumption the relay depends on — whether the
 * Minds `HTTP_Execute` primitive forwards `Authorization` and custom headers, and
 * whether a JSON POST body survives. See ops/probe-http-execute.ts.
 *
 * It deliberately reports only whether a bearer token was PRESENT and its last 4
 * characters, never the token itself, so a probe can never write a live credential into
 * a Mind transcript. Disable with DEBUG_ECHO_ENABLED=false once the question is settled.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth.ts';

export const debug = new Hono<AppEnv>();

debug.all('/debug/echo', async (c) => {
  if (c.env.DEBUG_ECHO_ENABLED === 'false') {
    return c.json({ ok: false, error: { code: 'relay_not_found', message: 'Echo disabled.', retryable: false } }, 404);
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) headers[k.toLowerCase()] = v;

  const authHeader = headers.authorization ?? null;
  const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;

  let bodyText: string | null = null;
  let bodyJson: unknown = null;
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    bodyText = await c.req.text().catch(() => null);
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = null;
      }
    }
  }

  // Redacted so a probe can never leak a live key into a Mind transcript.
  const redacted = Object.fromEntries(
    Object.entries(headers).map(([k, v]) =>
      k === 'authorization' || k === 'x-relay-key'
        ? [k, `<present, ${v.length} chars, ends ...${v.slice(-4)}>`]
        : [k, v],
    ),
  );

  return c.json({
    ok: true,
    echo: {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      authorizationPresent: Boolean(authHeader),
      bearerPresent: Boolean(bearer),
      bearerLast4: bearer ? bearer.slice(-4) : null,
      relayKeyHeaderPresent: Boolean(headers['x-relay-key']),
      viaHeader: headers['x-relay-via'] ?? null,
      customHeadersSeen: Object.keys(headers).filter((h) => h.startsWith('x-')),
      contentType: headers['content-type'] ?? null,
      userAgent: headers['user-agent'] ?? null,
      bodyReceived: bodyText !== null && bodyText.length > 0,
      bodyIsValidJson: bodyJson !== null,
      bodyEcho: bodyJson,
      allHeaders: redacted,
    },
  });
});
