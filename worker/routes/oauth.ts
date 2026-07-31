/**
 * OAuth 2.0 Authorization Code + PKCE against X.
 *
 * The `code_verifier` is held in KV keyed by `state`, with a 10-minute TTL and deleted
 * on first use. Delete-on-use is a stronger property than cookie expiry, and it avoids
 * needing a `__Host-` cookie, which `wrangler dev` on plain-HTTP 127.0.0.1 cannot set.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth.ts';
import { b64uEncode, pkcePair, randomBytes } from '../lib/crypto.ts';
import { audit, getUser, now } from '../lib/db.ts';
import { badRequest, notFound, RelayError } from '../lib/errors.ts';
import { readClientCreds, persistTokens } from '../lib/tokens.ts';
import { buildAuthorizeUrl, exchangeCode, getMe, toEnvelope, X_SCOPES } from '../lib/xclient.ts';
import type { PkceState } from '../types.ts';

export const oauth = new Hono<AppEnv>();

const PKCE_TTL_SEC = 600;

function page(title: string, bodyHtml: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:34rem;margin:6rem auto;padding:0 1.5rem;color:#111}
 code{background:#f4f4f5;padding:.15em .4em;border-radius:4px;font-size:.9em}
 .ok{color:#0a7d32}.bad{color:#b3261e}
 h1{font-size:1.35rem;margin-bottom:.5rem}
</style>
${bodyHtml}`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

oauth.get('/x/oauth/start', async (c) => {
  const userId = c.req.query('user');
  if (!userId) throw badRequest('Missing ?user=<userId>');

  const user = await getUser(c.env, userId);
  if (!user) throw notFound(`No such user: ${userId}`);
  if (!user.redirect_uri) throw new RelayError('relay_internal', 500, 'User has no redirect_uri.');

  const creds = await readClientCreds(c.env, user);
  const { verifier, challenge } = await pkcePair();
  const state = b64uEncode(randomBytes(32));

  const pkceState: PkceState = {
    userId,
    verifier,
    redirectUri: user.redirect_uri,
    ts: now(),
  };
  await c.env.PKCE.put(`pkce:${state}`, JSON.stringify(pkceState), {
    expirationTtl: PKCE_TTL_SEC,
  });

  const url = buildAuthorizeUrl({
    clientId: creds.clientId,
    redirectUri: user.redirect_uri,
    state,
    challenge,
  });

  await audit(c.env, { userId, route: 'x/oauth/start', via: 'curl', code: 'redirect' });
  return c.redirect(url, 302);
});

oauth.get('/x/oauth/callback', async (c) => {
  const err = c.req.query('error');
  const state = c.req.query('state');
  const code = c.req.query('code');

  if (err) {
    return page(
      'Authorization cancelled',
      `<h1 class="bad">Authorization cancelled</h1>
       <p>X reported: <code>${escapeHtml(err)}</code>${
         c.req.query('error_description')
           ? ` — ${escapeHtml(c.req.query('error_description')!)}`
           : ''
       }</p>
       <p>Nothing was changed. You can safely close this tab and start again.</p>`,
      400,
    );
  }

  if (!state || !code) {
    return page('Invalid callback', '<h1 class="bad">Invalid callback</h1><p>Missing <code>state</code> or <code>code</code>.</p>', 400);
  }

  const raw = await c.env.PKCE.get(`pkce:${state}`);
  if (!raw) {
    return page(
      'Link expired',
      `<h1 class="bad">This link has expired or was already used</h1>
       <p>Authorization links are valid for 10 minutes and single-use. Request a fresh one.</p>`,
      400,
    );
  }
  // Single-use: delete before doing any work, so a replay cannot race us.
  await c.env.PKCE.delete(`pkce:${state}`);

  const pkce = JSON.parse(raw) as PkceState;
  const user = await getUser(c.env, pkce.userId);
  if (!user) return page('Unknown user', '<h1 class="bad">Unknown user</h1>', 404);

  try {
    const creds = await readClientCreds(c.env, user);
    const tokenRes = await exchangeCode({
      code,
      redirectUri: pkce.redirectUri,
      verifier: pkce.verifier,
      creds,
    });

    if (!tokenRes.refresh_token) {
      // Without offline.access there is no refresh token and the integration would die
      // silently in two hours. Fail loudly now instead.
      await audit(c.env, {
        userId: user.user_id,
        route: 'x/oauth/callback',
        code: 'no_refresh_token',
        httpStatus: 400,
      });
      return page(
        'Missing offline.access',
        `<h1 class="bad">X did not return a refresh token</h1>
         <p>The app must request the <code>offline.access</code> scope. Required scopes:</p>
         <p><code>${X_SCOPES.join(' ')}</code></p>`,
        400,
      );
    }

    const envelope = toEnvelope(tokenRes);
    const expiresAt = now() + (tokenRes.expires_in ?? 7200);

    let handle = '';
    let xUserId = '';
    try {
      const me = await getMe(envelope.access_token);
      handle = me.username;
      xUserId = me.id;
    } catch {
      // A $0.001 read failing should not abort a successful authorization.
    }

    await persistTokens(c.env, user, envelope, expiresAt, {
      xUserId: xUserId || undefined,
      xHandle: handle || undefined,
    });

    await audit(c.env, {
      userId: user.user_id,
      route: 'x/oauth/callback',
      code: 'connected',
      httpStatus: 200,
      detail: handle ? `@${handle}` : null,
    });

    return page(
      'Connected',
      `<h1 class="ok">X account connected</h1>
       <p>Relay user <code>${escapeHtml(user.user_id)}</code>${
         handle ? ` is now linked to <code>@${escapeHtml(handle)}</code>` : ' is now linked'
       }.</p>
       <p>Scopes: <code>${escapeHtml(envelope.scope)}</code></p>
       <p>${user.require_approval ? 'Posts will require your approval before going live.' : '<strong>Autonomous posting is enabled</strong> for this user.'}</p>
       <p>You can close this tab.</p>`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit(c.env, {
      userId: user.user_id,
      route: 'x/oauth/callback',
      code: 'exchange_failed',
      httpStatus: 400,
      detail: msg,
    });
    return page(
      'Authorization failed',
      `<h1 class="bad">Could not complete authorization</h1><p><code>${escapeHtml(msg)}</code></p>
       <p>Common causes: the callback URL registered with X does not match byte-for-byte, or the client secret is wrong.</p>`,
      400,
    );
  }
});

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
