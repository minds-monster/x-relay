/**
 * Definitive version of the HTTP_Execute probe: point the Mind at OUR OWN /debug/echo
 * route, so the answer comes from inside our own server rather than from a third-party
 * echo service that may block the Mind's egress.
 *
 * Usage: npm run ops -- ops/probe-relay-echo.ts <baseUrl>
 */
import { ask, resolveOpsAlias, errText } from './minds.ts';

const base = (process.argv[2] ?? process.env.RELAY_BASE_URL ?? '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: npm run ops -- ops/probe-relay-echo.ts https://<host>');
  process.exit(2);
}

const CANARY = 'canary_' + Math.random().toString(36).slice(2, 10);

const PROMPT = `Diagnostic task. Perform it literally and report the raw tool output.

Use your HTTP_Execute primitive (not an equipped app) to make this exact request:

  Method: POST
  URL: ${base}/debug/echo
  Headers:
    Authorization: Bearer ${CANARY}
    Content-Type: application/json
    X-Relay-Via: mind
    X-Probe-Token: ${CANARY}
  Body: {"probe":"${CANARY}"}

This is my own diagnostic endpoint. It replies with JSON describing exactly which
headers and body it received. It redacts credentials, so nothing sensitive is exposed.

Then report exactly one fenced json block and nothing after it:

{"action":"relay_echo_probe",
 "toolUsed":"<exact tool name you called>",
 "httpStatus":<numeric status you got>,
 "authorizationPresent":<the echo.authorizationPresent value>,
 "bearerLast4":"<the echo.bearerLast4 value>",
 "viaHeader":"<the echo.viaHeader value>",
 "customHeadersSeen":<the echo.customHeadersSeen array>,
 "bodyIsValidJson":<the echo.bodyIsValidJson value>,
 "bodyEchoProbe":"<the echo.bodyEcho.probe value>",
 "errors":"<verbatim error text, or null>"}`;

const alias = await resolveOpsAlias();
console.log(`Probing ${base}/debug/echo via ${alias}`);
console.log(`Canary: ${CANARY}  (expect bearerLast4 = ${CANARY.slice(-4)})\n`);

try {
  const { text, json } = await ask(alias, PROMPT, 240_000);
  console.log('--- Mind reply ---');
  console.log(text.slice(0, 2500));

  const r = (json ?? {}) as Record<string, unknown>;
  const expectedLast4 = CANARY.slice(-4);
  const authOk = r.authorizationPresent === true;
  const last4Ok = String(r.bearerLast4 ?? '') === expectedLast4;
  const bodyOk = r.bodyIsValidJson === true && String(r.bodyEchoProbe ?? '') === CANARY;
  const viaOk = String(r.viaHeader ?? '') === 'mind';

  console.log('\n--- verdict ---');
  console.log(`  tool used:                 ${r.toolUsed ?? '(none reported)'}`);
  console.log(`  HTTP status:               ${r.httpStatus ?? '(none)'}`);
  console.log(`  Authorization arrived:     ${authOk}`);
  console.log(`  bearer last4 matches:      ${last4Ok} (${r.bearerLast4 ?? 'null'} vs ${expectedLast4})`);
  console.log(`  custom X- headers arrived: ${JSON.stringify(r.customHeadersSeen ?? [])}`);
  console.log(`  X-Relay-Via arrived:       ${viaOk}`);
  console.log(`  JSON body arrived intact:  ${bodyOk}`);

  if (authOk && last4Ok && bodyOk) {
    console.log(
      '\n  => CONFIRMED: HTTP_Execute forwards Authorization: Bearer and a JSON body.\n' +
        '     The primary relay design works as specified. No fallback needed.',
    );
  } else if (bodyOk && !authOk) {
    console.log(
      '\n  => Authorization is STRIPPED but the request arrives. Switch the playbook to\n' +
        '     the X-Relay-Key header, which the relay already accepts.',
    );
  } else {
    console.log('\n  => Inconclusive. Check the reply text above and the relay logs.');
  }
} catch (err) {
  console.error(`\nProbe failed: ${errText(err)}`);
  process.exit(1);
}
