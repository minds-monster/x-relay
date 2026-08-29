/**
 * Read-only inventory of what the Mind can actually call, and what the Bazaar offers.
 *
 * Written to answer one question: why does the Mind not see `vault_info` / `search_tweets`
 * by name? Tools come from APPS, not from skills — `BazaarApp` carries `tools[]` and
 * `toolCount`, `BazaarSkill` carries neither. This prints both sides so the distinction is
 * evidence rather than inference.
 *
 * Usage: npm run ops -- ops/probe-armory.ts [--search mcp]
 */
import { client, MIND_ID, errText } from './minds.ts';

const argv = process.argv.slice(2);
const searchTerm = argv[argv.indexOf('--search') + 1] || 'mcp';

try {
  const [skills, apps] = await Promise.all([
    client.listEquippedSkills(MIND_ID),
    client.listEquippedApps(MIND_ID),
  ]);

  console.log(`=== Equipped SKILLS (${skills.length}) ===`);
  for (const s of skills) {
    console.log(`  ${s.name ?? '(unnamed)'}  [${s.source ?? '?'}]  ${s.skillId}`);
    if (s.description) console.log(`      ${String(s.description).slice(0, 120)}`);
  }

  console.log(`\n=== Equipped APPS (${apps.length}) — these are what carry tools ===`);
  for (const a of apps) {
    console.log(`  ${a.appName ?? '(unnamed)'}  v${a.version ?? '?'}  ${a.appId}`);
  }

  // Per-app tool names only come back on the Bazaar detail route, not the equipped list.
  console.log('\n=== Tools per equipped app (from Bazaar detail) ===');
  for (const a of apps) {
    try {
      const detail = await client.bazaar.getApp(String(a.appId));
      const tools = (detail.tools ?? []) as Array<Record<string, unknown>>;
      const names = tools.map((t) => String(t.name ?? t.toolName ?? '?'));
      console.log(`  ${detail.appName} (${names.length}): ${names.join(', ') || '(none listed)'}`);
    } catch (err) {
      console.log(`  ${a.appName}: detail unavailable (${errText(err)})`);
    }
  }

  console.log(`\n=== Bazaar APPS matching "${searchTerm}" ===`);
  const found = await client.bazaar.listApps({ search: searchTerm, pageSize: 25 });
  console.log(`  ${found.totalCount} total`);
  for (const a of found.items) {
    console.log(
      `  ${a.appName}  tier=${a.tier ?? '?'}  auth=${a.authType ?? '?'}  tools=${a.toolCount ?? '?'}  ${a.appId}`,
    );
  }
} catch (err) {
  console.error(`Failed: ${errText(err)}`);
  process.exit(1);
}
