/**
 * HTTP client the ops scripts use to talk to the relay.
 *
 * Two things this exists to get right:
 *
 * 1. PREFER LOCALHOST. The ops scripts run on the same machine as `wrangler dev`, so
 *    sending their own requests through the public tunnel adds a slow, failure-prone hop
 *    for no benefit — measured at ~1.3s via ngrok versus ~0.01s direct, with occasional
 *    outright failures. The tunnel is only needed by the Mind (which is remote) and by
 *    humans clicking approval links. A dropped tunnel should not be able to lose a post
 *    that was already written.
 *
 * 2. RETRY. A cold tunnel request regularly takes several seconds and sometimes fails
 *    once before succeeding, so a single attempt with no timeout is not good enough for
 *    the step that actually publishes.
 *
 * RELAY_BASE_URL stays the PUBLIC url: the Worker builds OAuth and approval links from it,
 * and those must be reachable from a browser and from Animoca's servers.
 */
import { readFileSync } from 'node:fs';

const DEFAULT_LOCAL = 'http://127.0.0.1:8787';
const ATTEMPT_TIMEOUT_MS = 20_000;

export function publicBaseUrl(): string {
  const v = process.env.RELAY_BASE_URL;
  if (!v) {
    console.error('RELAY_BASE_URL is not set in .env');
    process.exit(2);
  }
  return v.replace(/\/$/, '');
}

export function relayKey(): string {
  try {
    return readFileSync(new URL('../.relay-key', import.meta.url), 'utf8').trim();
  } catch {
    console.error('No .relay-key file. Run: sh ops/relay.sh provision <clientId> <clientSecret>');
    process.exit(2);
  }
}

async function reachable(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let cachedBase: string | null = null;

/**
 * Pick the base url for this script's own calls: localhost if the relay is there,
 * otherwise the public url (which covers running ops from a different machine).
 */
export async function resolveCallBase(): Promise<string> {
  if (cachedBase) return cachedBase;

  const local = (process.env.RELAY_LOCAL_URL || DEFAULT_LOCAL).replace(/\/$/, '');
  if (await reachable(local)) {
    cachedBase = local;
    return local;
  }

  const pub = publicBaseUrl();
  if (await reachable(pub)) {
    console.warn(`  (relay not on ${local}; falling back to ${pub})`);
    cachedBase = pub;
    return pub;
  }

  console.error(`Cannot reach the relay on ${local} or ${pub}.`);
  console.error('Is `npx wrangler dev` running?');
  process.exit(1);
}

export interface RelayResult {
  status: number;
  ok: boolean;
  body: Record<string, any>;
}

/** Fetch with retries. Retries transport errors and 5xx, never 4xx (a 4xx is an answer). */
export async function relayFetch(
  path: string,
  init: RequestInit & { attempts?: number } = {},
): Promise<RelayResult> {
  const base = await resolveCallBase();
  const attempts = init.attempts ?? 3;
  let lastErr: unknown = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, any>;

      if (res.status >= 500 && i < attempts) {
        console.warn(`  (relay returned ${res.status}, retrying ${i}/${attempts})`);
        continue;
      }
      return { status: res.status, ok: res.ok, body };
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        console.warn(`  (request failed, retrying ${i}/${attempts})`);
        await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
  }

  throw new Error(
    `Relay request to ${base}${path} failed after ${attempts} attempts: ` +
      (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  );
}

/** Look for an audit row carrying our nonce — proof the call really happened. */
export async function findNonceInAudit(
  userId: string,
  nonce: string,
  sinceSec: number,
): Promise<Record<string, unknown> | null> {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return null;

  const { ok, body } = await relayFetch(
    `/admin/users/${encodeURIComponent(userId)}/recent?sinceSec=${sinceSec}`,
    { headers: { 'x-admin-key': adminKey } },
  );
  if (!ok) return null;

  const rows = (body.audit ?? []) as Array<Record<string, unknown>>;
  return (
    rows.find(
      (r) => String(r.route) === 'x/post' && String(r.detail ?? '').includes(`nonce=${nonce}`),
    ) ?? null
  );
}
