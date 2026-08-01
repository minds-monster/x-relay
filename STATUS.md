# X Relay — status & handover

Single entry point for anyone (human or agent) picking this up. Written 2026-08-01.

[README.md](README.md) has architecture detail and the API table.
[TESTING.md](TESTING.md) has the 28-step test walkthrough.

---

## 1. What this is, in one paragraph

A **ToS-compliant X (Twitter) posting connector for the Animoca Hello Minds ecosystem.**
Animoca's own `x-api` app cannot post — it is `approved: false` with no OAuth client bound,
returns `401 No OAuth client bound to this app`, is broken for all ~109 Minds equipped to
it, and there is no builder-side fix. So we built a replacement: a Cloudflare Worker
("the relay") that holds X OAuth tokens and posts on the account owner's behalf. The Mind
calls it over HTTP using its `HTTP_Execute` primitive.

**It works end to end today.** A real tweet has been posted, both by direct call and via
the Mind. It is not deployed — it runs locally behind an ngrok tunnel.

---

## 2. Status at a glance

| Thing | State |
|---|---|
| Relay code | Complete, 28 unit tests passing, typechecks clean |
| Real tweet posted | **Yes** — via curl, via approval page, and via the Mind |
| X account connected | **Yes** — `@adamunerate` (`1517949596118487043`), status `active` |
| Deployed to Cloudflare | **No** — blocked on interactive `wrangler login` |
| Runs unattended | **No** — dies when the laptop sleeps or a terminal closes |
| Multiple posts/day | **No** — blocked by a one-post-per-day idempotency key (§7.2) |
| Crypto (x402) metering | Seam built, deliberately inert |
| Git | 5 commits on `main`, all work committed, nothing pushed to a remote |

**Money spent so far: $0.06** (4 posts at $0.015). Cognition balance ~590.

---

## 3. Identifiers and constants

```
Mind ID          240b453e-f36b-1410-8466-00039ce7df11   ("Adam", adam@hellominds.ai)
Second Mind      fb12453e-f36b-1410-8466-00039ce7df11   ("Beta", unused)
Minds API base   https://api.build.hellominds.ai        (auth header: X-Api-Key)
SDK              @animocabrands/minds-cli@0.1.3 · @animocabrands/minds-client-lib@0.1.3
X handle         @adamunerate  (X user id 1517949596118487043)
Relay user id    adam          (single-tenant today)
Tunnel           https://unsurmised-duke-homy.ngrok-free.dev  (stable per ngrok account)
Operator TZ      UTC+8 — matters, see §7.3
```

**Conversation aliases** (arbitrary aliases work; no `webapp:` prefix needed):

| Alias | Purpose |
|---|---|
| `relay:x-ops` | Where the playbook/contract was installed. Used by `ask-mind-to-post.ts`. |
| `relay:x-daily-<date>` | Per-day content generation. Created automatically. |
| `webapp:thread-1785477354652-a9tmbv` | Original human thread in the Minds web app |
| `relay:x-daily-20260731` | Stale artifact of a manual test; ignore or delete |

---

## 4. Current live parameters

From `sh ops/relay.sh user`:

```
status              active
requireApproval     true          <- nothing publishes without a human click
dailyCap            10            <- ROLLING 24h window, not a calendar day
minIntervalSec      600           <- 10 minutes between posts
budgetUsdMonth      5.00          <- hard stop; raise before scaling spend
spendUsdMonth       0.06
clientType          confidential
redirectUri         http://127.0.0.1:8787/x/oauth/callback
```

Change any of these with `sh ops/relay.sh set '{"dailyCap":20}'`.

**Worker vars** (`wrangler.jsonc`): `PAYMENTS_ENABLED=false`, `RELAY_VERSION=0.1.0`,
`RELAY_BASE_URL` (currently the ngrok URL — this is the **public** URL used to build OAuth
and approval links).

**Secrets** live in `.dev.vars` (gitignored): `MASTER_KEY_B64`, `ADMIN_KEY`,
`APPROVAL_HMAC_KEY`. Optional `MASTER_KEY_B64_PREV` for rotation.
`.env` (gitignored) holds `MINDS_BUILDER_API_KEY` plus `RELAY_BASE_URL`, `ADMIN_KEY`,
`RELAY_USER_ID` for the ops scripts. `.relay-key` (gitignored) holds the bearer key.

---

## 5. The three constraints that shaped everything

Understand these before changing anything, because each one is load-bearing.

### 5.1 X's Developer Agreement forbids the obvious design

The original request was: one business X API account, users top up crypto, everyone posts
through it. That is **explicitly prohibited**:

- **III.A(e)** — no providing the API "on a service bureau, rental or managed services
  basis", and no sharing credentials.
- **III.A(d)** — no selling, sublicensing or providing API access to third parties.
- **III.B / III.L / III.M** — self-serve tiers are scoped to hobbyist/prototyping;
  commercial multi-tenant needs Enterprise.

X terminates the **developer account**, not just the app. So the design is **BYO
credentials per user**: each user registers their own X app and authorizes in their own
browser. Crypto billing is still fine — but what gets metered must be *this relay's
service*, never X API access.

**If this ever serves anyone besides the operator, ship it as software they self-host —
their Worker, their account, their secrets — or move to X Enterprise.** The design is
already self-hostable; keep it that way.

### 5.2 X's free tier is gone (Feb 2026)

Pay-per-use only, prepaid credits:

| Action | Cost |
|---|---|
| Create post | **$0.015** |
| Create post **containing a URL** | **$0.200** (13×) |
| Read a post | $0.005 |
| Read your own data | $0.001 |

Posting needs OAuth 2.0 Authorization Code + PKCE **user context**, scopes
`tweet.read tweet.write users.read offline.access`. App-only bearer cannot post.

### 5.3 The Minds platform has no app/skill/secret write API

`minds-client-lib@0.1.3` exposes only equip/unequip, messaging, circles, mind status, and
read-only bazaar. `/v1/bazaar/apps` is GET-only. There is **no** route to create an app,
author a skill, or write a tenet. Consequences:

- The connector cannot be a Bazaar app. It is an external HTTP service.
- The Mind learns the contract by being **sent a message** which it stores via `LTM_Push`.
- **The relay key has to transit the conversation transcript.** There is no secret store to
  put it in. Rotate after installing (§7.6).

---

## 6. What is verified, and what is not

### Verified live

- **`HTTP_Execute` forwards `Authorization: Bearer`, custom `X-*` headers, and an intact
  JSON POST body.** Proven with a canary echoed back through `/debug/echo` at HTTP 200.
  This was the single load-bearing unknown.
- **Arbitrary conversation aliases work** (`relay:x-ops` accepted).
- **LTM crosses conversations.** The contract *and* the relay key installed in
  `relay:x-ops` were usable from a different thread in the Minds web app. So the app can
  drive the relay today.
- **A real tweet posts** — direct, via approval page, and Mind-driven (`via='mind'`).
- **Idempotency holds**: an identical repeat returns the same tweet id and creates no
  second tweet.
- **Tokens are encrypted at rest** — grepped every `.wrangler` state file for the client
  secret, relay key and tokens; zero plaintext.
- **Refresh rotation persists** — two consecutive refreshes both succeed.
- **Guardrails fire**: `url_not_allowed`, `text_too_long`, `daily_cap_reached`,
  `duplicate_recent_text`, `min_interval_not_elapsed`.
- **Approval links are HMAC-signed** — tampering yields 403.

### Not verified

- **Remote deploy.** Needs interactive `wrangler login`. `wrangler.jsonc` has placeholder
  binding IDs (`local-placeholder-d1` / `local-placeholder-pkce`) that work for local dev
  only.
- **The 15-minute cron sweep.** Local `wrangler dev` does not fire cron triggers. Token
  refresh currently happens lazily at post time (which works). The proactive sweep is
  untested in practice.
- **Tenet writes / Mind-authored skills.** No API exists; both remain experiments. Note
  Mind-authored skills appear to publish to the public Bazaar — so a key must **never** go
  in a skill body.
- **x402 payment verification.** Middleware exists and fails closed.
- **Multi-user anything.** Schema supports it; only `adam` exists.

---

## 7. Outstanding threads

Roughly in the order they should be tackled.

### 7.1 Deploy to Cloudflare (highest value)

Everything else is fragile until this is done. Currently the relay lives on a laptop behind
a tunnel: sleep the Mac or close a terminal and the Mind gets a dead URL.

```bash
npx wrangler login                       # interactive — a human must do this
npx wrangler d1 create x-relay           # paste database_id into wrangler.jsonc
npx wrangler kv namespace create PKCE    # paste id into wrangler.jsonc
npx wrangler d1 execute x-relay --remote --file=schema.sql
npx wrangler secret put MASTER_KEY_B64   # and ADMIN_KEY, APPROVAL_HMAC_KEY
npx wrangler deploy
```

Then: set `RELAY_BASE_URL` to the workers.dev origin, add
`https://<origin>/x/oauth/callback` to the X app's callback list, re-run OAuth, re-provision
the user (remote D1 starts empty), and re-install the playbook. The cron sweep starts
working automatically once deployed.

### 7.2 Multiple posts per day — blocked by design, needs a change

`ops/daily-loop.ts` uses `idempotencyKey: daily-<UTC date>`. A second run the same day
returns "already posted today" instead of posting. To support N posts/day:

- Per-slot idempotency keys (`daily-2026-08-01-slot2`, or a time bucket).
- Per-slot conversation aliases, or replay will recur on runs 2+ (§8.5).
- Raise `dailyCap` / lower `minIntervalSec` to match.
- Scheduling: nothing schedules anything today. Needs launchd/cron entries per slot.

### 7.3 Two conflicting definitions of "day"

The daily cap is a **rolling 24h window**; the idempotency key is the **UTC calendar date**.
The operator is UTC+8, so the key rolls at 08:00 local — not local midnight, and not aligned
with the cap. Invisible at one post/day; confusing the moment slots exist. Make it
timezone-aware or slot-based when doing §7.2.

### 7.4 Content quality — the real lever is input, not prompting

Current drafts are competent but samey (every one was "here's an agent signal nobody
tracks"), because the Mind is handed a topic string and free-associates. Options, in rough
order of impact:

- **Ground it in fresh material.** The Mind already has `SEARCH_X`, `SEARCH_Web`,
  `Firecrawl_Suite`, `DeepResearch` available.
- **Rotate post *shapes*** (contrarian, concrete number, question, correction) per slot,
  not just topics.
- **Feed it first-party data** — the most differentiated content available.
- **Pass the last N posts in** as "don't repeat these angles". The relay blocks exact
  duplicates for 7 days but not thematic repetition.
- The original plan named an `Atomic Content Engine` skill (`461c503e-f36b-1410-8462-00039ce7df11`)
  that was never equipped — worth evaluating before writing custom prompt logic.

### 7.5 x402 crypto metering (phase 2)

`worker/lib/paywall.ts` is inert while `PAYMENTS_ENABLED=false`. Turning it on returns a 402
challenge the Mind side already understands — `x402_Agent_Payment_Protocol`
(`b0410937-a313-f111-ad1d-0ea9a5017e89`) and `Corbits_AgentPaymentBuyer` sign EIP-3009 via
`WALLET_Sign` and retry with `X-PAYMENT`. **Verification is not implemented**, so it
currently rejects even paid requests. Needs facilitator integration. Enabling it requires
no change to the Mind-facing contract.

Two distinct meanings of HTTP 402 in this codebase, deliberately kept apart:
`relay_payment_required` = x402; `x_credits_exhausted` = the user's X credits ran out.

### 7.6 Housekeeping

- **Rotate the relay key** — it is in the `relay:x-ops` transcript and in LTM.
  `sh ops/relay.sh rotate`, then re-run `install-playbook.ts` within the 24h grace window.
- **Disable the diagnostic echo route** once `HTTP_Execute` behaviour is settled:
  `DEBUG_ECHO_ENABLED=false`. It is unauthenticated by necessity (it measures auth
  handling) and redacts credentials, but it should not stay open in production.
- **No git remote.** Nothing is pushed anywhere. `.env`, `.dev.vars` and `.relay-key` are
  gitignored; verified `.env` was never committed.
- Delete the stale `relay:x-daily-20260731` conversation.
- `redirectUri` on the user record is still the localhost callback; update on deploy.

---

## 8. Landmines — read before editing

These are non-obvious and each one was either a real bug or a near-miss.

### 8.1 Refresh-token rotation (`worker/lib/tokens.ts`)

X issues a new refresh token on **every** refresh and invalidates the old one immediately.
Therefore: the new pair is persisted **before** use; one prior generation is kept in
`tokens_prev_enc` for torn-write recovery; and refreshes are serialised with a
compare-and-swap lock on the user row, because the cron sweep and a concurrent `/x/post`
would otherwise each burn a token the other needs.

**Transient failures (429/5xx) must never clear tokens** — only a genuine `invalid_grant`
does. Clearing on a transient error turns a 30-second X outage into permanent
disconnection. The two-consecutive-refreshes test is the canary; run it after any change
here.

### 8.2 Idempotency ordering (`worker/routes/post.ts`)

The idempotency claim happens **before** the dedupe and quota checks. Reversed — as it was
originally — a legitimate retry carrying the same key trips `duplicate_recent_text` against
its own row, and the playbook reads that code as "rewrite and post again", producing exactly
the double-post the layer exists to prevent. Do not reorder.

Callers omitting a key get one synthesised from `sha256(userId|normalizedText|5-min bucket)`,
so even a naive retry cannot double-post within five minutes.

### 8.3 Encryption AAD (`worker/lib/crypto.ts`)

HKDF `info` is separated by purpose **and** user; AES-GCM AAD is `userId:purpose`. That AAD
is what stops an attacker with DB write access from moving one user's ciphertext into
another's row. `test/crypto.test.ts` asserts it. Don't drop it.

### 8.4 A Mind's self-report is not evidence

Observed twice: the Mind reported a plausible outcome — correct-looking `draftId`,
`approveUrl`, even `dry_run` on a run that never requested one — while the audit log showed
no matching request. It replayed an earlier answer verbatim.

Two mechanisms exist because of this:

- **`clientNonce`** — callers mint a random value per run, send it, then look for it in
  `audit.detail`. A *missing* audit row is ambiguous (the request may have failed); a
  *matching nonce* is proof, because the value did not exist before the run began.
- **Generation/execution split** — `ops/daily-loop.ts` asks the Mind only for text and
  performs the POST itself, so the side effect lives in code that cannot skip it.
  `ops/ask-mind-to-post.ts` keeps the Mind in charge on purpose, because testing that path
  is its job.

`via` in the audit table is **best-effort** (the Mind sends `X-Relay-Via` inconsistently).
The nonce is authoritative.

### 8.5 Conversation replay

A conversation that already contains a similar request will return the earlier answer. A
fresh conversation produces fresh text every time. Hence per-day aliases plus an automatic
retry in a throwaway conversation. Overridable with `RELAY_OPS_ALIAS`.

### 8.6 Ops scripts must not call through the tunnel

They run on the same machine as the relay. Routing their own HTTP through ngrok measured
~1.3s versus ~0.01s direct, with intermittent hard failures — one of which destroyed an
already-generated draft. `ops/relay-client.ts` prefers `127.0.0.1`, falls back to the public
URL, and retries 3× with a 20s timeout. `RELAY_BASE_URL` stays the **public** URL because
the Worker builds browser-facing links from it.

### 8.7 Dry runs are audited

They used to return before writing an audit row, which made a legitimate dry run
indistinguishable from a caller that never called — the verification cried wolf every time.
Keep dry runs audited.

### 8.8 Other sharp edges

- `@cloudflare/workers-types` is **v5**; v4 conflicts with wrangler 4.
- Two tsconfigs (`tsconfig.json` for the Worker, `tsconfig.ops.json` for Node) because
  `workers-types` and `@types/node` globals conflict. `npm run typecheck` runs both.
- Mind replies are **HTML** (`<p>…</p>`) and often **unfenced** despite instructions;
  `ops/minds.ts` strips tags and falls back to scanning for balanced JSON.
- The builder JWT in `.env` is **account-admin**, valid to ~Jan 2028. It must never reach
  the Worker, a Mind message, or a commit. Only `ops/` reads it.
- `GET /x/me` is **not audited** (free read), so app-initiated status calls cannot be
  nonce-verified.

---

## 9. File map

```
worker/                     the relay (Cloudflare Worker, Hono)
  index.ts                  routes + error boundary + scheduled() cron
  types.ts                  Env bindings and row types
  lib/crypto.ts             HKDF + AES-GCM envelope, AAD binding, PKCE, HMAC
  lib/tokens.ts             refresh loop, rotation persistence, CAS lock   <- riskiest
  lib/xclient.ts            raw X API calls, cost constants, error classes
  lib/errors.ts             one error envelope; X error -> relay code mapping
  lib/guardrails.ts         URL detection, length, dedupe, caps, budget
  lib/idempotency.ts        insert-first claim, replay, synthesised keys
  lib/auth.ts               relay-key auth (sha256 only), admin auth, via detection
  lib/db.ts                 D1 helpers, audit writer
  lib/paywall.ts            x402 seam (inert)
  routes/{health,admin,oauth,post,approve,debug}.ts
ops/                        local Node CLI — holds the builder JWT, never deployed
  relay.sh                  thin CLI: health/provision/connect/me/post/audit/rotate/...
  relay-client.ts           localhost-preferring HTTP client with retries + nonce lookup
  minds.ts                  Minds client, alias resolution, HTML strip, JSON extraction
  install-playbook.ts       sends the contract, asks for LTM_Push, verifies
  ask-mind-to-post.ts       Mind-driven post, nonce-proven
  daily-loop.ts             Mind drafts -> this script posts -> nonce verified
  probe-relay-echo.ts       proves HTTP_Execute forwards auth headers
  probe-http-execute.ts     earlier third-party-echo variant (kept for reference)
  unequip-x-apps.ts         removes x-api / Clawk / Twitter CLI
  setup-local.sh            idempotent local bring-up (--reset wipes data)
  set-base-url.sh           updates RELAY_BASE_URL in .dev.vars and .env
playbooks/x-relay-v1.md     the Mind-facing contract — source of truth
schema.sql                  D1 schema: users, relay_keys, posts, audit
test/                       28 unit tests
```

**Apps unequipped from the Mind** (reversible via `client.equipApps`):

| App | appId | Why removed |
|---|---|---|
| `x-api` | `A54FEF68-0808-F111-AD1D-0EA9A5017E89` | `approved:false`, no OAuth client bound |
| `Clawk` | `C056F37E-9BFE-F011-AD1D-0EA9A5017E89` | third-party API access shape |
| `Twitter CLI` | `0745A254-CE1C-F111-AD1D-0EA9A5017E89` | **cookie auth — ToS breach** |

Still equipped: `Animoca Composio`, `Animoca Minds Auth`.

---

## 10. Running it

```bash
# terminal 1 — the relay
sh ops/setup-local.sh && npx wrangler dev

# terminal 2 — commands
sh ops/relay.sh health
sh ops/relay.sh me
sh ops/relay.sh dry "some text"
sh ops/relay.sh post "some text" my-idem-key
sh ops/relay.sh audit          # ground truth for what actually happened
sh ops/relay.sh user           # full state + guardrails

# terminal 3 — only needed for the Mind to reach the relay
ngrok http 8787
sh ops/set-base-url.sh https://<tunnel>   # then restart terminal 1

# Mind-driven
npm run ops -- ops/probe-relay-echo.ts https://<tunnel>
npm run ops -- ops/install-playbook.ts https://<tunnel> "$(cat .relay-key)"
npm run ops -- ops/ask-mind-to-post.ts "text"
npm run ops -- ops/daily-loop.ts --dry-run

npm run typecheck && npx vitest run
```

---

## 11. Cost model, for planning

At a **$100/month** budget the X API is nowhere near the binding constraint:

| Post type | Unit | $100 buys | Per day |
|---|---|---|---|
| No link | $0.015 | 6,666 | ~222 |
| With link | $0.200 | 500 | ~16 |
| ~30% links | ~$0.0705 | 1,418 | ~47 |

What actually binds first, in order:

1. **X's automation/spam rules** — hundreds of posts/day from one account risks suspension.
2. **Audience tolerance** — 3–10/day is the realistic ceiling for an account people follow.
3. **Reads, if engagement is added** — $0.005 each; 500 reads/day is $75/month alone, easily
   dwarfing posting cost.
4. **Cognition credits** — a separate budget. Roughly 1–8 per generation observed
   (balance ~590). Baseline with `getCognitionUsageByTool`.

**8 link-free posts/day is about $3.60/month.** The surplus is better spent on research and
monitoring than on raw volume. Because links cost 13× and X historically suppresses external
links anyway, putting the link in a reply is both cheaper and better distribution — the
relay enforces this by refusing links unless `allowUrl: true`.
