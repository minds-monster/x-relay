/**
 * The single load-bearing experiment.
 *
 * The whole relay design assumes the Minds `HTTP_Execute` primitive can send an
 * arbitrary `Authorization: Bearer ...` header to an arbitrary host with a JSON POST
 * body. None of that is documented anywhere, and some tool sandboxes strip or redact
 * Authorization specifically.
 *
 * This probes it without needing the relay to be publicly reachable, by asking the Mind
 * to call a public header-echo service and report verbatim what arrived. A canary token
 * is embedded so we can tell a real round-trip from the Mind hallucinating a plausible
 * response.
 *
 * Usage: npm run ops -- ops/probe-http-execute.ts
 */
import { ask, resolveOpsAlias, errText } from './minds.ts';

const CANARY = 'canary_' + Math.random().toString(36).slice(2, 10);

const PROMPT = `Diagnostic task. Please perform it literally and report raw output — do not summarise.

Use your HTTP_Execute primitive (NOT any equipped app) to make this exact request:

  Method: GET
  URL: https://httpbingo.org/headers
  Headers:
    Authorization: Bearer ${CANARY}
    X-Relay-Via: mind
    X-Probe-Token: ${CANARY}

That endpoint (httpbingo.org, a reliable httpbin reimplementation) echoes back the headers it received. I need to know exactly which of my
headers survived the trip.

Then also try this one, to check POST with a JSON body:

  Method: POST
  URL: https://httpbingo.org/post
  Headers:
    Authorization: Bearer ${CANARY}
    Content-Type: application/json
  Body: {"probe":"${CANARY}","n":1}

Report your findings as exactly one fenced json block, nothing after it:

{"action":"http_execute_probe",
 "toolUsed":"<the exact tool name you called>",
 "getSucceeded":true|false,
 "authorizationHeaderArrived":true|false,
 "authorizationValueSeen":"<the exact Authorization value echoed back, or null>",
 "customHeadersArrived":["<names of my X-* headers that echoed back>"],
 "postSucceeded":true|false,
 "jsonBodyArrived":true|false,
 "echoedProbeToken":"<the probe value echoed in the POST response, or null>",
 "errors":"<any error text verbatim, or null>"}

If HTTP_Execute is not available to you, say so explicitly in "errors" and set
toolUsed to null.`;

const alias = await resolveOpsAlias();
console.log(`Probing HTTP_Execute via ${alias}`);
console.log(`Canary: ${CANARY}\n`);

try {
  const { text, json } = await ask(alias, PROMPT, 240_000);

  console.log('--- Mind reply (text) ---');
  console.log(text.slice(0, 3000));
  console.log('\n--- parsed json block ---');
  console.log(json ? JSON.stringify(json, null, 2) : '(no fenced json block found)');

  if (json && typeof json === 'object') {
    const r = json as Record<string, unknown>;
    const authOk = r.authorizationHeaderArrived === true;
    const seen = String(r.authorizationValueSeen ?? '');
    // Only trust the result if the canary actually came back — otherwise the Mind may
    // be reporting a plausible answer rather than an observed one.
    const canaryProven = seen.includes(CANARY) || String(r.echoedProbeToken ?? '').includes(CANARY);

    console.log('\n--- verdict ---');
    console.log(`  tool used:                 ${r.toolUsed ?? '(none)'}`);
    console.log(`  Authorization survived:    ${authOk}`);
    console.log(`  canary proven end-to-end:  ${canaryProven}`);
    console.log(`  JSON POST body survived:   ${r.jsonBodyArrived === true}`);

    if (authOk && canaryProven) {
      console.log('\n  => Bearer auth over HTTP_Execute WORKS. Use the primary design.');
    } else if (canaryProven) {
      console.log(
        '\n  => Round-trip works but Authorization did NOT survive.\n' +
          '     Fall back to the X-Relay-Key header (already supported by the relay).',
      );
    } else {
      console.log(
        '\n  => Unproven. The canary did not come back, so treat this reply as\n' +
          '     unverified rather than as evidence either way. Re-run, or test\n' +
          '     against the deployed relay and read the audit table.',
      );
    }
  }
} catch (err) {
  console.error(`\nProbe failed: ${errText(err)}`);
  process.exit(1);
}
