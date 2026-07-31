/**
 * Drive a post through the Mind, exercising the whole chain:
 *   ops -> sendMessage -> Mind -> HTTP_Execute -> relay -> guardrails -> X
 *
 * Unlike ops/daily-loop.ts (which deliberately posts by itself), this script's PURPOSE is
 * to test that the Mind can make the call. So it keeps the Mind in charge, and proves
 * execution with a nonce rather than trusting the Mind's self-report: a fresh random value
 * is minted here, the Mind is required to include it in the request body, and afterwards
 * we look for that exact value in the relay's audit log.
 *
 * This matters because a missing audit row is ambiguous (the request might merely have
 * failed), whereas a matching nonce cannot be fabricated from memory — the value did not
 * exist before this run.
 *
 * Usage:
 *   npm run ops -- ops/ask-mind-to-post.ts "text to post" [--dry-run]
 *   npm run ops -- ops/ask-mind-to-post.ts --status
 */
import { ask, resolveOpsAlias, errText } from './minds.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const statusOnly = args.includes('--status');
const text = args.filter((a) => !a.startsWith('--')).join(' ');

if (!statusOnly && !text) {
  console.error('Usage: npm run ops -- ops/ask-mind-to-post.ts "text" [--dry-run] [--status]');
  process.exit(2);
}

const nonce = 'm' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const today = new Date().toISOString().slice(0, 10);
const startedAt = Date.now();

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

const PROMPT = statusOnly
  ? `Using the X_RELAY contract, call GET {base}/x/me right now and report what it returns.

This is a new request (id ${nonce}). Do not answer from memory — make the call.

Reply with exactly one fenced json block and nothing after it:
{"action":"relay_status","requestId":"${nonce}","httpStatus":<n>,"ok":<bool>,
 "status":"<status>","xHandle":<string|null>,"postsToday":<n>,"dailyCap":<n>,
 "requireApproval":<bool>,"errorCode":<string|null>}`
  : `Using the X_RELAY contract, post this to X exactly as written — do not rewrite,
embellish, add hashtags, or change the wording:

${text}

This is a NEW request, id ${nonce} (${new Date().toISOString()}). Make the HTTP call now.
Do not reuse or report any result from earlier in this conversation.

Include these fields in the POST /x/post body:
  "idempotencyKey": "manual-${today}-${Math.abs(hashCode(text)).toString(36)}"
  "clientNonce": "${nonce}"
${dryRun ? '  "dryRun": true\n' : ''}
The clientNonce is required — it is how I confirm the call actually reached my server.

Follow the contract's rules exactly. On a 202, report the draft and approveUrl and STOP;
do not claim it is live. On an error, report the code verbatim and follow the contract.

Reply with exactly one fenced json block and nothing after it:
{"action":"relay_post","requestId":"${nonce}","httpStatus":<n>,
 "outcome":"posted|pending_approval|idempotent|error|dry_run",
 "tweetId":<string|null>,"url":<string|null>,"draftId":<string|null>,
 "approveUrl":<string|null>,"errorCode":<string|null>,
 "whatIDidNext":"<one sentence>"}`;

const alias = await resolveOpsAlias();
console.log(
  `Asking ${alias} to ${statusOnly ? 'report relay status' : dryRun ? 'dry-run a post' : 'post'}...`,
);
console.log(`  request id / nonce: ${nonce}\n`);

let parsed: Record<string, unknown> = {};

try {
  const { text: reply, json } = await ask(alias, PROMPT, 240_000);
  console.log('--- Mind reply ---');
  console.log(reply.slice(0, 2500));

  if (json) {
    parsed = json as Record<string, unknown>;
    console.log('\n--- parsed ---');
    console.log(JSON.stringify(parsed, null, 2));
    if (parsed.outcome === 'posted' && parsed.url) console.log(`\n  LIVE: ${parsed.url}`);
    if (parsed.outcome === 'pending_approval') console.log(`\n  AWAITING APPROVAL: ${parsed.approveUrl}`);
    if (parsed.errorCode) console.log(`\n  error code: ${parsed.errorCode}`);
  } else {
    console.log('\n(no json block parsed — read the reply text above)');
  }
} catch (err) {
  console.error(`\nFailed: ${errText(err)}`);
  process.exit(1);
}

// --- Proof of execution ------------------------------------------------------

if (String(parsed.requestId ?? '') !== nonce) {
  console.warn(
    `\n  WARNING: the Mind echoed requestId "${parsed.requestId ?? '(none)'}" instead of "${nonce}".` +
      '\n  That suggests it answered from memory. The audit check below is authoritative.',
  );
}

const baseUrl = process.env.RELAY_BASE_URL?.replace(/\/$/, '');
const adminKey = process.env.ADMIN_KEY;
const userId = process.env.RELAY_USER_ID ?? 'adam';

if (statusOnly) {
  // GET /x/me is not audited (it is a free read), so there is no nonce to look for.
  console.log('\n  (status calls are not audited — nothing to verify server-side)');
  process.exit(0);
}

if (!baseUrl || !adminKey) {
  console.log('\n  (set RELAY_BASE_URL and ADMIN_KEY in .env to verify server-side)');
  process.exit(0);
}

const sinceSec = Math.ceil((Date.now() - startedAt) / 1000) + 60;

try {
  const res = await fetch(
    `${baseUrl}/admin/users/${encodeURIComponent(userId)}/recent?sinceSec=${sinceSec}`,
    { headers: { 'x-admin-key': adminKey } },
  );
  if (!res.ok) {
    console.warn(`\n  (could not verify: relay returned ${res.status})`);
    process.exit(0);
  }
  const body = (await res.json()) as { audit?: Array<Record<string, unknown>> };
  const rows = (body.audit ?? []).filter((r) => String(r.route) === 'x/post');
  const match = rows.find((r) => String(r.detail ?? '').includes(`nonce=${nonce}`));

  console.log('\n--- server-side verification ---');
  if (match) {
    console.log(`  PROVEN: the relay recorded this exact call.`);
    console.log(`    nonce = ${nonce}`);
    console.log(`    via   = ${match.via}   code = ${match.code}   http = ${match.http_status}`);
    if (match.via !== 'mind') {
      console.warn(
        `    Note: via is "${match.via}", not "mind" — the Mind did not send the X-Relay-Via header.`,
      );
    }
  } else if (rows.length > 0) {
    console.error(
      `  NOT PROVEN: there are recent x/post rows, but none carry nonce=${nonce}.\n` +
        '  The Mind likely replayed an earlier response instead of calling.',
    );
    for (const r of rows.slice(0, 3)) {
      console.error(`    via=${r.via} code=${r.code} detail=${String(r.detail ?? '').slice(0, 60)}`);
    }
    process.exit(1);
  } else {
    console.error(
      `  NOT PROVEN: no x/post request reached the relay in the last ${sinceSec}s.\n` +
        '  Whatever the Mind reported above, it did not call the relay.',
    );
    process.exit(1);
  }
} catch (err) {
  console.warn(`\n  (could not verify: ${errText(err)})`);
}
