/**
 * Install the adam-id vault contract onto the Mind.
 *
 * Separate from install-playbook.ts because the vault needs THREE secrets, not one —
 * the SD-JWT credential plus a Cloudflare Access service token pair — and it verifies a
 * different acknowledgement shape. Folding both into one installer would mean a script
 * that silently injects the wrong key material for whichever contract it was not written
 * for.
 *
 * CREDENTIAL CAVEAT, unchanged from v1 and worse here: there is no tenet-write route in
 * the Builder API, so all three secrets transit the conversation transcript and are
 * persisted by the Mind via LTM_Push. Anyone who can read that transcript has read access
 * to the archive until the credential expires. That is why the credential is minted with a
 * 24h expiry and why `vault revoke` exists. Rotate the service token from the Cloudflare
 * dashboard if a transcript is ever exposed.
 *
 * Usage:
 *   npm run ops -- ops/install-vault-playbook.ts \
 *     --credential <sd-jwt> --cf-id <id> --cf-secret <secret> \
 *     [--mind adam|beta|trend] [--alias <alias>] [--dry-run]
 *
 * --mind defaults to adam. It must match the Mind the credential was minted for, and the
 * alias must be a conversation belonging to that Mind — both are checked before sending,
 * because the failure they prevent (a live credential written into another Mind's
 * transcript) is silent and looks like success.
 *
 * Defaults to --dry-run being OFF, but PRINT FIRST. Run it with --dry-run once and read
 * what would be sent before sending anything.
 */
import { readFile } from 'node:fs/promises';
import { ask, resolveOpsAlias, resolveMindId, mindName, MIND_ID, errText } from './minds.ts';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');

function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Prefer a file or an env var over an argv flag.
 *
 * A secret passed as `--credential <value>` lands in the process list, in shell history,
 * and — because this runs under `npm run` — is echoed to stdout by npm before the script
 * even starts. `--credential-file` avoids all three.
 */
async function secret(name: string, envVar: string): Promise<string> {
  const file = opt(`${name}-file`);
  if (file) return (await readFile(file, 'utf8')).trim();
  const inline = opt(name);
  if (inline) return inline;
  return (process.env[envVar] ?? '').trim();
}

const credential = await secret('credential', 'ADAM_ID_VC');
const cfId = await secret('cf-id', 'CF_ACCESS_CLIENT_ID');
const cfSecret = await secret('cf-secret', 'CF_ACCESS_CLIENT_SECRET');
const playbookArg = opt('playbook') ?? 'adam-id-vault-v3';

if (!credential || !cfId || !cfSecret) {
  console.error(
    'Usage: npm run ops -- ops/install-vault-playbook.ts \\\n' +
      '         --credential-file <path> --cf-id <id> --cf-secret-file <path> \\\n' +
      '         [--alias <alias>] [--dry-run]\n\n' +
      'Each secret may also come from the environment:\n' +
      '  ADAM_ID_VC, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET\n\n' +
      'Inline --credential/--cf-secret still work but put the secret in the process list\n' +
      'and in npm\'s echoed command line. Prefer a file or the environment.',
  );
  process.exit(2);
}

// Fail early on a credential that is already expired or malformed — sending one is a
// wasted round trip that teaches the Mind an error path instead of the contract.
let credentialMindId: string | undefined;
let credentialScopes: string[] = [];
try {
  const payload = JSON.parse(
    Buffer.from(credential.split('~')[0]!.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { exp?: number; mind_id?: string; scopes?: string[]; iss?: string };
  const expiresIn = (payload.exp ?? 0) * 1000 - Date.now();
  if (expiresIn <= 0) {
    console.error(`Credential expired ${Math.round(-expiresIn / 60000)} minutes ago. Re-mint first.`);
    process.exit(2);
  }
  credentialMindId = payload.mind_id;
  credentialScopes = payload.scopes ?? [];
  console.log(
    `Credential : mind=${payload.mind_id ? mindName(payload.mind_id) : '?'} (${payload.mind_id})`,
  );
  console.log(`             scopes=[${credentialScopes.join(' ')}]`);
  console.log(`             iss=${payload.iss} expires in ${Math.round(expiresIn / 60000)} min`);
} catch {
  console.error('Could not decode the credential — is it the full SD-JWT including trailing ~ ?');
  process.exit(2);
}

const playbookUrl = playbookArg.includes('/')
  ? new URL(playbookArg, `file://${process.cwd()}/`)
  : new URL(`../playbooks/${playbookArg}.md`, import.meta.url);

let template: string;
try {
  template = await readFile(playbookUrl, 'utf8');
} catch {
  console.error(`No such playbook: ${playbookUrl.pathname}`);
  process.exit(2);
}

// The playbook names the secrets symbolically. Until tenets are writable the literal
// values have to follow, in a clearly delimited block so it is obvious exactly what
// entered the transcript.
const playbook =
  template +
  `
KEY MATERIAL (v1 delivery — no tenet write API exists yet)
  Until these live in tenets.apiKeys.*, use these literal values on every vault call.
  Treat all three as secrets: never echo them, never include them in a reply, an
  artifact, or a skill body.

  ADAM_ID_VC        = ${credential}
  ADAM_ID_CF_ID     = ${cfId}
  ADAM_ID_CF_SECRET = ${cfSecret}
`;

console.log(`Playbook   : ${playbookArg} (${playbook.length} chars)`);
console.log(`CF token   : ${cfId}\n`);

if (dryRun) {
  console.log('--- playbook that WOULD be sent (secrets redacted) ---\n');
  console.log(
    playbook
      .replace(credential, '<CREDENTIAL REDACTED>')
      .replace(cfSecret, '<CF_SECRET REDACTED>'),
  );
  console.log('\n--dry-run: nothing sent.');
  process.exit(0);
}

console.warn(
  'WARNING: the credential and the Cloudflare service token will be written into the\n' +
    '         Mind conversation transcript and persisted to its long-term memory.\n' +
    '         The credential expires within 24h by design. `vault revoke --mind <id>`\n' +
    '         cuts access immediately if the transcript is ever exposed.\n',
);

// The credential is minted for one Mind: the vault matches its `mind_id` claim against
// the local grant table. Sending it to a different Mind cannot work and puts a live
// credential in a transcript that was never supposed to hold one, so the target is
// checked against the credential before anything is sent.
const targetMind = resolveMindId(opt('mind')) ?? MIND_ID;
if (credentialMindId && credentialMindId.toLowerCase() !== targetMind.toLowerCase()) {
  console.error(
    `Credential is minted for ${mindName(credentialMindId)} (${credentialMindId})\n` +
      `but this run targets ${mindName(targetMind)} (${targetMind}).\n\n` +
      `Re-mint for ${mindName(targetMind)}, or pass --mind ${mindName(credentialMindId)}.`,
  );
  process.exit(2);
}

const alias = await resolveOpsAlias(opt('alias'), targetMind);
console.log(`Sending vault playbook to ${mindName(targetMind)} via ${alias} ...`);

try {
  const { text, json } = await ask(alias, playbook, 240_000);

  console.log('\n--- Mind reply ---');
  console.log(text.slice(0, 2000));

  const r = (json ?? {}) as Record<string, unknown>;

  // Check the version too. A Mind that still has v1 in long-term memory can acknowledge
  // from that memory instead of from what we just sent, and the old shape would pass a
  // check that only looked at `playbook` and `stored` — the install would read as
  // successful while the Mind kept the directive we were trying to replace.
  const expectedVersion = Number(template.match(/ADAM_ID_VAULT v(\d+)/)?.[1] ?? 0);
  const ok =
    r.ok === true &&
    r.playbook === 'ADAM_ID_VAULT' &&
    r.stored === true &&
    Number(r.version) === expectedVersion;

  console.log('\n--- verdict ---');
  console.log(
    `  contract acknowledged: ${ok} (playbook=${r.playbook ?? 'none'} v${r.version ?? '?'}, expected v${expectedVersion})`,
  );
  if (r.playbook === 'ADAM_ID_VAULT' && Number(r.version) !== expectedVersion) {
    console.log(`  ⚠ acknowledged v${r.version} but sent v${expectedVersion} — likely replaying old memory.`);
  }
  if (!ok) {
    console.log('  The Mind did not return the expected acknowledgement. It may still have');
    console.log('  stored the contract — check by asking it to call vault_info.');
  }

  // The one thing that must never appear in the reply.
  const leaked = text.includes(credential.slice(0, 40)) || text.includes(cfSecret);
  console.log(`  secrets absent from reply: ${!leaked}`);
  if (leaked) console.log('  ⚠ the Mind echoed key material back — rotate it now.');

  process.exit(ok && !leaked ? 0 : 1);
} catch (err) {
  console.error(`\nFailed: ${errText(err)}`);
  process.exit(1);
}
