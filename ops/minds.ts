/**
 * Shared Minds client for the ops layer.
 *
 * The builder API key is an ACCOUNT-ADMIN credential (role `builder`, exp ~Jan 2028).
 * It lives only here, in local Node — never in the Worker, never in a Mind message,
 * never in a commit.
 */
import { createMindsClient } from '@animocabrands/minds-client-lib';

export const MIND_ID = '240b453e-f36b-1410-8466-00039ce7df11'; // "Adam"

/** Human-facing thread (created by the webapp). Used for HITL drafts and approvals. */
export const HUMAN_ALIAS = 'webapp:thread-1785477354652-a9tmbv';

/** Machine traffic. Arbitrary-alias acceptance is unverified — see resolveOpsAlias(). */
export const OPS_ALIAS = 'relay:x-ops';

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
 */
export async function resolveOpsAlias(): Promise<string> {
  try {
    await client.ensureConversation(OPS_ALIAS, MIND_ID);
    return OPS_ALIAS;
  } catch (err) {
    console.warn(
      `[minds] alias "${OPS_ALIAS}" rejected (${errText(err)}); falling back to ${HUMAN_ALIAS}`,
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
