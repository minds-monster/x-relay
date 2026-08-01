# X Relay — status & handover

Single entry point for anyone (human or agent) picking this up. Updated 2026-08-01.

[README.md](README.md) has architecture detail and the API table.
[TESTING.md](TESTING.md) has the test walkthrough.

---

## 1. What this is, in one paragraph

A **ToS-compliant X (Twitter) posting connector for the Animoca Hello Minds ecosystem.**
Animoca's own `x-api` app cannot post — it is `approved: false` with no OAuth client bound,
returns `401 No OAuth client bound to this app`, is broken for all ~109 Minds equipped to
it, and there is no builder-side fix. So we built a replacement: a Cloudflare Worker
("the relay") that holds X OAuth tokens and posts on the account owner's behalf.

**Its only job is to post well.** Content comes from elsewhere: dedicated Minds (news
retrieval, composition) submit drafts to a queue over HTTP, and the relay decides when
each one goes out. A content Mind cannot choose a moment, cannot post twice, and cannot
post at all — it hands over text and stops. Cadence, spacing, duplicate detection, cost
control and the human veto all live in one place.

```
news-mind ─┐
compose-mind ─┼─ POST /x/queue ──> [queue table]
other-mind ─┘                           │
                        Worker cron */5 (Cloudflare, unattended)
                             │                        │
                    bind slot + hold            dispatch at slot
                    notify with veto link       one posting path -> X
```

---

## 2. Status at a glance

| Thing | State |
|---|---|
| Relay code | Complete, **77 unit tests passing**, both tsconfigs clean |
| Deployed | **Yes** — https://relay.minds.monster (custom domain, v0.2.0) |
| X account connected | **Yes** — `@adamunerate` (`1517949596118487043`), status `active` |
| Real tweet posted | **Yes** — via curl, via approval page, and via the Mind |
| Queue ingest | **Yes** — submit / list / withdraw / idempotent replay all verified live |
| Multiple posts/day | **Yes** — slot-based idempotency keys (§7.2 closed) |
| One definition of "day" | **Yes** — UTC slots throughout (§7.3 closed) |
| Runs unattended | **Yes** — cron firing every 5 min; bind, hold, alert and veto all verified live |
| Crypto (x402) metering | Seam built, deliberately inert |
| Git | Work committed on `main`, nothing pushed to a remote |

**Money spent: $0.075.** Cognition balance ~590.

### 2.1 Deploying the cron trigger needs a workers.dev subdomain — resolved, but read this

`wrangler deploy` uploaded the code fine while silently **failing to register the cron
trigger**:

```
PUT /accounts/<id>/workers/scripts/x-relay/schedules
  10063: You need a workers.dev subdomain in order to proceed.
```

Cloudflare requires the account to have a workers.dev subdomain before it will accept a
cron schedule — **even though this Worker is served from a custom domain and never uses
workers.dev.** Resolved on 2026-08-01 by opening
<https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages> once, which creates
the subdomain automatically.

Worth remembering because the failure mode is quiet: the deploy reports success for the
code and the custom domain, and the cron line is simply absent. A successful deploy now
prints `schedule: */5 * * * *`. If it does not, nothing is dispatched — drafts queue and
the queue never drains.

---

## 3. Identifiers and constants

```
Relay URL        https://relay.minds.monster            (custom domain on Cloudflare)
Cloudflare acct  5b55102b4efe93e9e591db8473aa25da
D1 database      x-relay  12cff7ee-2740-4159-b624-f8ce3c3e835f
KV namespace     PKCE     a038d3753db141ffb232f5bc444eaafd
Mind ID          240b453e-f36b-1410-8466-00039ce7df11   ("Adam", adam@hellominds.ai)
Second Mind      fb12453e-f36b-1410-8466-00039ce7df11   ("Beta", unused)
Minds API base   https://api.build.hellominds.ai        (auth header: X-Api-Key)
SDK              @animocabrands/minds-cli@0.1.3 · @animocabrands/minds-client-lib@0.1.3
X handle         @adamunerate  (X user id 1517949596118487043)
Relay user id    adam          (single-tenant today)
```

**Scheduling is UTC everywhere**, regardless of where the operator is. That is the fix for
what used to be §7.3: a slot id is derived from UTC alone, so there is no calendar
ambiguity and no DST arithmetic. Convert to local when you read the schedule, not when the
code stores it.

**Conversation aliases** (arbitrary aliases work; no `webapp:` prefix needed):

| Alias | Purpose |
|---|---|
| `relay:x-ops` | Where the playbook/contract was installed. Used by `ask-mind-to-post.ts`. |
| `relay:x-daily-<date>` | Per-day content generation. Created automatically. |
| `webapp:thread-1785477354652-a9tmbv` | Original human thread in the Minds web app |
| `relay:x-daily-20260731` | Stale artifact of a manual test; ignore or delete |

---

## 4. Current live parameters

From `RELAY_ENV=prod sh ops/relay.sh slots`:

```
slots (UTC)     : 13:00 17:00 21:00     <- THE SCHEDULE. Finite list; bounds posts/day.
hold window     : 1800s before each slot <- veto window; silence means it publishes
queue ttl       : 172800s (48h)          <- a draft older than this is dropped, not posted
min interval    : 3600s                  <- floor on slot spacing; validated on write
rolling 24h cap : 6                      <- a SAFETY CEILING, not the schedule
requireApproval : false                  <- the hold window replaces the click
budgetUsdMonth  : 5.00                   <- hard stop; raise before scaling spend
```

**Two counters, two jobs — do not conflate them.** This distinction is the §7.3 fix and is
load-bearing:

- **`slotsUtc`** is *when* posts go out. A finite list, so it also bounds how many.
- **`rate24hCap`** (stored as `daily_cap`) is a rolling-24-hour ceiling that catches a
  runaway regardless of the schedule. It is not a calendar-day count and never was; the
  function behind it is now called `countPostsRolling24h` for that reason.

Change them with:

```bash
RELAY_ENV=prod sh ops/relay.sh slots 13:00 17:00 21:00   # rejects gaps < minInterval
RELAY_ENV=prod sh ops/relay.sh hold 1800
RELAY_ENV=prod sh ops/relay.sh set '{"dailyCap":8}'
```

**Worker vars** (`wrangler.jsonc`): `PAYMENTS_ENABLED=false`, `RELAY_VERSION=0.2.0`,
`DEBUG_ECHO_ENABLED=false`, `RELAY_BASE_URL=https://relay.minds.monster` — the **public**
URL used to build OAuth, approval and veto links.

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

Verified on the deployed relay (2026-08-01, `relay.minds.monster`):

- **Deploy is real.** `/health` returns `version 0.2.0` with `db`, `kv` and all three keys
  `ok`. `/debug/echo` returns 404 — the diagnostic route is closed in production.
- **Queue ingest works end to end**: submit returns a `queueId` and a concrete
  `estimatedSlotUtc`; three drafts landed in three different slots.
- **Submission idempotency**: resubmitting the same `submissionId` returns
  `idempotent:true` with the same `queueId` and enqueues nothing.
- **Submit-time guardrails**: `duplicate_recent_text` (against both posted history and
  what is already queued), `url_not_allowed`, `text_too_long`.
- **Schedule validation rejects atomically** — `13:00 13:30` against a 3600s interval is
  refused with the arithmetic spelled out, and the stored schedule is left untouched.
- **Veto links are HMAC-signed** — unsigned and tampered tokens both yield 403.
- **Withdrawal** is a one-way door: a second attempt reports the current status instead of
  silently succeeding.
- **`relay.sh` follows `RELAY_ENV`** — direct-SQL commands print their target, so reading
  the local database while posting to production is no longer possible by accident.

Verified on a real timer (2026-08-01, ~90 minutes of `wrangler tail`):

- **Cron fires every 5 minutes**, no gaps.
- **The proactive token sweep works** — `[sweep] checked=1 refreshed=1`, a refresh-token
  rotation performed off the posting path. This was the sweep's entire purpose and had
  never been observed before.
- **Slot binding** — a draft went `queued` → `held` at 10:45:54 for an 11:05 slot.
- **The Slack alert fires**, carrying the draft text and a working veto link.
- **The veto path, end to end** — clicking the link produced `status='vetoed'` and an
  audit row `via=approval route=queue/veto code=vetoed`, and **no post row was created**.

### Not verified

- **A queued draft has never actually reached X under cron.** Everything up to the final
  X call is proven; the call itself is proven only through `/x/post` (three real tweets).
  The first genuine scheduled post will close this. Deliberately not forced with a test
  post, because that means publishing to a live timeline.
- **A dispatch failure** (`failed` status, the alert, the empty slot) has never occurred
  in production, only in tests.
- **Tenet writes / Mind-authored skills.** No API exists; both remain experiments. Note
  Mind-authored skills appear to publish to the public Bazaar — so a key must **never** go
  in a skill body.
- **x402 payment verification.** Middleware exists and fails closed.
- **Multi-user anything.** Schema supports it; only `adam` exists.

---

## 7. Outstanding threads

### 7.1 Deploy to Cloudflare — **DONE**

Live at https://relay.minds.monster on a custom domain. D1, KV, all four secrets, OAuth
re-run against the new callback. One residual: the cron trigger, §2.1 — do that next.

### 7.2 Multiple posts per day — **DONE**

The idempotency key is now the **slot**: `slot:adam:2026-08-01T13:00Z`. Minute-precise
UTC, unique per slot per day, so several posts a day are the normal case rather than a
special one, while two cron ticks landing in the same slot still collapse to a single
tweet. `worker/lib/schedule.ts` owns the arithmetic and is pure, so it is unit-tested
without a database.

Nothing on the operator's laptop schedules anything any more. The Worker's cron does it,
which is what makes the relay survive a closed lid.

### 7.3 Two conflicting definitions of "day" — **DONE**

Resolved by giving the two counters different names and different jobs rather than trying
to reconcile them (see §4). Slots are UTC everywhere: no calendar-vs-rolling ambiguity, no
DST arithmetic, and `countPostsToday` — the name that caused the confusion — is now
`countPostsRolling24h`.

### 7.4 Content quality — the real lever is input, not prompting

**This is now the main open thread, and the architecture is ready for it.** The queue
accepts drafts from any number of Minds, each with its own relay key
(`relay.sh key-add <label>`) and its own copy of the smaller
[x-queue-v1](playbooks/x-queue-v1.md) contract. A news-retrieval Mind and a composition
Mind can be stood up independently of the relay and swapped without touching it.

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

Done:

- **Diagnostic echo route closed** — `DEBUG_ECHO_ENABLED=false` in `wrangler.jsonc`;
  `/debug/echo` returns 404 in production.
- **`redirectUri`** now points at the deployed callback (fixed by the Phase 1 re-OAuth).
- **`.gitignore`** covers `.env.prod` and `.relay-key.*`, which the new prod workflow
  creates. Without that a `git add -A` would have committed the production admin key.

Still open:

- **Rotate the relay key.** It is in the `relay:x-ops` transcript and in LTM. Do this
  *after* the cron works and the content Minds are set up, so the new key is distributed
  once: `RELAY_ENV=prod sh ops/relay.sh rotate`, then re-run `install-playbook.ts` for each
  Mind within the 24h grace window.
- **No git remote.** Nothing is pushed anywhere. Pre-flight before creating one:
  `git log --all --full-history -- .env .dev.vars .relay-key .env.prod` must be empty.
  Make the repo **private** — the playbooks describe the auth model in detail.
- Delete the stale `relay:x-daily-20260731` conversation.

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

### 8.2 Idempotency ordering (`worker/lib/dispatch.ts`)

The idempotency claim happens **before** the dedupe and quota checks. Reversed — as it was
originally — a legitimate retry carrying the same key trips `duplicate_recent_text` against
its own row, and the playbook reads that code as "rewrite and post again", producing exactly
the double-post the layer exists to prevent. Do not reorder.

Callers omitting a key get one synthesised from `sha256(userId|normalizedText|5-min bucket)`,
so even a naive retry cannot double-post within five minutes.

**There is exactly one posting path**, `dispatchPost()`, used by both the `/x/post` route
and the cron dispatcher. A scheduler with its own copy of this ordering would drift from
it, and the guardrails are most of what this service is worth. `routes/post.ts` is now
only request parsing and JSON shaping.

### 8.2b Cron phase order (`worker/lib/scheduler.ts`)

Bind-and-hold runs **before** dispatch, every tick. Swapped, a draft submitted shortly
before its slot could be bound and sent within the same tick — reaching X before the alert
reached a phone, silently removing the only human check in an otherwise unattended system.
Binding first guarantees at least one tick of hold.

Ticks are assumed unreliable — Cloudflare may skip, delay or overlap one — so every step is
idempotent: binding is guarded by a unique index on `(user_id, slot_id)`, and dispatch is
guarded by the slot idempotency key. A slot missed by more than 30 minutes is **dropped and
reported**, not posted late; a 09:00 post arriving at 14:00 is usually worse than silence.

Two constants exist because the tick interval leaks into correctness. Both were real bugs,
found by reading actual tick timestamps against the code rather than by testing:

- **`MIN_BIND_LOOKAHEAD_SEC`** — binding only happens on a tick, so looking ahead exactly
  `hold_sec` leaves blind spots when `hold_sec` is shorter than the tick gap. At
  `hold_sec=60` with 5-minute ticks, roughly four slots in five were never bound, never
  dispatched and never reported: the post simply did not happen, with nothing in the logs.
  The lookahead is floored at one tick plus a margin. Binding early only ever means more
  warning, so erring long is the safe direction.
- **`MIN_NOTICE_SEC`** — a slot landing on a tick boundary was bound and dispatched within
  that same tick, so the alert and the tweet left together and the veto window was zero.
  Dispatch now requires the row to have been held since an earlier tick.

**If you change the cron interval, change `CRON_INTERVAL_SEC` in `scheduler.ts` with it.**
Nothing enforces that they agree.

### 8.2c A failed or vetoed slot stays empty

The dispatcher never promotes the next queued draft into a slot that just failed or was
vetoed. Substituting different content into a slot a human just rejected would defeat the
veto window, and an account in a failing state would burn the entire queue one draft per
tick. The slot goes empty and you get told why.

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
- **Generation is structurally separated from publishing.** A content Mind cannot post at
  all — its contract only reaches `/x/queue`, and the side effect lives in the Worker's
  cron, which has no capacity to decide to skip it. This is stronger than the old
  arrangement (a local script that did the POST), because it no longer depends on which
  script the operator happens to run. `ops/ask-mind-to-post.ts` keeps a Mind in charge of
  `/x/post` on purpose, because testing that path is its job.

`via` in the audit table is **best-effort** (the Mind sends `X-Relay-Via` inconsistently).
The nonce is authoritative.

### 8.5 Conversation replay

A conversation that already contains a similar request will return the earlier answer. A
fresh conversation produces fresh text every time. Hence per-day aliases plus an automatic
retry in a throwaway conversation. Overridable with `RELAY_OPS_ALIAS`.

Now that several drafts a day are normal, the per-run **request id** — not the per-day
alias — is what keeps each draft honest inside a shared conversation.

### 8.6 Ops scripts prefer localhost

`ops/relay-client.ts` tries `127.0.0.1` first and falls back to the public URL, retrying 3×
with a 20s timeout. That mattered acutely in the tunnel era (~1.3s via ngrok versus ~0.01s
direct, with intermittent failures, one of which destroyed an already-generated draft).
Against the deployed relay the localhost probe just fails fast and the public URL is used.
`RELAY_BASE_URL` stays the **public** URL because the Worker builds browser-facing OAuth,
approval and veto links from it.

### 8.6b `relay.sh` reads a different database depending on `RELAY_ENV`

`me`, `post` and `queue` are HTTP and follow `RELAY_BASE_URL`; `audit`, `posts` and
`tokens` are direct D1 queries. Before, the latter were hardcoded to `--local`, so after
deploying, `relay.sh audit` showed an empty local database while `relay.sh me` talked to
production — the most confusing possible failure. Both now follow `RELAY_ENV`, and the
direct-SQL commands print their target. Keep it that way.

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
  index.ts                  routes + error boundary + scheduled() cron entry point
  types.ts                  Env bindings and row types
  lib/crypto.ts             HKDF + AES-GCM envelope, AAD binding, PKCE, HMAC
  lib/tokens.ts             refresh loop, rotation persistence, CAS lock   <- riskiest
  lib/dispatch.ts           THE posting path — route and cron both call it   <- read §8.2
  lib/scheduler.ts          the cron body: bind+hold, then dispatch         <- read §8.2b
  lib/schedule.ts           slot arithmetic. PURE — no D1, no clock of its own
  lib/queue.ts              queue table access; slot binding, veto, expiry
  lib/xclient.ts            raw X API calls, cost constants, error classes
  lib/errors.ts             one error envelope; X error -> relay code mapping
  lib/guardrails.ts         URL detection, length, dedupe, caps, budget
  lib/idempotency.ts        insert-first claim, replay, synthesised keys
  lib/auth.ts               relay-key auth (sha256 only), admin auth, via detection
  lib/db.ts                 D1 helpers, audit writer
  lib/notify.ts             operator alerts via ALERT_WEBHOOK_URL; never throws
  lib/html.ts               the one page shell: OAuth, approval, veto
  lib/paywall.ts            x402 seam (inert)
  routes/{health,admin,oauth,post,queue,approve,debug}.ts
ops/                        local Node CLI — holds the builder JWT, never deployed
  relay.sh                  CLI: health/me/slots/hold/queue/submit/keys/audit/rotate/...
                            RELAY_ENV=prod targets the deployed relay        <- read §8.6b
  relay-client.ts           localhost-preferring HTTP client with retries + nonce lookup
  minds.ts                  Minds client, alias resolution, HTML strip, JSON extraction
  install-playbook.ts       installs a contract; --playbook picks which
  ask-mind-to-post.ts       Mind-driven direct post, nonce-proven
  submit-draft.ts           Mind drafts -> submitted to the queue -> nonce verified
                            (was daily-loop.ts, which also posted; the cron does that now)
  probe-relay-echo.ts       proves HTTP_Execute forwards auth headers
  probe-http-execute.ts     earlier third-party-echo variant (kept for reference)
  unequip-x-apps.ts         removes x-api / Clawk / Twitter CLI
  setup-local.sh            idempotent local bring-up (--reset wipes data)
  set-base-url.sh           updates RELAY_BASE_URL in .dev.vars and .env
playbooks/
  x-relay-v1.md             full posting contract — for a Mind that posts directly
  x-queue-v1.md             content contract — submit only; cannot post, cannot pick a time
schema.sql                  D1 schema: users, relay_keys, posts, queue, audit
migrations/001-queue.sql    additive ALTERs for databases that predate the queue
test/                       77 unit tests
  helpers/d1.ts             D1 adapter over node:sqlite, so queue tests run the real DDL
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

### Against production (the normal case)

`RELAY_ENV=prod` switches config to `.env.prod` **and** D1 queries to `--remote`. Export it
once per shell; forgetting it is how you end up reading an empty local database.

```bash
export RELAY_ENV=prod

sh ops/relay.sh me              # account state, schedule, spend
sh ops/relay.sh slots           # the schedule
sh ops/relay.sh queue           # what is waiting, and which slot each lands in
sh ops/relay.sh audit           # ground truth. A Mind's self-report is not evidence.

sh ops/relay.sh submit "text"   # enqueue by hand
sh ops/relay.sh unqueue 7       # pull one back

sh ops/relay.sh slots 13:00 17:00 21:00   # change the schedule (UTC)
sh ops/relay.sh hold 1800                 # change the veto window

npx wrangler tail               # watch [sweep] and [scheduler] each tick
```

### Adding a content Mind

```bash
sh ops/relay.sh key-add news-mind         # its own key; revoking it spares the others
npm run ops -- ops/install-playbook.ts https://relay.minds.monster '<key>' \
    --playbook x-queue-v1 --alias relay:news-mind
```

The Mind then submits with `POST /x/queue` and never sees `/x/post`.

### Local development

```bash
sh ops/setup-local.sh && npx wrangler dev          # terminal 1
npx wrangler d1 execute x-relay --local --file=migrations/001-queue.sql   # first time only
sh ops/relay.sh health                             # terminal 2, no RELAY_ENV
npm run ops -- ops/submit-draft.ts --dry-run

npm run typecheck && npx vitest run
```

`wrangler dev` does **not** fire cron triggers, so the scheduler never runs locally. Test
slot logic through `test/schedule.test.ts` and `test/queue.test.ts`, which run the real
schema against an in-memory SQLite; verify the timer itself with `wrangler tail` in
production.

### Deploying

```bash
npm run typecheck && npx vitest run
npx wrangler deploy --dry-run
npx wrangler d1 execute x-relay --remote --file=migrations/00N-*.sql   # if schema changed
npx wrangler deploy
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
