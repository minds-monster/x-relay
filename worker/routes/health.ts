import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth.ts';

export const health = new Hono<AppEnv>();

health.get('/health', async (c) => {
  const checks: Record<string, string> = {};

  try {
    await c.env.DB.prepare('SELECT 1').first();
    checks.db = 'ok';
  } catch (err) {
    checks.db = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    await c.env.PKCE.get('__healthcheck__');
    checks.kv = 'ok';
  } catch (err) {
    checks.kv = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  checks.masterKey = c.env.MASTER_KEY_B64 ? 'set' : 'MISSING';
  checks.adminKey = c.env.ADMIN_KEY ? 'set' : 'MISSING';
  checks.approvalKey = c.env.APPROVAL_HMAC_KEY ? 'set' : 'MISSING';
  checks.payments = c.env.PAYMENTS_ENABLED === 'true' ? 'enabled' : 'disabled';

  const ok = Object.values(checks).every((v) => v === 'ok' || v === 'set' || v === 'enabled' || v === 'disabled');
  return c.json({ ok, version: c.env.RELAY_VERSION, ts: new Date().toISOString(), checks }, ok ? 200 : 503);
});
