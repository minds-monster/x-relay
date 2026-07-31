/**
 * Step 0 — remove the ToS-hostile and broken X apps from the Mind.
 *
 *  - Twitter CLI  advertises "Bypasses official API keys using cookie auth" — a direct
 *                 breach of the X Developer Agreement, live on this Mind today.
 *  - Clawk        third-party-access shape we are deliberately architecting away from.
 *  - x-api        `approved: false`, no OAuth client bound. Broken for all ~109 equips,
 *                 and its presence creates tool-selection ambiguity for the Mind.
 *
 * Reversible: re-equip with client.equipApps(MIND_ID, { ids }).
 * Usage: npm run ops -- ops/unequip-x-apps.ts [--dry-run]
 */
import { client, MIND_ID, errText } from './minds.ts';

const TARGETS = [
  { id: 'A54FEF68-0808-F111-AD1D-0EA9A5017E89', name: 'x-api', why: 'approved:false, no OAuth client bound' },
  { id: 'C056F37E-9BFE-F011-AD1D-0EA9A5017E89', name: 'Clawk', why: 'third-party API access shape' },
  { id: '0745A254-CE1C-F111-AD1D-0EA9A5017E89', name: 'Twitter CLI', why: 'cookie auth — ToS breach' },
];

const dryRun = process.argv.includes('--dry-run');

const equipped = (await client.listEquippedApps(MIND_ID)) as Array<Record<string, unknown>>;
const equippedIds = new Set(
  equipped.map((a) => String(a.appId ?? '').toLowerCase()).filter(Boolean),
);

console.log(`Mind ${MIND_ID} has ${equipped.length} apps equipped.\n`);

const present = TARGETS.filter((t) => equippedIds.has(t.id.toLowerCase()));
const absent = TARGETS.filter((t) => !equippedIds.has(t.id.toLowerCase()));

for (const t of absent) console.log(`  already absent  ${t.name}`);
for (const t of present) console.log(`  will unequip    ${t.name}  — ${t.why}`);

if (present.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

if (dryRun) {
  console.log('\n--dry-run: no changes made.');
  process.exit(0);
}

try {
  await client.unequipApps(MIND_ID, { ids: present.map((t) => t.id) });
} catch (err) {
  console.error(`\nunequipApps failed: ${errText(err)}`);
  process.exit(1);
}

const after = (await client.listEquippedApps(MIND_ID)) as Array<Record<string, unknown>>;
const afterIds = new Set(after.map((a) => String(a.appId ?? '').toLowerCase()));
const stragglers = present.filter((t) => afterIds.has(t.id.toLowerCase()));

console.log(`\nUnequipped ${present.length - stragglers.length}/${present.length}.`);
console.log(`Apps equipped: ${equipped.length} -> ${after.length}`);

if (stragglers.length > 0) {
  console.error(`Still present: ${stragglers.map((t) => t.name).join(', ')}`);
  process.exit(1);
}
