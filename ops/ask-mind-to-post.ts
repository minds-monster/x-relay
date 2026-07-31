/**
 * Drive a post through the Mind, so the whole chain is exercised:
 *   ops -> sendMessage -> Mind -> HTTP_Execute -> relay -> guardrails -> X
 *
 * Verify afterwards with:
 *   npx wrangler d1 execute x-relay --local --command \
 *     "SELECT via, code, http_status FROM audit ORDER BY id DESC LIMIT 5"
 * `via='mind'` is what distinguishes a genuine Mind-driven call from a curl.
 *
 * Usage:
 *   npm run ops -- ops/ask-mind-to-post.ts "text to post" [--dry-run] [--status]
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

const today = new Date().toISOString().slice(0, 10);

const PROMPT = statusOnly
  ? `Using the X_RELAY contract, call GET {base}/x/me and report the result.

Reply with exactly one fenced json block and nothing after it:
{"action":"relay_status","httpStatus":<n>,"ok":<bool>,"status":"<status>",
 "xHandle":<string|null>,"postsToday":<n>,"dailyCap":<n>,
 "requireApproval":<bool>,"errorCode":<string|null>,"raw":"<verbatim response body>"}`
  : `Using the X_RELAY contract, post this to X exactly as written — do not rewrite,
embellish, add hashtags, or change the wording:

${text}

Use idempotencyKey "manual-${today}-${Math.abs(hashCode(text)).toString(36)}".
${dryRun ? 'Set "dryRun": true so nothing is actually posted.' : ''}

Follow the contract's rules exactly. If you get a 202, report the draft and approveUrl
and STOP — do not claim it is live. If you get an error, report the error code verbatim
and follow the contract's instruction for that code.

Reply with exactly one fenced json block and nothing after it:
{"action":"relay_post","httpStatus":<n>,"outcome":"posted|pending_approval|idempotent|error|dry_run",
 "tweetId":<string|null>,"url":<string|null>,"draftId":<string|null>,
 "approveUrl":<string|null>,"errorCode":<string|null>,
 "whatIDidNext":"<one sentence>","raw":"<verbatim response body>"}`;

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

const alias = await resolveOpsAlias();
console.log(`Asking ${alias} to ${statusOnly ? 'report relay status' : dryRun ? 'dry-run a post' : 'post'}...\n`);

try {
  const { text: reply, json } = await ask(alias, PROMPT, 240_000);
  console.log('--- Mind reply ---');
  console.log(reply.slice(0, 2500));

  if (json) {
    console.log('\n--- parsed ---');
    console.log(JSON.stringify(json, null, 2));
    const r = json as Record<string, unknown>;
    if (r.outcome === 'posted' && r.url) console.log(`\n  LIVE: ${r.url}`);
    if (r.outcome === 'pending_approval') console.log(`\n  AWAITING APPROVAL: ${r.approveUrl}`);
    if (r.errorCode) console.log(`\n  error code: ${r.errorCode}`);
  } else {
    console.log('\n(no json block parsed — read the reply text above)');
  }
} catch (err) {
  console.error(`\nFailed: ${errText(err)}`);
  process.exit(1);
}
