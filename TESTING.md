# Testing guide

Follow this top to bottom. Every step says exactly what to type, exactly what you should
see, and what to do if you see something else.

**You need two terminal windows.** Terminal 1 runs the relay and stays running the whole
time. Terminal 2 is where you type commands. I'll label every step.

**Total cost: under $0.10.** Test posts are link-free at $0.015 each, plus a few $0.001
identity reads.

**Before you start**, confirm you have from the X developer portal:
- OAuth 2.0 **Client ID**
- OAuth 2.0 **Client Secret**
- App permissions set to **Read and write**
- Callback URI `http://127.0.0.1:8787/x/oauth/callback`
- Prepaid credits loaded

---

# Phase A — get a real tweet out

No tunnel, no Mind, no Cloudflare account. Just your machine and X.

## Step 1 — Start the relay  (Terminal 1)

```bash
cd ~/adam-mind
sh ops/setup-local.sh
```

You should see:

```
.dev.vars already exists — leaving it alone.
Applying schema to local D1...
  schema applied
```

Then start the server and **leave this terminal alone for the rest of the guide**:

```bash
npx wrangler dev
```

Wait for the last line to read:

```
[wrangler:info] Ready on http://localhost:8787
```

> Leave it running. If you close it or press Ctrl+C, every later step fails with
> "Cannot reach the relay". Just re-run `npx wrangler dev` if that happens.

## Step 2 — Check it's healthy  (Terminal 2)

Open a **new** terminal window.

```bash
cd ~/adam-mind
sh ops/relay.sh health
```

**Expect exactly this shape:**

```json
{
    "ok": true,
    "version": "0.1.0",
    "ts": "...",
    "checks": {
        "db": "ok",
        "kv": "ok",
        "masterKey": "set",
        "adminKey": "set",
        "approvalKey": "set",
        "payments": "disabled"
    }
}
```

- **`"ok": true`** → continue to step 3.
- **"Cannot reach the relay"** → Terminal 1 isn't running. Go back to step 1.
- **any check says `MISSING`** → run `sh ops/setup-local.sh` again.

## Step 3 — Register yourself with the relay  (Terminal 2)

Substitute your two real values from the X portal:

```bash
sh ops/relay.sh provision 'YOUR_CLIENT_ID' 'YOUR_CLIENT_SECRET'
```

Keep the single quotes — secrets often contain characters the shell would otherwise eat.

**Expect:**

```json
{
    "ok": true,
    "userId": "adam",
    "keyId": "rk_xxxxxxxx",
    "relayKey": "xr_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "authorizeUrl": "http://127.0.0.1:8787/x/oauth/start?user=adam",
    "next": "Open authorizeUrl in the account owner's browser..."
}

Relay key saved to .relay-key (gitignored). Later commands read it automatically.
```

That last line matters: the relay key is shown **once**, and the script saves it for you.
You don't need to copy it anywhere.

- **`"User \"adam\" already exists"`** → you ran this before. Attach your real credentials
  instead: `sh ops/relay.sh credentials 'YOUR_CLIENT_ID' 'YOUR_CLIENT_SECRET'`

## Step 4 — Connect your X account  (Terminal 2, then browser)

```bash
sh ops/relay.sh connect
```

It prints a URL. **Open that URL in your browser.**

1. X shows a consent screen naming your app and the permissions it wants.
2. Click **Authorize app**.
3. You land back on a page headed **"X account connected"**, showing your handle and the
   granted scopes.

**Read the scopes line on that page. It must contain `offline.access`.**

- **Page says "X did not return a refresh token"** → your app is missing the
  `offline.access` scope. Nothing was saved. Fix the app in the X portal and redo step 4.
- **Page says "Could not complete authorization"** → almost always the callback URI. It
  must be `http://127.0.0.1:8787/x/oauth/callback` in the X portal, character for
  character — not `localhost`, no trailing slash.
- **X shows an error before you even reach consent** → the Client ID is wrong, or you
  used the "API Key" instead of the **OAuth 2.0 Client ID**.

## Step 5 — Confirm the connection  (Terminal 2)

```bash
sh ops/relay.sh me
```

**Expect** `"status": "active"`, your real handle, and a `tokenExpiresAt` roughly two
hours from now:

```json
{
    "ok": true,
    "userId": "adam",
    "status": "active",
    "xHandle": "your_handle",
    "postsToday": 0,
    "dailyCap": 3,
    "requireApproval": true,
    "tokenExpiresAt": "2026-07-31T14:22:10.000Z"
}
```

Now confirm your tokens are actually encrypted on disk:

```bash
sh ops/relay.sh tokens
```

**Expect** the ciphertext to begin `v1.` — meaning it's an encrypted envelope, not a
readable token:

```
  status=active handle=your_handle expires=2026-07-31 14:22:10 ciphertext=v1.aB3xY9...
```

## Step 6 — The refresh test (the important one)  (Terminal 2)

X **invalidates your old refresh token every single time you refresh**. If the relay
failed to save the replacement, nothing breaks today — it breaks silently in two hours
and the account can't recover. So test it deliberately.

Run this **twice**, one after the other:

```bash
sh ops/relay.sh refresh
```

```bash
sh ops/relay.sh refresh
```

**Expect BOTH to return:**

```json
{
    "ok": true,
    "userId": "adam",
    "expiresAt": "...",
    "accessTokenChanged": true,
    "refreshTokenRotated": true
}
```

- **Both succeeded, `expiresAt` later the second time** → rotation is being persisted
  correctly. Continue.
- **First worked, second failed** → **stop here and tell me.** This is the one failure
  that matters and nothing downstream is safe until it's fixed.

## Step 7 — Dry run (free, touches X not at all)  (Terminal 2)

```bash
sh ops/relay.sh dry "relay smoke test 7f3a"
```

**Expect:**

```json
{
    "ok": true,
    "dryRun": true,
    "wouldPost": "relay smoke test 7f3a",
    "chars": 21,
    "hasUrl": false,
    "costEstimateUsd": 0.015,
    "requireApproval": true
}
```

Nothing was posted and nothing was charged. `requireApproval: true` is why the next step
has an extra command.

## Step 8 — Turn off approval, just for this test  (Terminal 2)

Approval is on by default, so a real post would park a draft instead of tweeting. Turn it
off so you can see the full path end to end. We turn it back on in step 12.

```bash
sh ops/relay.sh set '{"requireApproval":false,"minIntervalSec":0}'
```

**Expect** `{"ok": true, "userId": "adam", "updated": 2}`.

(`minIntervalSec: 0` removes the normal one-hour spacing so you can post several times in
a row while testing.)

## Step 9 — The real tweet  (Terminal 2)

**This posts publicly to your timeline and costs $0.015.**

```bash
sh ops/relay.sh post "relay smoke test 7f3a" smoke-1
```

The second argument, `smoke-1`, is the idempotency key — remember it for step 10.

**Expect:**

```json
{
    "ok": true,
    "id": "1234567890123456789",
    "url": "https://x.com/your_handle/status/1234567890123456789",
    "costEstimateUsd": 0.015
}
```

**Open that URL.** The tweet should be live. **This is the milestone — the connector
works.**

- **`x_credits_exhausted`** → no prepaid credits on the X account.
- **`x_forbidden`** → app permissions are Read-only. Fix in the X portal, then **redo
  step 4** (existing tokens keep their old scopes).
- **`x_reauth_required`** → redo step 4.

## Step 10 — Prove a retry can't double-post  (Terminal 2)

Run the **exact same command again**, same key:

```bash
sh ops/relay.sh post "relay smoke test 7f3a" smoke-1
```

**Expect:**

```json
{
    "ok": true,
    "idempotent": true,
    "id": "1234567890123456789",
    "note": "This exact post already went out. Do not retry."
}
```

Same tweet id as step 9, and **check your timeline: there must still be only one tweet.**
This is what makes it safe for the Mind to retry.

## Step 11 — Prove the cost guard  (Terminal 2)

A post containing a link costs $0.200 instead of $0.015 — thirteen times more. The relay
refuses links unless you explicitly opt in.

```bash
sh ops/relay.sh post "read more at example.com" url-1
```

**Expect a refusal, not a tweet:**

```json
{
    "ok": false,
    "error": {
        "code": "url_not_allowed",
        "message": "This post contains a link, which costs $0.200 instead of $0.015...",
        "retryable": false
    }
}
```

Nothing posted, nothing charged.

## Step 12 — Test the approval flow  (Terminal 2, then browser)

Turn approval back on:

```bash
sh ops/relay.sh set '{"requireApproval":true}'
```

Then ask for a post:

```bash
sh ops/relay.sh post "approval path test b91c" appr-1
```

**Expect `status: "pending_approval"` and an `approveUrl`** — and **no tweet yet**:

```json
{
    "ok": true,
    "status": "pending_approval",
    "draftId": "3",
    "approveUrl": "http://127.0.0.1:8787/approve/3?t=abc123...",
    "chars": 23,
    "costEstimateUsd": 0.015,
    "note": "NOT posted. Report this draft and approveUrl to the human, then stop."
}
```

**Open the `approveUrl` in your browser.** You should see the draft text, its character
count and cost, and two buttons: **Approve & post** and **Reject**.

Click **Approve & post**. The page should turn into "Posted" with a link. Check your
timeline.

## Step 13 — Look at what actually happened  (Terminal 2)

```bash
sh ops/relay.sh audit
```

```
  time (UTC)           via       route           code                   http
  2026-07-31 12:04:11  approval  approve         posted                 201
  2026-07-31 12:03:48  curl      x/post          pending_approval       202
  2026-07-31 12:02:30  curl      x/post          url_not_allowed        400
  2026-07-31 12:01:55  curl      x/post          idempotent_replay      200
  2026-07-31 12:01:02  curl      x/post          posted                 201
```

```bash
sh ops/relay.sh posts
```

The `via` column is how you tell who made each call. Right now everything says `curl`
because it was you. In Phase B you're looking for `mind`.

## Step 14 — Clean up your test tweets  (Terminal 2)

Take the tweet ids from step 9 and step 12:

```bash
sh ops/relay.sh delete 1234567890123456789
```

**Expect** `{"ok": true, "deleted": true, ...}`.

---

### Phase A is done when all of these are true

- A real tweet appeared on your timeline (step 9)
- Re-running the identical command made **no second tweet** (step 10)
- **Both** refreshes succeeded (step 6)
- The link post was refused (step 11)
- Clicking Approve in the browser produced a tweet (step 12)

**If any of those failed, stop and tell me which one.** Phase B builds directly on this.

---

# Phase B — let the Mind do the posting

The Mind runs on Animoca's servers, so it can't reach `127.0.0.1`. It needs a public URL.

## Step 15 — Open a tunnel  (Terminal 3)

Open a **third** terminal:

```bash
ngrok http 8787
```

Look for the `Forwarding` line and copy the https URL, e.g.
`https://abc-123-xyz.ngrok-free.dev`. **Leave this terminal running too.**

## Step 16 — Point the relay at the tunnel  (Terminal 2)

This matters: the relay builds its OAuth and approval links from `RELAY_BASE_URL`. If it
still says localhost, the Mind gets links it cannot use.

Replace the URL below with yours:

```bash
sh ops/set-base-url.sh https://abc-123-xyz.ngrok-free.dev
```

**Then restart Terminal 1** so it picks up the change: press Ctrl+C there, and run
`npx wrangler dev` again.

Confirm the tunnel reaches the relay:

```bash
sh ops/relay.sh health
```

**Expect** the same healthy JSON as step 2 — but note it's now being fetched over the
public tunnel URL.

## Step 17 — Check the Mind can authenticate  (Terminal 2)

```bash
npm run ops -- ops/probe-relay-echo.ts "$(grep '^RELAY_BASE_URL=' .dev.vars | cut -d= -f2-)"
```

This asks the Mind to call the relay with a one-time canary value and report what
arrived. It takes up to a couple of minutes — the Mind has to think.

**Expect, at the end:**

```
  => CONFIRMED: HTTP_Execute forwards Authorization: Bearer and a JSON body.
     The primary relay design works as specified. No fallback needed.
```

- **"Authorization is STRIPPED"** → tell me; the relay already supports a fallback header
  and I'll switch the playbook over.
- **Any tunnel/connection error** → check Terminal 3 is still running and step 16's URL
  is right.

## Step 18 — Teach the Mind the contract  (Terminal 2)

```bash
npm run ops -- ops/install-playbook.ts "$(grep '^RELAY_BASE_URL=' .dev.vars | cut -d= -f2-)" "$(cat .relay-key)"
```

**Expect:**

```
  contract stored in LTM:  true (ltmKey=x_relay_contract_v1)
  relay key present:       true
  key last4 matches:       true
  base url acknowledged:   true
```

> This writes the relay key into the Mind's conversation history — unavoidable in v1,
> because the platform has no API for storing secrets. Rotate it when you're done
> testing: step 21.

## Step 19 — Ask the Mind for status  (Terminal 2)

```bash
npm run ops -- ops/ask-mind-to-post.ts --status
```

**Expect** `"httpStatus": 200` and `"status": "active"` with your handle. The Mind just
called your relay successfully.

## Step 20 — Have the Mind post, then verify it really did  (Terminal 2)

```bash
npm run ops -- ops/ask-mind-to-post.ts "Testing my own X connector. It works."
```

**Expect** `"outcome": "pending_approval"` with an `approveUrl`, and the Mind explicitly
saying it did **not** post.

**Now verify server-side. Do not take the Mind's word for it:**

```bash
sh ops/relay.sh audit
```

**Expect a row with `via=mind`:**

```
  time (UTC)           via       route           code                   http
  2026-07-31 12:30:02  mind      x/post          pending_approval       202
```

That row is the proof. A Mind will occasionally report a result it remembered rather than
one it fetched — if there's no `via=mind` row, it didn't actually call, no matter what it
said.

Open the `approveUrl` and click Approve to send the Mind's post for real.

## Step 21 — Rotate the key and restore safe defaults  (Terminal 2)

```bash
sh ops/relay.sh rotate
npm run ops -- ops/install-playbook.ts "$(grep '^RELAY_BASE_URL=' .dev.vars | cut -d= -f2-)" "$(cat .relay-key)"
sh ops/relay.sh set '{"requireApproval":true,"dailyCap":3,"minIntervalSec":3600,"budgetUsdMonth":5}'
```

The old key keeps working for 24 hours, which is why you re-install the playbook before
it dies.

### Step 28 — the content loop

```bash
npm run ops -- ops/daily-loop.ts --dry-run
npm run ops -- ops/daily-loop.ts --topic "your topic here"
```

**How this one is built, because it differs from Step 26 on purpose.** The Mind only
*writes* the post; this script performs the HTTP call itself. An earlier version asked the
Mind to do both, and it replayed a previous answer verbatim — reporting `dry_run` on a run
that never requested one — without calling the relay at all. Prompting does not reliably
fix an agent that skips a side effect and reports success, so the side effect now lives in
code that cannot skip it.

Two safeguards you'll see in the output:

- **`request id`** — a fresh random value each run. The Mind must echo it back, which is
  how replayed text is caught before anything is published.
- **`verified: relay recorded this exact call (nonce=...)`** — the same value is looked up
  in the relay's audit log afterwards. A missing audit row is ambiguous; a *matching nonce*
  is proof, because the value did not exist before the run started.

If the Mind replays anyway, the script retries once in a brand-new conversation, which
removes the history there is to replay from. You'll see `attempt 2 (fresh conversation)`.

Expect:

```
  attempt 1 (primary) -> relay:x-daily-2026-07-31
  request id: n7ys8j9ab33ym
  draft   : Your slowest pages reveal agents first. Humans bounce; agents wait...
  chars   : 129 (Mind said 129)
  posted  : http 202
  APPROVE : https://.../approve/14?t=...
  verified: relay recorded this exact call (nonce=n7ys8j9ab33ym, via=cron, code=dry_run)
```

`via=cron` is correct here — this script, not the Mind, made the call.

---

# If something goes wrong

| What you see | What it means |
|---|---|
| `Cannot reach the relay` | Terminal 1 stopped. Re-run `npx wrangler dev` |
| `No relay key yet` | Step 3 hasn't run, or `.relay-key` was deleted |
| `unauthorized_client` / `invalid_client` | You used the API Key/Secret instead of the **OAuth 2.0** Client ID/Secret |
| Callback URL mismatch | Registered URI differs — check for `localhost` vs `127.0.0.1`, or a trailing slash |
| Connected, but posting gives `x_forbidden` | App is Read-only. Fix in portal, then **redo step 4** |
| `X did not return a refresh token` | `offline.access` scope missing |
| `x_credits_exhausted` | No prepaid credits on the X developer account |
| `url_not_allowed` | Working as designed. Add `allowUrl` only if you really want the $0.20 post |
| `min_interval_not_elapsed` | One post/hour by default. `sh ops/relay.sh set '{"minIntervalSec":0}'` |
| `daily_cap_reached` | Three/day by default. `sh ops/relay.sh set '{"dailyCap":10}'` |
| `duplicate_recent_text` | You already posted that exact text in the last 7 days. X bans duplicates — change the wording |
| Mind claims success, no tweet | `sh ops/relay.sh audit`. No `via=mind` row means it never called |
| Mind uses `127.0.0.1` | `RELAY_BASE_URL` was stale at step 18. Redo steps 16 and 18 |

Handy inspection commands:

```bash
sh ops/relay.sh user     # full account state and guardrail settings
sh ops/relay.sh posts    # every post attempt and its outcome
sh ops/relay.sh audit    # every request that reached the relay
sh ops/relay.sh tokens   # token status, expiry, and proof of encryption
```

To wipe everything and start over:

```bash
sh ops/setup-local.sh --reset
rm -f .relay-key
```

---

# When you're finished testing

- Disable the diagnostic echo route: set `DEBUG_ECHO_ENABLED=false` in `.dev.vars`.
- The ngrok URL dies when Terminal 3 closes. For a permanent URL, deploy to Cloudflare —
  needs `npx wrangler login`, then the remote D1/KV and secret steps in
  [README.md](README.md).
