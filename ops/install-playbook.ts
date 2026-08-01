/**
 * Install the X Relay contract onto the Mind.
 *
 * Delivery mechanism, and why: there is no skill-creation or tenet-write route in the
 * Builder API (`minds-client-lib` exposes only equip/unequip, messaging, circles, mind
 * status and read-only bazaar). So the verified path is to send the playbook as a
 * message and ask the Mind to LTM_Push it, which is what makes it survive conversation
 * truncation.
 *
 * CREDENTIAL CAVEAT: because tenets are not writable from here, the relay key has to
 * transit the conversation in v1. Treat any key installed this way as exposed and
 * rotate it once a durable secret store is available:
 *     curl -XPOST $BASE/admin/users/<id>/rotate-key -H "X-Admin-Key: ..."
 *
 * Two contracts exist and they are not interchangeable:
 *
 *   x-relay-v1   the full posting contract. For a Mind that should post directly, on
 *                demand. Knows /x/post, approval pages, retraction.
 *   x-queue-v1   the content contract. For a Mind whose only job is to write. Knows
 *                /x/queue and nothing else — it cannot post, cannot pick a time, and
 *                cannot retract. This is what dedicated content Minds get.
 *
 * Giving a content Mind the full contract would hand it a posting primitive it has no
 * reason to hold, so the playbook is an explicit argument rather than a default.
 *
 * Usage:
 *   npm run ops -- ops/install-playbook.ts <baseUrl> <relayKey> [options]
 *
 *     --playbook <name|path>   x-relay-v1 (default) | x-queue-v1 | ./path/to.md
 *     --alias <alias>          conversation to install into
 *     --dry-run                print what would be sent, key redacted
 */
import { readFile } from 'node:fs/promises';
import { ask, resolveOpsAlias, errText } from './minds.ts';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');

function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const positional = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return !(prev === '--playbook' || prev === '--alias');
});

const base = (positional[0] ?? '').replace(/\/$/, '');
const relayKey = positional[1] ?? '';

if (!base || !relayKey) {
  console.error(
    'Usage: npm run ops -- ops/install-playbook.ts <baseUrl> <relayKey> ' +
      '[--playbook x-relay-v1|x-queue-v1|<path>] [--alias <alias>] [--dry-run]',
  );
  process.exit(2);
}

const playbookArg = opt('playbook') ?? 'x-relay-v1';
const playbookUrl = playbookArg.includes('/')
  ? new URL(playbookArg, `file://${process.cwd()}/`)
  : new URL(`../playbooks/${playbookArg}.md`, import.meta.url);

let template: string;
try {
  template = await readFile(playbookUrl, 'utf8');
} catch {
  console.error(`No such playbook: ${playbookUrl.pathname}`);
  console.error('Known playbooks: x-relay-v1 (full posting), x-queue-v1 (content only)');
  process.exit(2);
}

// The playbook refers to the key symbolically. Until tenets are writable we must also
// supply the literal value, kept in a clearly-delimited block so it is obvious what
// entered the transcript.
const playbook =
  template.replaceAll('{{RELAY_BASE_URL}}', base) +
  `
KEY MATERIAL (v1 delivery — no tenet write API exists yet)
  Until this key lives in tenets.apiKeys.X_RELAY_KEY, use this literal value as the
  bearer token for every relay call. Treat it as a secret: never echo it back, never
  include it in a reply, an artifact, or a skill body.

  X_RELAY_KEY = ${relayKey}
`;

console.log(`Base URL : ${base}`);
console.log(`Relay key: ${relayKey.slice(0, 12)}... (${relayKey.length} chars)`);
console.log(`Playbook : ${playbookArg} (${playbook.length} chars)\n`);

if (dryRun) {
  console.log('--- playbook that WOULD be sent (key redacted) ---\n');
  console.log(playbook.replace(relayKey, '<REDACTED>'));
  console.log('\n--dry-run: nothing sent.');
  process.exit(0);
}

console.warn(
  'WARNING: the relay key will be written into the Mind conversation transcript.\n' +
    '         Rotate it before this setup handles anything you care about.\n',
);

const alias = await resolveOpsAlias(opt('alias'));
console.log(`Sending playbook to ${alias} ...`);

try {
  const { text, json } = await ask(alias, playbook, 240_000);

  console.log('\n--- Mind reply ---');
  console.log(text.slice(0, 2000));

  const r = (json ?? {}) as Record<string, unknown>;
  const stored = r.action === 'contract_stored';
  const last4 = String(r.keyLast4 ?? '');
  const keyOk = last4 === relayKey.slice(-4);

  console.log('\n--- verdict ---');
  console.log(`  contract stored in LTM:  ${stored} (ltmKey=${r.ltmKey ?? 'none'})`);
  console.log(`  relay key present:       ${r.relayKeyPresent === true}`);
  console.log(`  key last4 matches:       ${keyOk}`);
  console.log(`  base url acknowledged:   ${String(r.baseUrl ?? '') === base}`);

  if (!stored) {
    console.log(
      '\n  Note: the Mind did not confirm an LTM_Push. The contract still applies for\n' +
        '  this conversation, but may not survive truncation — re-run per session, or\n' +
        '  verify with: npx @animocabrands/minds-cli history ' + alias,
    );
  }
} catch (err) {
  console.error(`\nInstall failed: ${errText(err)}`);
  process.exit(1);
}
