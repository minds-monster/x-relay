# Testing guide

Two phases. **Phase A** gets a real tweet out with the fewest moving parts — no tunnel,
no Mind, no Cloudflare account. **Phase B** puts the Mind in the loop. Do A first; if A
fails, B has nothing to stand on.

Total cost of a full pass: **under $0.10.** Every test post is link-free at $0.015, plus a
couple of $0.001 identity reads.

---

## Phase A — prove a real tweet (no tunnel, no Mind)

### A1. Set up the X app  (~10 min, in a browser)

Go to <https://developer.x.com> → sign in with the X account you want to post as.

1. **Create a Project, then an App inside it.** X requires the app to live in a project.
2. Open the app → **User authentication settings** → *Set up*. This is the part that
   matters; getting it wrong is the most common failure:

   | Setting | Value |
   |---|---|
   | App permissions | **Read and write** ← not "Read only" |
   | Type of App | **Web App, Automated App or Bot** (confidential client) |
   | Callback URI / Redirect URL | `http://127.0.0.1:8787/x/oauth/callback` |
   | Website URL | anything valid, e.g. `https://example.com` |

   Use the literal `127.0.0.1`. X commonly rejects `localhost`.

3. Save, then copy the **OAuth 2.0 Client ID and Client Secret**.
   These are *not* the "API Key / API Secret" pair shown elsewhere on the page — that's
   OAuth 1.0a and will not work here. The secret is shown once.

4. **Add credits.** Developer portal → billing → load prepaid credits. $5 is plenty;
   the minimum X offers is fine. Without credits `POST /2/tweets` fails even with
   perfect auth.

> If you later change **App permissions**, you must re-authorize — existing tokens keep
> the scopes they were granted with. Re-run step A4.

### A2. Start the relay

```bash
cd ~/adam-mind
sh ops/setup-local.sh          # add --reset to wipe previous local data
npx wrangler dev               # leave running in this terminal
```

In a second terminal:

```bash
cd ~/adam-mind
export ADMIN_KEY=$(grep '^ADMIN_KEY=' .dev.vars | cut -d= -f2)
curl -s localhost:8787/health
```

**Expect:** `"ok": true` with `db: ok`, `kv: ok`, and all three secrets `set`.

### A3. Provision your user

```bash
curl -s -XPOST localhost:8787/admin/users \
  -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{
    "userId": "adam",
    "label": "Adam Place",
    "x": {
      "clientId": "PASTE_OAUTH2_CLIENT_ID",
      "clientSecret": "PASTE_OAUTH2_CLIENT_SECRET",
      "clientType": "confidential"
    }
  }'
```

**Expect** `201` with a `relayKey` (starts `xr_test_`) and an `authorizeUrl`.
**Save the relayKey now — it is shown once.**

```bash
export RELAY_KEY=xr_test_...paste...
```

If the user already exists from an earlier run, attach the real credentials instead:

```bash
curl -s -XPUT localhost:8787/admin/users/adam/x-credentials \
  -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"clientId":"...","clientSecret":"...","clientType":"confidential"}'
```

### A4. Connect your X account

Open this in your browser:

```
http://127.0.0.1:8787/x/oauth/start?user=adam
```

You'll land on X's consent screen. Approve. You should return to a page saying
**"X account connected"** with your handle and the granted scopes.

**Expect the scope list to include `offline.access`.** If it doesn't, the relay refuses
the connection and tells you so — without it X issues no refresh token and the
integration dies in two hours.

Verify, and prove the tokens are encrypted at rest:

```bash
curl -s localhost:8787/x/me -H "Authorization: Bearer $RELAY_KEY"

# Should print nothing at all — the access token must not appear in the database:
grep -ra "$(curl -s localhost:8787/x/me -H "Authorization: Bearer $RELAY_KEY" | head -c0)" .wrangler 2>/dev/null
npx wrangler d1 execute x-relay --local --command \
  "SELECT substr(tokens_enc,1,20) AS ciphertext, status, x_handle FROM users"
```

**Expect:** `status: "active"`, your real `xHandle`, `tokenExpiresAt` about 2 hours out,
and `ciphertext` beginning `v1.` rather than anything readable.

### A5. The refresh test — do this before trusting anything

This is the single most important test. X **invalidates the old refresh token every time
you refresh**, so a persistence bug here silently bricks the account later.

```bash
curl -s -XPOST localhost:8787/x/refresh -H "Authorization: Bearer $RELAY_KEY"
curl -s -XPOST localhost:8787/x/refresh -H "Authorization: Bearer $RELAY_KEY"
```

**Expect both calls to return `"ok": true`** with `refreshTokenRotated: true` and an
`expiresAt` that moves forward each time. If the *second* call fails, stop — rotation is
not being persisted and nothing downstream is safe.

Optional race check (exactly one should do the exchange, the other waits):

```bash
curl -s -XPOST localhost:8787/x/refresh -H "Authorization: Bearer $RELAY_KEY" &
curl -s -XPOST localhost:8787/x/refresh -H "Authorization: Bearer $RELAY_KEY" &
wait
```

### A6. Dry run, then the real tweet

```bash
# Costs nothing, touches X not at all:
curl -s -XPOST localhost:8787/x/post -H "Authorization: Bearer $RELAY_KEY" \
  -H 'content-type: application/json' \
  -d '{"text":"relay smoke test 7f3a","dryRun":true}'
```

**Expect** `dryRun: true`, `chars: 21`, `costEstimateUsd: 0.015`, `requireApproval: true`.

Approval is on by default, so a real call parks a draft rather than posting. For this
first end-to-end test, turn it off so you can see the whole path:

```bash
curl -s -XPATCH localhost:8787/admin/users/adam \
  -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"requireApproval": false, "minIntervalSec": 0}'

# The real thing — this posts to X and costs $0.015:
curl -s -XPOST localhost:8787/x/post -H "Authorization: Bearer $RELAY_KEY" \
  -H 'content-type: application/json' \
  -d '{"text":"relay smoke test 7f3a","idempotencyKey":"smoke-1"}'
```

**Expect** `201` with `id`, a working `url`, and `costEstimateUsd: 0.015`.
**Check your timeline.** This is the milestone.

### A7. Prove idempotency — re-run the exact same command

```bash
curl -s -XPOST localhost:8787/x/post -H "Authorization: Bearer $RELAY_KEY" \
  -H 'content-type: application/json' \
  -d '{"text":"relay smoke test 7f3a","idempotencyKey":"smoke-1"}'
```

**Expect** `200` with `"idempotent": true`, the same tweet id, and **no second tweet on
your timeline.** This is what makes a Mind retry safe.

### A8. Prove the cost guard

```bash
curl -s -XPOST localhost:8787/x/post -H "Authorization: Bearer $RELAY_KEY" \
  -H 'content-type: application/json' \
  -d '{"text":"read more at example.com","idempotencyKey":"url-1"}'
```

**Expect** `400 url_not_allowed` explaining the $0.200-vs-$0.015 difference. Nothing was
posted and nothing was charged.

### A9. Test the approval path, then clean up

```bash
curl -s -XPATCH localhost:8787/admin/users/adam \
  -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"requireApproval": true}'

curl -s -XPOST localhost:8787/x/post -H "Authorization: Bearer $RELAY_KEY" \
  -H 'content-type: application/json' \
  -d '{"text":"approval path test b91c","idempotencyKey":"appr-1"}'
```

**Expect** `202` with `status: "pending_approval"` and an `approveUrl`. Nothing posted
yet. Open the `approveUrl` in a browser — you should see the draft, its character count
and cost, with **Approve** and **Reject** buttons. Click Approve; the tweet goes out.

Delete your test tweets when done:

```bash
curl -s -XDELETE localhost:8787/x/post/<tweetId> -H "Authorization: Bearer $RELAY_KEY"
```

**Phase A passes when:** a real tweet appeared, the identical retry produced no second
tweet, two consecutive refreshes both succeeded, and the link post was refused.

---

## Phase B — put the Mind in the loop

The Mind runs on Animoca's servers, so it cannot reach `127.0.0.1`. It needs a public
URL: a tunnel (fastest) or a real deploy.

### B1. Expose the relay

```bash
# terminal 3
ngrok http 8787
```

Copy the `https://...ngrok-free.dev` URL. Then point the relay at it — this matters,
because `RELAY_BASE_URL` is what OAuth and approval links are built from, and a stale
value produces links pointing at localhost that the Mind cannot use:

```bash
sed -i '' "s|^RELAY_BASE_URL=.*|RELAY_BASE_URL=https://YOUR-TUNNEL.ngrok-free.dev|" .dev.vars
sed -i '' "s|^RELAY_BASE_URL=.*|RELAY_BASE_URL=https://YOUR-TUNNEL.ngrok-free.dev|" .env
```

Restart `wrangler dev` so it picks up the change, then confirm from outside:

```bash
curl -s https://YOUR-TUNNEL.ngrok-free.dev/health
```

Also add the tunnel callback to your X app's callback URI list —
`https://YOUR-TUNNEL.ngrok-free.dev/x/oauth/callback` — and re-run A4 against it if you
want OAuth to work through the tunnel too.

### B2. Confirm the Mind can authenticate to the relay

```bash
npm run ops -- ops/probe-relay-echo.ts https://YOUR-TUNNEL.ngrok-free.dev
```

**Expect** `CONFIRMED: HTTP_Execute forwards Authorization: Bearer and a JSON body`, with
the bearer last-4 matching the canary. (This already passed in development; re-run it
because a tunnel or proxy can strip headers.)

### B3. Install the contract

```bash
npm run ops -- ops/install-playbook.ts https://YOUR-TUNNEL.ngrok-free.dev "$RELAY_KEY"
```

**Expect** `contract stored in LTM: true` and `key last4 matches: true`.

> This writes the relay key into the Mind's conversation transcript — there is no
> tenet-write API to avoid it. Rotate afterwards:
> `curl -XPOST $BASE/admin/users/adam/rotate-key -H "X-Admin-Key: $ADMIN_KEY"`,
> then re-run B3 with the new key within the 24h grace window.

### B4. Mind-driven status, then a Mind-driven post

```bash
npm run ops -- ops/ask-mind-to-post.ts --status
npm run ops -- ops/ask-mind-to-post.ts "Testing my own X connector. It works."
```

**Expect** `httpStatus: 200` then a `202 pending_approval` (approval is back on) with the
Mind explicitly declining to claim the post is live.

**Then verify server-side — do not take the Mind's word for it:**

```bash
npx wrangler d1 execute x-relay --local --command \
  "SELECT via, route, code, http_status FROM audit ORDER BY id DESC LIMIT 5"
```

**Expect a row with `via='mind'`.** That is what distinguishes a genuine Mind call from
your own curl. A Mind will sometimes report a remembered result rather than making the
call — this check is how you catch it.

### B5. The content loop

```bash
npm run ops -- ops/daily-loop.ts --dry-run
npm run ops -- ops/daily-loop.ts --topic "your topic here"
```

It prints the cognition balance, the draft the Mind wrote, the outcome, and a
`verified:` line cross-checking the relay's audit log. It exits non-zero if the relay
never saw the call.

**Phase B passes when:** a Mind-driven request appears in the audit table with
`via='mind'`, and approving the resulting draft produces a real tweet.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `unauthorized_client` / `invalid_client` at token exchange | Using the API Key/Secret instead of the **OAuth 2.0** Client ID/Secret, or `clientType` should be `public` |
| Callback URL mismatch | Registered URI differs by even a trailing slash, or you used `localhost` instead of `127.0.0.1` |
| Connected, but posting returns 403 | App permissions are Read-only. Set Read and write, then **re-authorize** (A4) |
| `X did not return a refresh token` | `offline.access` missing from the granted scopes |
| `x_credits_exhausted` | No prepaid credits on the X developer account |
| `url_not_allowed` | Working as intended — pass `allowUrl: true` if you really want the $0.200 post |
| `min_interval_not_elapsed` | Default is 1 post/hour. `{"minIntervalSec": 0}` while testing |
| `daily_cap_reached` | Default is 3/day. Raise with `{"dailyCap": 10}` |
| Mind reports success but no tweet | Check the audit table. If there's no `via='mind'` row, it answered from memory |
| Mind uses `127.0.0.1` as its base URL | `RELAY_BASE_URL` was stale when the playbook was installed. Fix it, restart, re-run B3 |

Useful state dumps:

```bash
curl -s localhost:8787/admin/users/adam -H "X-Admin-Key: $ADMIN_KEY"
curl -s "localhost:8787/admin/users/adam/recent?sinceSec=3600" -H "X-Admin-Key: $ADMIN_KEY"
npx wrangler d1 execute x-relay --local --command \
  "SELECT id,status,via,error_code,substr(text,1,40) FROM posts ORDER BY id DESC LIMIT 10"
```

---

## After testing

- Reset guardrails to something sane: `{"requireApproval": true, "dailyCap": 3, "minIntervalSec": 3600, "budgetUsdMonth": 5}`.
- Rotate the relay key if the playbook was installed with it.
- Disable the diagnostic echo route once `HTTP_Execute` behaviour is settled:
  `DEBUG_ECHO_ENABLED=false`.
- For a permanent URL instead of a tunnel, deploy: needs `npx wrangler login`, then the
  remote D1/KV creation and `wrangler secret put` steps in [README.md](README.md).
