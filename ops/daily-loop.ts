/**
 * The content loop. Runs locally (launchd / cron), not on the Worker, for two reasons:
 * it needs the account-admin builder JWT, which must never reach the edge, and
 * waitForReply holds an SSE stream for minutes, which is hostile to Worker limits.
 *
 * The Worker's own cron handles only token health — a short, credential-light job that
 * genuinely belongs at the edge.
 *
 * Flow: check cognition balance -> ask the Mind to draft and post -> report outcome.
 * With require_approval on (the default), "post" means "park a draft and hand back an
 * approval link", so this loop is safe to run unattended before you trust the output.
 *
 * Usage:
 *   npm run ops -- ops/daily-loop.ts [--dry-run] [--topic "..."]
 *
 * Schedule with launchd, e.g. ~/Library/LaunchAgents/dev.xrelay.daily.plist calling:
 *   /bin/sh -lc 'cd /Users/adamplace/adam-mind && npm run ops -- ops/daily-loop.ts'
 */
import { ask, client, MIND_ID, resolveOpsAlias, errText } from './minds.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const topicIdx = args.indexOf('--topic');
const topic =
  topicIdx >= 0 ? args[topicIdx + 1] : 'agent analytics — how sites detect and serve AI agents';

/** Stop before spending the last of the platform credits on a routine loop. */
const MIN_COGNITION_BALANCE = 1;

/**
 * Server-side truth check. A Mind will sometimes answer from conversation context rather
 * than actually calling the relay — observed in testing, where a dry run reported a 202
 * and an approveUrl belonging to an earlier request while the audit log showed no
 * matching row. So the loop's success criterion is an audit entry, not the Mind's word.
 */
async function verifyAgainstRelay(
  baseUrl: string,
  adminKey: string,
  userId: string,
  sinceSec: number,
): Promise<{ reached: boolean; rows: Array<Record<string, unknown>> }> {
  const res = await fetch(
    `${baseUrl}/admin/users/${encodeURIComponent(userId)}/recent?sinceSec=${sinceSec}`,
    { headers: { 'x-admin-key': adminKey } },
  );
  if (!res.ok) {
    console.warn(`  (could not verify: relay returned ${res.status})`);
    return { reached: false, rows: [] };
  }
  const body = (await res.json()) as { audit?: Array<Record<string, unknown>> };
  const rows = (body.audit ?? []).filter((r) => String(r.route) === 'x/post');
  return { reached: rows.length > 0, rows };
}

const today = new Date().toISOString().slice(0, 10);

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
    // Never let an unrecognised balance shape block the loop entirely.
    console.warn(`Could not read cognition balance (${errText(err)}); continuing.`);
    return true;
  }
}

const PROMPT = `Daily X post for ${today}.

Topic: ${topic}

Write ONE post for X. Constraints:
  - 280 characters maximum, ideally under 240.
  - No hashtags. No emoji. No "thread below". No engagement bait.
  - One concrete idea, stated plainly. Prefer a specific observation over a general claim.
  - No links — a post containing a URL costs $0.200 instead of $0.015, so leave links out
    unless I have explicitly asked for one.

Then post it using the X_RELAY contract with idempotencyKey "daily-${today}".
${dryRun ? 'Set "dryRun": true — validate only, post nothing.' : ''}

Follow the contract exactly. On a 202, report the draft and approveUrl and STOP; do not
claim it is live. On an error, report the code verbatim and follow the contract for it.

Reply with exactly one fenced json block and nothing after it:
{"action":"daily_post","draftText":"<the text you wrote>","chars":<n>,
 "httpStatus":<n>,"outcome":"posted|pending_approval|idempotent|error|dry_run",
 "url":<string|null>,"draftId":<string|null>,"approveUrl":<string|null>,
 "errorCode":<string|null>}`;

const startedAt = Date.now();

if (!(await cognitionOk())) process.exit(0);

const alias = await resolveOpsAlias();
console.log(`[${new Date().toISOString()}] daily-loop -> ${alias}${dryRun ? ' (dry run)' : ''}`);

try {
  const { text, json } = await ask(alias, PROMPT, 300_000);
  const r = (json ?? {}) as Record<string, unknown>;

  if (!json) {
    console.log('--- Mind reply (unparsed) ---');
    console.log(text.slice(0, 2000));
    process.exit(1);
  }

  console.log(`\n  draft   : ${r.draftText ?? '(none)'}`);
  console.log(`  chars   : ${r.chars ?? '?'}`);
  console.log(`  outcome : ${r.outcome ?? '?'} (http ${r.httpStatus ?? '?'})`);

  switch (r.outcome) {
    case 'posted':
      console.log(`  LIVE    : ${r.url}`);
      break;
    case 'pending_approval':
      console.log(`  APPROVE : ${r.approveUrl}`);
      break;
    case 'idempotent':
      console.log('  already posted today — nothing to do');
      break;
    case 'dry_run':
      console.log('  dry run — nothing posted');
      break;
    default:
      console.error(`  ERROR   : ${r.errorCode ?? 'unknown'}`);
      process.exit(1);
  }

  // Cross-check the Mind's claim against the relay's own record.
  const baseUrl = process.env.RELAY_BASE_URL;
  const adminKey = process.env.ADMIN_KEY;
  const userId = process.env.RELAY_USER_ID ?? 'adam';
  if (baseUrl && adminKey) {
    const elapsed = Math.ceil((Date.now() - startedAt) / 1000) + 60;
    const { reached, rows } = await verifyAgainstRelay(baseUrl, adminKey, userId, elapsed);
    console.log(`\n  verified: ${reached ? 'relay recorded the call' : 'NO matching relay call'}`);
    for (const row of rows.slice(0, 3)) {
      console.log(`    via=${row.via} code=${row.code} status=${row.http_status}`);
    }
    if (!reached) {
      console.error(
        '  The Mind reported an outcome the relay never saw — it likely answered from\n' +
          '  conversation context instead of calling. Treat this run as NOT executed.',
      );
      process.exit(1);
    }
  } else {
    console.log('\n  (set RELAY_BASE_URL and ADMIN_KEY in .env to verify server-side)');
  }
} catch (err) {
  console.error(`daily-loop failed: ${errText(err)}`);
  process.exit(1);
}
