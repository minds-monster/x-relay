# X Relay

> **New here? Read [STATUS.md](STATUS.md) first.** It covers current state, live
> parameters, what is and isn't verified, outstanding work, and the non-obvious landmines.
> This file covers architecture and the API surface; [TESTING.md](TESTING.md) is the
> step-by-step test walkthrough.

A ToS-compliant X (Twitter) posting connector for the Animoca **Hello Minds** ecosystem.

It replaces the platform's `x-api` app, which is `approved: false` with no OAuth client
bound (`401 No OAuth client bound to this app`) and cannot be fixed from the builder
side. The relay is a Cloudflare Worker the Mind calls with `HTTP_Execute`.

Live at **https://relay.minds.monster**.

## What it does, and what it deliberately does not

Its only job is to **post well**. Content is somebody else's job.

Dedicated Minds — news retrieval, composition, whatever you build — submit drafts to
`POST /x/queue` and stop. The relay decides when each one goes out: it binds a draft to
the next open slot, announces it with a link to stop it, waits out the hold window, and
publishes. A content Mind cannot pick a moment, cannot post twice, and cannot post at all.

```
news-mind ─┐
compose-mind ─┼─ POST /x/queue ──> [queue table]
other-mind ─┘                           │
                        Worker cron */5 (Cloudflare, unattended)
                             │                        │
                    bind slot + hold            dispatch at slot
                    notify with veto link       one posting path -> X
```

That boundary is the point. Cadence, spacing, duplicate detection, cost control and the
human veto live in exactly one place, so adding a fifth content Mind cannot loosen any of
them. `POST /x/post` still exists for a Mind that genuinely needs to post on demand, and
takes the same guardrails through the same code.

## Why it is shaped this way

**BYO X credentials per user.** Each user registers their *own* X developer app and
authorizes their *own* account in their *own* browser. The relay stores their tokens
encrypted and never shares a client across users.

This is not incidental. X Developer Agreement **III.A(e)** prohibits providing the API
"on a service bureau, rental or managed services basis" and prohibits sharing
credentials; **III.A(d)** prohibits providing API access to third parties. A single
shared business X account that many users post through — however it is billed — is
exactly what those clauses describe, and X terminates the *developer account*, not just
the app. Any future crypto metering therefore charges for **this relay's service**, never
for X API access; each user's X usage is billed by X to their own account.

**Costs (Feb 2026 pay-per-use — the free tier is gone).** ~$0.015 per post, **~$0.200
per post containing a URL** (13×), $0.005 per post read, $0.001 per read of your own
data. Prepaid credits. The relay refuses link posts unless you pass `allowUrl: true`, so
the cost cliff is always opt-in.

**Two ways a human stays in the loop, and only one is on at a time.**
`require_approval` parks a draft behind a signed approval link: nothing publishes without
a click. The **hold window** inverts that — a queued draft is announced with a veto link
and publishes unless you stop it. Approval is safer; the hold window is what makes the
relay unattended without making it unaccountable. Queued posting assumes the latter, so
`requireApproval` is off in production.

**Scheduling is UTC, everywhere.** A slot id is `adam:2026-08-01T13:00Z`, derived from UTC
alone, and doubles as the post's idempotency key. No calendar-vs-rolling ambiguity, no DST
arithmetic, and several posts a day are the normal case rather than a special one.

## Layout

```
worker/        the relay (Cloudflare Worker, Hono)
  lib/         crypto, tokens, dispatch, scheduler, schedule, queue,
               guardrails, idempotency, auth, notify, paywall seam
  routes/      health, admin, oauth, post, queue, approve, debug
ops/           local Node CLI — holds the builder JWT, never deployed
playbooks/     x-relay-v1 (full posting) · x-queue-v1 (content Minds — submit only)
schema.sql     D1 schema
migrations/    additive ALTERs for databases created before a schema change
test/          77 unit tests
```

Two modules are worth knowing by name before editing:

- **`lib/dispatch.ts`** is the *only* posting path. The `/x/post` route and the cron
  dispatcher both call it, so the guardrail ordering cannot drift between them.
- **`lib/schedule.ts`** is pure — no D1, no clock of its own, every function takes an
  explicit timestamp. That is what makes the scheduler testable without a harness.

The split is deliberate: the builder JWT in `.env` is an **account-admin** credential
valid to ~Jan 2028 and must never reach the edge, and `waitForReply` holds an SSE stream
for minutes, which is hostile to Worker limits. The Worker never imports
`minds-client-lib`; `ops/` never imports Worker code.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars     # then fill in:
#   MASTER_KEY_B64=$(openssl rand -base64 32)
#   ADMIN_KEY=$(openssl rand -hex 32)
#   APPROVAL_HMAC_KEY=$(openssl rand -hex 32)

npx wrangler d1 execute x-relay --local --file=schema.sql
npx wrangler dev
curl -s localhost:8787/health
```

For remote deploy you must first authenticate Wrangler (`npx wrangler login`, or set
`CLOUDFLARE_API_TOKEN`), then create the real bindings and paste the ids into
`wrangler.jsonc`:

```bash
npx wrangler d1 create x-relay          # -> database_id
npx wrangler kv namespace create PKCE   # -> id
npx wrangler d1 execute x-relay --remote --file=schema.sql
npx wrangler secret put MASTER_KEY_B64
npx wrangler secret put ADMIN_KEY
npx wrangler secret put APPROVAL_HMAC_KEY
npx wrangler deploy
```

Set `RELAY_BASE_URL` in `wrangler.jsonc` to the deployed origin. It is used to build
OAuth redirect and approval links, so a stale value produces links that point at
localhost.

### Register the X app

In the X developer portal: create a project and app, type **Web App / Automated App or
Bot** (confidential client). Scopes: `tweet.read tweet.write users.read offline.access` —
without `offline.access` X returns no refresh token and the integration dies in two
hours. Callback URLs must match byte-for-byte; register both
`http://127.0.0.1:8787/x/oauth/callback` (use the literal IP, X commonly rejects
`localhost`) and the production one. Load prepaid credits.

### Provision a user and connect the account

```bash
curl -XPOST localhost:8787/admin/users \
  -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"userId":"adam","label":"Adam Place",
       "x":{"clientId":"...","clientSecret":"...","clientType":"confidential"}}'
```

The response contains `relayKey` **once** (only `sha256(key)` is stored) and an
`authorizeUrl`. Open the latter in the account owner's browser to complete OAuth.

### Wire up the Mind

```bash
npm run ops -- ops/unequip-x-apps.ts                       # remove x-api / Clawk / Twitter CLI
npm run ops -- ops/probe-relay-echo.ts https://<host>      # confirm HTTP_Execute forwards auth
npm run ops -- ops/install-playbook.ts https://<host> <relayKey>
npm run ops -- ops/ask-mind-to-post.ts --status
npm run ops -- ops/ask-mind-to-post.ts "text to post"
```

### Add a content Mind

Give each one its own key and the smaller contract. It learns `POST /x/queue` and nothing
else — no posting primitive, no approval pages, no retraction.

```bash
RELAY_ENV=prod sh ops/relay.sh key-add news-mind
npm run ops -- ops/install-playbook.ts https://relay.minds.monster '<key>' \
    --playbook x-queue-v1 --alias relay:news-mind

npm run ops -- ops/submit-draft.ts --topic "..." --source news-mind   # reference impl
```

Revoke one with `relay.sh key-revoke <keyId>`; the other Minds keep working. Use
`rotate-key` only when you mean to rotate *everything*.

> **Rotate the relay key after installing the playbook.** There is no tenet-write or
> skill-creation route in the Builder API, so v1 delivers the key through the
> conversation, which puts it in the transcript:
> `curl -XPOST $BASE/admin/users/adam/rotate-key -H "X-Admin-Key: ..."`
> Rotation keeps the old key valid for 24h, so re-send the playbook before revoking.

## API

| Route | Auth | Purpose |
|---|---|---|
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness + binding/secret checks |
| `POST /admin/users` | `X-Admin-Key` | create user, mint first relay key |
| `GET/PATCH /admin/users/:id` | `X-Admin-Key` | inspect / adjust schedule + guardrails |
| `POST /admin/users/:id/rotate-key` | `X-Admin-Key` | rotate ALL keys, 24h grace |
| `GET/POST /admin/users/:id/keys` | `X-Admin-Key` | list / mint one more, siblings untouched |
| `DELETE /admin/users/:id/keys/:keyId` | `X-Admin-Key` | revoke one key immediately |
| `GET /admin/users/:id/recent` | `X-Admin-Key` | ground truth: recent audit + posts |
| `GET /x/oauth/start` | — | 302 to X consent (PKCE S256) |
| `GET /x/oauth/callback` | `state` | code exchange, store tokens |
| `GET /x/me` | Bearer | free state check + schedule, no X cost |
| **`POST /x/queue`** | Bearer | **submit a draft — what content Minds use** |
| `GET /x/queue` | Bearer | what is waiting, and which slot each lands in |
| `DELETE /x/queue/:id` | Bearer | withdraw a submission |
| `POST /x/post` | Bearer | post now, bypassing the queue |
| `DELETE /x/post/:tweetId` | Bearer | retract |
| `POST /x/refresh` | Bearer | force refresh (debug) |
| `GET/POST /approve/:id?t=` | HMAC | approval page — silence publishes nothing |
| `GET/POST /queue/:id/veto?t=` | HMAC | veto page — silence publishes |
| `POST /debug/echo` | none | header/body echo; disabled in production |
| cron `*/5 * * * *` | — | token sweep, then bind+hold, then dispatch |

Note the two distinct idempotency keys, which are easy to confuse:

- **`submissionId`** on `/x/queue` — stable per *draft*. A content Mind retrying its
  submit enqueues once.
- **`idempotencyKey`** on `/x/post` — stable per *posting intent*. Queued posts get
  `slot:<slotId>` automatically, which is why two cron ticks in one slot post once.

Every failure uses one envelope so the playbook can branch on a code rather than parse
prose:

```json
{"ok":false,"error":{"code":"x_rate_limited","message":"...","retryable":true,"retryAfterSec":900}}
```

Disable the echo route in production once `HTTP_Execute` behaviour is settled:
`DEBUG_ECHO_ENABLED=false`.

## Design notes worth knowing before editing

**Refresh-token rotation is the sharp edge.** X issues a new refresh token on every
refresh and invalidates the old one immediately. So `lib/tokens.ts` persists the new pair
*before* using it, keeps one prior generation in `tokens_prev_enc` for torn-write
recovery, and serialises refreshes with a compare-and-swap lock on the user row — the
cron sweep and a concurrent `/x/post` would otherwise each burn a token the other needs.
Transient failures (429/5xx) never clear tokens; only a genuine `invalid_grant` does.

**Encryption binds ciphertext to its owner.** `HKDF-SHA256` derives a per-record
AES-256-GCM key with `info` separated by purpose *and* user, and AAD set to
`userId:purpose`. That AAD is what stops an attacker with DB write access from moving one
user's ciphertext into another's row. `test/crypto.test.ts` asserts both properties.

**Idempotency ordering is load-bearing.** The claim happens *before* the dedupe and quota
checks. Reversed, a legitimate retry carrying the same `idempotencyKey` trips
`duplicate_recent_text` against its own row — and the playbook tells the Mind that code
means "rewrite and use a new key", which would produce exactly the double-post the layer
exists to prevent. Callers that omit a key get one synthesised from
`sha256(userId|normalizedText|5-min bucket)`.

**x402 is a seam, not a feature.** `lib/paywall.ts` is inert while
`PAYMENTS_ENABLED=false`. Turning it on returns a 402 challenge the Mind side already
knows how to satisfy — `x402_Agent_Payment_Protocol` and `Corbits_AgentPaymentBuyer` sign
EIP-3009 via `WALLET_Sign` and retry with `X-PAYMENT`. Verification is not implemented, so
it currently fails closed. Note the two meanings of 402: `relay_payment_required` is
x402; `x_credits_exhausted` is the user's X credits running out.

## Verified / not verified

Confirmed against the live platform:

- `HTTP_Execute` forwards `Authorization: Bearer`, custom `X-*` headers, and an intact
  JSON POST body — proven with a canary echoed back through `/debug/echo` (HTTP 200).
- Arbitrary conversation aliases work: `relay:x-ops` was accepted, no `webapp:` prefix
  needed.
- The Mind stores the contract via `LTM_Push` and reports `contract_stored`.
- A Mind-driven `POST /x/post` reaches the relay and is recorded with `via='mind'`.
- Approval-on behaviour: the Mind receives 202, reports the draft plus `approveUrl`, and
  does not claim the post is live.
- Mind replies are HTML and often unfenced, so `ops/minds.ts` strips tags and falls back
  to scanning for balanced JSON objects.

**A Mind's self-report is not evidence.** Observed in testing: a `--dry-run` loop
reported HTTP 202 with a `draftId` and `approveUrl` belonging to an *earlier* request,
while the audit log showed no matching row — it answered from conversation context
instead of calling. Treat `GET /admin/users/:id/recent` (or the `audit` table) as ground
truth; `ops/submit-draft.ts` cross-checks against it and fails the run when the relay never
saw the call. Both playbooks also instruct the Mind never to report a remembered result.

The queue strengthens this structurally rather than by prompting: a content Mind has no
posting primitive at all, and the side effect happens in the Worker's cron, which has no
capacity to decide to skip it and report success anyway.

Not yet verified, and why:

- **A real tweet.** Needs your own X app credentials and prepaid credits; the chain
  currently stops at `user_not_connected`, which is the correct behaviour with no account
  linked.
- **The refresh loop against live X.** Covered by design and by the CAS/rotation logic,
  but the two-consecutive-refresh test needs real tokens. Run it first once connected:
  `POST /x/refresh` twice, confirm `expires_at` advances both times and `tokens_enc`
  differs.
- **Remote deploy.** Blocked on Cloudflare authentication, which is interactive.
- **Tenet writes and Mind-authored skills.** No API route exists for either; both remain
  experiments. Keys must never go into a skill body — Mind-authored skills appear to
  publish to the Bazaar.

## Scale caveat

This is built for a single operator. Running the relay *for other people* is plausibly
"a managed services basis" under III.A(d) regardless of whose keys are inside. For anyone
beyond yourself, ship it as software they self-host — their Worker, their account, their
secrets — or move to X Enterprise. The design is already self-hostable; keep it that way.
