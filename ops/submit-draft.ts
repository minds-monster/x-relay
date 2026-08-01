/**
 * The reference content Mind: ask a Mind for a draft, hand it to the relay's queue, stop.
 *
 * This used to be daily-loop.ts, which also performed the post. It no longer does — the
 * relay's cron owns publishing now, so this script's whole job is generation plus a
 * verified handoff. That split is the point of the queue: a content Mind that cannot
 * publish cannot publish at the wrong moment, twice, or after being vetoed.
 *
 * WHAT SURVIVED THE REWRITE, AND WHY
 *
 * Generation is still not trusted. Asked twice in a row with a near-identical prompt, a
 * Mind will replay its previous answer verbatim — observed, including a stale request id
 * and a "dry_run" claim on a run that never requested one. Two defences remain:
 *
 *   - a per-run request id embedded in the prompt and required back, so a replayed answer
 *     is detected rather than submitted;
 *   - a retry in a throwaway conversation, which cures the cause rather than reporting it,
 *     because a conversation with no history has nothing to replay from.
 *
 * And the submission itself is verified server-side by nonce: a Mind's self-report is not
 * evidence, but an audit row carrying a value that did not exist before this run began is.
 *
 * Runs locally (launchd/cron), not on the Worker: it needs the account-admin builder JWT,
 * which must never reach the edge, and waitForReply holds an SSE stream for minutes. The
 * relay does not depend on it — a missed run means an empty slot, not a broken relay.
 *
 * Usage:
 *   npm run ops -- ops/submit-draft.ts [--topic "..."] [--source name] [--priority n]
 *                                      [--ttl-sec n] [--dry-run]
 */
import { ask, client, MIND_ID, resolveOpsAlias, errText } from './minds.ts';
import { findNonceInAudit, relayFetch, relayKey, resolveCallBase } from './relay-client.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const topic = opt('topic') ?? 'agent analytics — how sites detect and serve AI agents';
const source = opt('source') ?? 'submit-draft';
const priority = Number(opt('priority') ?? 0);
const ttlSec = opt('ttl-sec') ? Number(opt('ttl-sec')) : undefined;

/** Stop before spending the last of the platform credits on a routine loop. */
const MIN_COGNITION_BALANCE = 1;

const today = new Date().toISOString().slice(0, 10);

/**
 * Random per-run token. Proves the specific call happened: the value cannot have been
 * known before this run started, so finding it in the audit log is strong evidence,
 * whereas a missing audit row alone would be ambiguous.
 */
function makeNonce(): string {
  return 'n' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

async function cognitionOk(): Promise<boolean> {
  try {
    const bal = await client.getCognitionBalance(MIND_ID);
    console.log(`Cognition balance: ${bal.cognition}`);
    if (Number.isFinite(bal.cognition) && bal.cognition < MIN_COGNITION_BALANCE) {
      console.error(
        `Balance ${bal.cognition} is below the floor of ${MIN_COGNITION_BALANCE}. Skipping.`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`Could not read cognition balance (${errText(err)}); continuing.`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// 1. Ask the Mind to WRITE. Nothing else — no URLs, no tools, no posting.
// ---------------------------------------------------------------------------

const nonce = makeNonce();

function buildPrompt(requestId: string): string {
  return `Write one X post. This is a NEW request — request id ${requestId}, ${new Date().toISOString()}.

Do not reuse, quote, or lightly edit any post you have drafted earlier in this
conversation. Compose something fresh even if the topic looks familiar.

Topic: ${topic}

Constraints:
  - 280 characters maximum, ideally under 240.
  - No hashtags. No emoji. No "thread below". No engagement bait.
  - One concrete idea, stated plainly. Prefer a specific observation over a general claim.
  - No links of any kind, and no bare domains.

Do NOT post it. Do NOT call any tool, app, or HTTP endpoint. Writing is the whole task —
publishing is handled outside this conversation.

Reply with exactly one fenced json block and nothing after it:
{"action":"draft","requestId":"${requestId}","draftText":"<the post>","chars":<number>}`;
}

type DraftAttempt =
  | { ok: true; draftText: string; claimedChars: unknown }
  | { ok: false; reason: 'replayed' | 'unverified' | 'unparsed' | 'empty'; reply: string; got?: unknown };

async function attemptDraft(alias: string, requestId: string): Promise<DraftAttempt> {
  const { text, json } = await ask(alias, buildPrompt(requestId), 300_000);
  if (!json) return { ok: false, reason: 'unparsed', reply: text };

  const r = json as Record<string, unknown>;
  const echoed = r.requestId;

  if (String(echoed ?? '') !== requestId) {
    const hadId = echoed !== undefined && echoed !== null && String(echoed) !== '';
    return { ok: false, reason: hadId ? 'replayed' : 'unverified', reply: text, got: echoed };
  }

  const draftText = String(r.draftText ?? '').trim();
  if (!draftText) return { ok: false, reason: 'empty', reply: text };

  return { ok: true, draftText, claimedChars: r.chars };
}

const startedAt = Date.now();

if (!(await cognitionOk())) process.exit(0);

/**
 * Attempt 1 uses a per-day conversation; attempt 2 uses a throwaway one.
 *
 * Verified behaviour: in a conversation that already contains a similar request, the Mind
 * returns its previous draft verbatim — across two runs it echoed a stale request id with
 * byte-identical text. The same prompt in a fresh conversation produced fresh text every
 * time. So rather than only detecting replay, we cure it: retry once somewhere with no
 * history to replay from.
 *
 * Per-day rather than per-run for attempt 1: a day's worth of context is useful for
 * avoiding self-repetition, while an unbounded thread eventually replays everything.
 * Now that several drafts a day are normal, the per-run request id is what keeps each
 * one honest within that shared conversation.
 */
const primaryAlias = process.env.RELAY_OPS_ALIAS || `relay:x-daily-${today}`;

console.log(`[${new Date().toISOString()}] submit-draft${dryRun ? ' (dry run)' : ''}`);

let draftText = '';
let claimedChars: unknown = '?';

const plan: Array<{ alias: string; requestId: string; label: string }> = [
  { alias: primaryAlias, requestId: nonce, label: 'primary' },
  { alias: `relay:x-draft-${nonce}`, requestId: makeNonce(), label: 'fresh conversation' },
];

for (const [i, step] of plan.entries()) {
  const alias = await resolveOpsAlias(step.alias);
  console.log(`\n  attempt ${i + 1} (${step.label}) -> ${alias}`);
  console.log(`  request id: ${step.requestId}`);

  let attempt: DraftAttempt;
  try {
    attempt = await attemptDraft(alias, step.requestId);
  } catch (err) {
    console.error(`  generation failed: ${errText(err)}`);
    if (i === plan.length - 1) process.exit(1);
    continue;
  }

  if (attempt.ok) {
    draftText = attempt.draftText;
    claimedChars = attempt.claimedChars;
    break;
  }

  // Explain what went wrong and show the reply — "nothing was posted, no reason given"
  // is a miserable failure mode.
  const explain: Record<string, string> = {
    replayed: `the Mind echoed request id "${attempt.got}" instead of "${step.requestId}" — it replayed an earlier answer`,
    unverified: 'the Mind did not echo the request id, so freshness is unproven',
    unparsed: 'the reply contained no parseable json block',
    empty: 'the Mind returned an empty draft',
  };
  console.error(`  rejected: ${explain[attempt.reason]}`);
  console.error('  --- reply ---');
  console.error(
    attempt.reply
      .split('\n')
      .slice(0, 12)
      .map((l) => '  ' + l)
      .join('\n')
      .slice(0, 1200),
  );

  if (i === plan.length - 1) {
    console.error('\n  Nothing was submitted. Both attempts failed to produce verifiable fresh text.');
    process.exit(1);
  }
  console.error('  retrying in a conversation with no history...');
}

console.log(`\n  draft   : ${draftText}`);
console.log(`  chars   : ${[...draftText].length} (Mind said ${claimedChars})`);

// ---------------------------------------------------------------------------
// 2. Hand it to the queue. The relay decides when it goes out.
// ---------------------------------------------------------------------------
//
// --dry-run stops here rather than calling the relay: there is no publish to preview any
// more, and enqueuing a draft "just to see" would occupy a real slot.

if (dryRun) {
  console.log('\n  dry run — nothing submitted.');
  process.exit(0);
}

// Stable per run, and stable across a retry of THIS run: re-running after a network
// failure re-submits the same id, which the relay answers idempotently instead of
// queueing the draft twice.
const submissionId = `${source}-${nonce}`;

let status: number;
let ok: boolean;
let out: Record<string, any>;

try {
  ({ status, ok, body: out } = await relayFetch('/x/queue', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${relayKey()}`,
      'content-type': 'application/json',
      'x-relay-via': 'cron',
    },
    body: JSON.stringify({
      text: draftText,
      submissionId,
      source,
      clientNonce: nonce,
      ...(priority ? { priority } : {}),
      ...(ttlSec ? { ttlSec } : {}),
    }),
  }));
} catch (err) {
  console.error(`\n  ${errText(err)}`);
  console.error(`  The draft above was NOT queued. Re-run — submissionId ${submissionId} is safe to reuse.`);
  process.exit(1);
}

console.log(`  queued  : http ${status} (via ${await resolveCallBase()})`);

if (!ok && !out.ok) {
  console.error(`  ERROR   : ${out.error?.code ?? 'unknown'} — ${out.error?.message ?? ''}`);
  process.exit(1);
}

if (out.idempotent) {
  console.log(`  already queued as #${out.queueId} (${out.status})`);
} else {
  console.log(`  queueId : #${out.queueId} (position ${out.position})`);
  console.log(`  slot    : ${out.estimatedSlotUtc ?? 'unknown'}`);
  console.log(`  expires : ${out.expiresAtUtc ?? '-'}`);
}
console.log('\n  Not live. The relay will hold it, announce it, and post it at its slot.');

// ---------------------------------------------------------------------------
// 3. Confirm the relay recorded THIS call, by nonce.
// ---------------------------------------------------------------------------

const userId = process.env.RELAY_USER_ID ?? 'adam';

if (!process.env.ADMIN_KEY) {
  console.log('\n  (set ADMIN_KEY in .env to verify server-side)');
} else {
  const sinceSec = Math.ceil((Date.now() - startedAt) / 1000) + 60;
  try {
    const match = await findNonceInAudit(userId, nonce, sinceSec, 'x/queue');
    if (match) {
      console.log(
        `\n  verified: relay recorded this exact submission (nonce=${nonce}, via=${match.via}, code=${match.code})`,
      );
    } else {
      // The submission was made by this script rather than by the Mind, so this should be
      // unreachable. If it fires, suspect the relay, not the Mind.
      console.error(
        `\n  verified: NO audit row carrying nonce=${nonce}\n` +
          '  The relay answered but did not record the call. Check the Worker logs.',
      );
      process.exit(1);
    }
  } catch (err) {
    console.warn(`\n  (could not verify: ${errText(err)})`);
  }
}
