# X Relay

A ToS-compliant X (Twitter) posting connector for the Animoca **Hello Minds** ecosystem.

It replaces the platform's `x-api` app, which is `approved: false` with no OAuth client
bound (`401 No OAuth client bound to this app`) and cannot be fixed from the builder
side. The relay is a Cloudflare Worker the Mind calls with `HTTP_Execute`.

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

**Approval on by default.** `require_approval` decides whether `POST /x/post` calls X or
parks a draft behind a signed approval link. Same route, same Mind contract, one boolean.

## Layout

```
worker/        the relay (Cloudflare Worker, Hono)
  lib/         crypto, tokens, guardrails, idempotency, auth, paywall seam
  routes/      health, admin, oauth, post, approve, debug
ops/           local Node CLI — holds the builder JWT, never deployed
playbooks/     the Mind-facing contract, source of truth
schema.sql     D1 schema
test/          unit tests (crypto AAD binding, guardrails, idempotency)
```

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
npm run ops -- ops/daily-loop.ts --dry-run
```

> **Rotate the relay key after installing the playbook.** There is no tenet-write or
> skill-creation route in the Builder API, so v1 delivers the key through the
> conversation, which puts it in the transcript:
> `curl -XPOST $BASE/admin/users/adam/rotate-key -H "X-Admin-Key: ..."`
> Rotation keeps the old key valid for 24h, so re-send the playbook before revoking.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness + binding/secret checks |
| `POST /admin/users` | `X-Admin-Key` | create user, mint relay key |
| `GET/PATCH /admin/users/:id` | `X-Admin-Key` | inspect / adjust guardrails |
| `POST /admin/users/:id/rotate-key` | `X-Admin-Key` | rotate with 24h grace |
| `GET /admin/users/:id/recent` | `X-Admin-Key` | ground truth: recent audit + posts |
| `GET /x/oauth/start` | — | 302 to X consent (PKCE S256) |
| `GET /x/oauth/callback` | `state` | code exchange, store tokens |
| `GET /x/me` | Bearer | free state check, no X cost |
| `POST /x/post` | Bearer | the main route |
| `DELETE /x/post/:tweetId` | Bearer | retract |
| `POST /x/refresh` | Bearer | force refresh (debug) |
| `GET/POST /approve/:id?t=` | HMAC | human approval page |
| `POST /debug/echo` | none | header/body echo for diagnostics |
| cron `*/15 * * * *` | — | token refresh sweep |

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
truth; `ops/daily-loop.ts` cross-checks against it and fails the run when the relay never
saw the call. The playbook also instructs the Mind never to report a remembered result.

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
