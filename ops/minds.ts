/**
 * Shared Minds client for the ops layer.
 *
 * The builder API key is an ACCOUNT-ADMIN credential (role `builder`, exp ~Jan 2028).
 * It lives only here, in local Node — never in the Worker, never in a Mind message,
 * never in a commit.
 */
import { createMindsClient } from '@animocabrands/minds-client-lib';

/**
 * Minds on this account. Their ids differ only in the first GUID segment, which makes
 * them very easy to confuse by eye — always resolve through this map or `--mind <name>`
 * rather than pasting an id.
 */
export const MINDS = {
  adam: '240b453e-f36b-1410-8466-00039ce7df11',
  beta: 'fb12453e-f36b-1410-8466-00039ce7df11',
  trend: '749b453e-f36b-1410-8466-00039ce7df11',
} as const;

export type MindName = keyof typeof MINDS;

/**
 * Default target. Overridable with MINDS_MIND_ID (a name or a raw id) because the vault
 * and the relay are not necessarily installed on the same Mind — installing a contract on
 * whichever Mind happened to be hardcoded is how a credential ends up in the wrong
 * transcript.
 */
export const MIND_ID = resolveMindId(process.env.MINDS_MIND_ID) ?? MINDS.adam;

/** Accepts a friendly name ('beta') or a raw GUID; returns undefined for neither. */
export function resolveMindId(nameOrId?: string): string | undefined {
  if (!nameOrId) return undefined;
  const key = nameOrId.trim().toLowerCase();
  if (key in MINDS) return MINDS[key as MindName];
  if (/^[0-9a-f-]{36}$/.test(key)) return key;
  throw new Error(`Unknown mind "${nameOrId}". Known: ${Object.keys(MINDS).join(', ')}, or a GUID.`);
}

/** Reverse lookup for log lines, so output names the Mind rather than a near-identical id. */
export function mindName(id: string): string {
  const hit = Object.entries(MINDS).find(([, v]) => v.toLowerCase() === id.toLowerCase());
  return hit ? hit[0] : id;
}

/** Human-facing thread (created by the webapp). Used for HITL drafts and approvals. */
export const HUMAN_ALIAS = 'webapp:thread-1785477354652-a9tmbv';

/**
 * Machine traffic, kept separate from the human thread.
 *
 * Overridable via RELAY_OPS_ALIAS because a long-lived conversation eventually starts
 * replaying earlier answers instead of doing the work — switching to a fresh alias is the
 * cheapest cure, since it removes the history there is to replay from.
 */
export const OPS_ALIAS = process.env.RELAY_OPS_ALIAS || 'relay:x-ops';

const builderApiKey = process.env.MINDS_BUILDER_API_KEY;
if (!builderApiKey) {
  throw new Error(
    'MINDS_BUILDER_API_KEY is not set. Run ops scripts via: npm run ops -- ops/<script>.ts',
  );
}

export const client = createMindsClient({ builderApiKey });

/**
 * The platform may only accept `webapp:`-prefixed aliases. Try the dedicated ops
 * conversation and fall back to the existing human thread rather than failing.
 *
 * Two guards, both learned the hard way:
 *
 *  - An alias already bound to a DIFFERENT Mind is never used. `ensureConversation`
 *    succeeds on an existing conversation regardless of which Mind owns it, so without
 *    this check a script aimed at Beta would happily deliver Beta's credential into
 *    Adam's transcript — and the reply would look plausible, because Adam has the vault
 *    contract in long-term memory and would answer from it.
 *  - The HUMAN_ALIAS fallback only applies when the target IS Adam, for the same reason.
 */
export async function resolveOpsAlias(preferred?: string, mindId = MIND_ID): Promise<string> {
  const alias = preferred || OPS_ALIAS;

  const boundTo = await client.getMindIdForAlias(alias).catch(() => undefined);
  if (boundTo && boundTo.toLowerCase() !== mindId.toLowerCase()) {
    throw new Error(
      `Alias "${alias}" belongs to ${mindName(boundTo)}, but this run targets ` +
        `${mindName(mindId)}. Pass --alias for a ${mindName(mindId)} conversation, or ` +
        `set MINDS_MIND_ID=${mindName(boundTo)} if that is the Mind you meant.`,
    );
  }

  try {
    await client.ensureConversation(alias, mindId);
    return alias;
  } catch (err) {
    if (mindId.toLowerCase() !== MINDS.adam.toLowerCase()) {
      throw new Error(
        `Alias "${alias}" rejected for ${mindName(mindId)} (${errText(err)}). Not falling ` +
          `back to ${HUMAN_ALIAS} — that thread belongs to adam.`,
      );
    }
    console.warn(
      `[minds] alias "${alias}" rejected (${errText(err)}); falling back to ${HUMAN_ALIAS}`,
    );
    return HUMAN_ALIAS;
  }
}

/** Mind replies arrive as HTML (`<p>…</p>`), not plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pull the JSON block the playbook asks Minds to emit. Fences are requested but not
 * reliably produced, so fall back to the last balanced top-level object in the text.
 */
export function parseFencedJson(text: string): unknown | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
  for (const m of fenced.reverse()) {
    const parsed = tryParse(m[1]);
    if (parsed !== null) return parsed;
  }
  // Unfenced fallback: scan for balanced { ... } spans, preferring the last one.
  for (const candidate of balancedObjects(text).reverse()) {
    const parsed = tryParse(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function tryParse(s: string | undefined): unknown | null {
  if (!s?.trim()) return null;
  try {
    return JSON.parse(s.trim());
  } catch {
    return null;
  }
}

function balancedObjects(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\' && inStr) {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/** Send a message and wait for the Mind's reply, returning plain text. */
export async function ask(
  alias: string,
  messageText: string,
  timeoutMs = 180_000,
): Promise<{ text: string; json: unknown | null }> {
  const before = await client.getLatestHistoryFingerprint(alias);
  await client.sendMessage({ alias, messageText });
  const outcome = await client.waitForReply({
    alias,
    timeoutMs,
    afterFingerprint: before ?? undefined,
    sentMessageText: messageText,
  });
  if (outcome.timedOut) {
    throw new Error(
      `Mind did not reply within ${timeoutMs}ms. Check: npx @animocabrands/minds-cli history ${alias}`,
    );
  }
  const text = stripHtml(String(outcome.reply.messageText ?? ''));
  return { text, json: parseFencedJson(text) };
}

export function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}
