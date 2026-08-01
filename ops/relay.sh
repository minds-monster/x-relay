#!/bin/sh
# Thin CLI over the relay's HTTP API, so testing doesn't require long curl lines.
#
# Reads ADMIN_KEY and RELAY_BASE_URL from .dev.vars, and the relay key from .relay-key
# (written by `relay.sh provision`). Both files are gitignored.
#
#   sh ops/relay.sh health
#   sh ops/relay.sh provision <clientId> <clientSecret>
#   sh ops/relay.sh credentials <clientId> <clientSecret>   # replace on existing user
#   sh ops/relay.sh connect                                 # print the authorize URL
#   sh ops/relay.sh me
#   sh ops/relay.sh refresh
#   sh ops/relay.sh dry "text"
#   sh ops/relay.sh post "text" [idempotencyKey]
#   sh ops/relay.sh delete <tweetId>
#   sh ops/relay.sh user                                    # full user record
#   sh ops/relay.sh audit                                   # what actually hit the relay
#   sh ops/relay.sh posts
#   sh ops/relay.sh set '<json>'                            # e.g. '{"requireApproval":false}'
#
# Scheduling — the relay posts on a schedule; content Minds only submit drafts.
#   sh ops/relay.sh slots                                   # show the schedule
#   sh ops/relay.sh slots 09:00 13:00 18:00                 # set it (UTC, always)
#   sh ops/relay.sh hold <seconds>                          # veto window before each slot
#   sh ops/relay.sh queue                                   # what is waiting, and when
#   sh ops/relay.sh submit "text" [submissionId]            # enqueue a draft by hand
#   sh ops/relay.sh unqueue <queueId>
#
# Keys — one per content Mind, so revoking one does not silence the rest.
#   sh ops/relay.sh keys                                    # list
#   sh ops/relay.sh key-add <label>                         # mint an additional key
#   sh ops/relay.sh key-revoke <keyId>
#
# Set RELAY_ENV=prod to target the deployed relay (config from .env.prod, D1 --remote).
set -e
cd "$(dirname "$0")/.."

USER_ID="${RELAY_USER_ID:-adam}"
KEY_FILE=".relay-key"

# Read from .env.prod if RELAY_ENV=prod, otherwise .dev.vars
if [ "$RELAY_ENV" = "prod" ]; then
  ENV_FILE=".env.prod"
  if [ ! -f "$ENV_FILE" ]; then
    echo "No .env.prod found. Create it with RELAY_BASE_URL and ADMIN_KEY" >&2
    exit 1
  fi
else
  ENV_FILE=".dev.vars"
  if [ ! -f "$ENV_FILE" ]; then
    echo "No .env.vars found. Run:  sh ops/setup-local.sh" >&2
    exit 1
  fi
fi

ADMIN_KEY=$(grep '^ADMIN_KEY=' "$ENV_FILE" | cut -d= -f2-)
BASE=$(grep '^RELAY_BASE_URL=' "$ENV_FILE" | cut -d= -f2- || true)
[ -n "$BASE" ] || BASE="http://127.0.0.1:8787"

# Pretty-print JSON if python3 is around; otherwise pass through untouched.
pp() { if command -v python3 > /dev/null 2>&1; then python3 -m json.tool 2>/dev/null || cat; else cat; fi; }

relay_key() {
  if [ ! -f "$KEY_FILE" ]; then
    echo "No relay key yet. Run:  sh ops/relay.sh provision <clientId> <clientSecret>" >&2
    exit 1
  fi
  cat "$KEY_FILE"
}

# Reachability check with a clear message, since "connection refused" confuses everyone.
#
# Retries three times with a generous timeout: through an ngrok tunnel the first request
# after an idle period regularly takes several seconds, and a single short timeout made
# every command intermittently claim the relay was down when it was fine.
require_up() {
  i=1
  while [ "$i" -le 3 ]; do
    if curl -s -m 20 "$BASE/health" > /dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
  done
  echo "Cannot reach the relay at $BASE (3 attempts)" >&2
  echo "Is 'npx wrangler dev' running in another terminal?" >&2
  if [ "${BASE#https://}" != "$BASE" ]; then
    echo "This is a tunnel URL — also check that 'ngrok http 8787' is still running." >&2
  fi
  exit 1
}

# Follow RELAY_ENV. Reading the local database while `me` and `post` talk to production
# is the most confusing possible failure, so the target is derived from one variable and
# printed on every direct-SQL command.
if [ "$RELAY_ENV" = "prod" ]; then D1_SCOPE="--remote"; else D1_SCOPE="--local"; fi
sql() { npx wrangler d1 execute x-relay $D1_SCOPE --command "$1" --json 2>/dev/null; }
say_target() { echo "  [$BASE  d1$D1_SCOPE]"; }

cmd="${1:-help}"
shift 2> /dev/null || true

case "$cmd" in

health)
  curl -s "$BASE/health" | pp
  ;;

provision)
  require_up
  [ -n "$1" ] || { echo "Usage: sh ops/relay.sh provision <clientId> <clientSecret>" >&2; exit 2; }
  [ -n "$2" ] || { echo "Missing clientSecret." >&2; exit 2; }
  out=$(curl -s -XPOST "$BASE/admin/users" \
    -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
    -d "{\"userId\":\"$USER_ID\",\"label\":\"$USER_ID\",\"x\":{\"clientId\":\"$1\",\"clientSecret\":\"$2\",\"clientType\":\"confidential\"}}")
  echo "$out" | pp
  key=$(echo "$out" | sed -n 's/.*"relayKey":"\([^"]*\)".*/\1/p')
  if [ -n "$key" ]; then
    printf '%s' "$key" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo
    echo "Relay key saved to $KEY_FILE (gitignored). Later commands read it automatically."
  else
    echo
    case "$out" in
      *already\ exists*)
        echo "This user already exists from an earlier run. To attach these credentials" >&2
        echo "to it instead, run:" >&2
        echo >&2
        echo "  sh ops/relay.sh credentials '$1' '<your client secret>'" >&2
        echo >&2
        echo "Then mint a fresh relay key with:  sh ops/relay.sh rotate" >&2
        ;;
      *) echo "No relayKey in the response — see the error above." >&2 ;;
    esac
    exit 1
  fi
  ;;

credentials)
  require_up
  [ -n "$1" ] || { echo "Usage: sh ops/relay.sh credentials <clientId> <clientSecret>" >&2; exit 2; }
  curl -s -XPUT "$BASE/admin/users/$USER_ID/x-credentials" \
    -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
    -d "{\"clientId\":\"$1\",\"clientSecret\":\"$2\",\"clientType\":\"confidential\"}" | pp
  ;;

connect)
  require_up
  echo "Open this in your browser to connect the X account:"
  echo
  echo "  $BASE/x/oauth/start?user=$USER_ID"
  echo
  ;;

me)
  require_up
  curl -s "$BASE/x/me" -H "Authorization: Bearer $(relay_key)" | pp
  ;;

refresh)
  require_up
  curl -s -XPOST "$BASE/x/refresh" -H "Authorization: Bearer $(relay_key)" | pp
  ;;

dry)
  require_up
  [ -n "$1" ] || { echo 'Usage: sh ops/relay.sh dry "text"' >&2; exit 2; }
  body=$(TEXT="$1" python3 -c 'import json,os;print(json.dumps({"text":os.environ["TEXT"],"dryRun":True}))')
  curl -s -XPOST "$BASE/x/post" -H "Authorization: Bearer $(relay_key)" \
    -H 'content-type: application/json' -d "$body" | pp
  ;;

post)
  require_up
  [ -n "$1" ] || { echo 'Usage: sh ops/relay.sh post "text" [idempotencyKey]' >&2; exit 2; }
  body=$(TEXT="$1" IDEM="${2:-}" python3 -c '
import json, os
d = {"text": os.environ["TEXT"]}
if os.environ.get("IDEM"): d["idempotencyKey"] = os.environ["IDEM"]
print(json.dumps(d))')
  curl -s -XPOST "$BASE/x/post" -H "Authorization: Bearer $(relay_key)" \
    -H 'content-type: application/json' -d "$body" | pp
  ;;

delete)
  require_up
  [ -n "$1" ] || { echo "Usage: sh ops/relay.sh delete <tweetId>" >&2; exit 2; }
  curl -s -XDELETE "$BASE/x/post/$1" -H "Authorization: Bearer $(relay_key)" | pp
  ;;

user)
  require_up
  curl -s "$BASE/admin/users/$USER_ID" -H "X-Admin-Key: $ADMIN_KEY" | pp
  ;;

set)
  require_up
  [ -n "$1" ] || { echo "Usage: sh ops/relay.sh set '{\"requireApproval\":false}'" >&2; exit 2; }
  curl -s -XPATCH "$BASE/admin/users/$USER_ID" \
    -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' -d "$1" | pp
  ;;

rotate)
  require_up
  out=$(curl -s -XPOST "$BASE/admin/users/$USER_ID/rotate-key" -H "X-Admin-Key: $ADMIN_KEY")
  echo "$out" | pp
  key=$(echo "$out" | sed -n 's/.*"relayKey":"\([^"]*\)".*/\1/p')
  if [ -n "$key" ]; then
    printf '%s' "$key" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo
    echo "New key saved to $KEY_FILE. Re-run install-playbook within 24h, then the old key dies."
  fi
  ;;

slots)
  require_up
  if [ -z "$1" ]; then
    curl -s "$BASE/admin/users/$USER_ID" -H "X-Admin-Key: $ADMIN_KEY" |
      python3 -c '
import sys, json
u = json.load(sys.stdin).get("user", {})
slots = u.get("slotsUtc") or []
print("  slots (UTC)     : %s" % (" ".join(slots) if slots else "(none — nothing will post)"))
print("  hold window     : %ss before each slot" % u.get("holdSec"))
print("  queue ttl       : %ss" % u.get("queueTtlSec"))
print("  min interval    : %ss" % u.get("minIntervalSec"))
print("  rolling 24h cap : %s   (a safety ceiling, not the schedule)" % u.get("rate24hCap"))
print("  requireApproval : %s" % u.get("requireApproval"))'
  else
    body=$(python3 -c 'import json,sys; print(json.dumps({"slotsUtc": sys.argv[1:]}))' "$@")
    curl -s -XPATCH "$BASE/admin/users/$USER_ID" \
      -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' -d "$body" | pp
  fi
  ;;

hold)
  require_up
  [ -n "$1" ] || { echo "Usage: sh ops/relay.sh hold <seconds>" >&2; exit 2; }
  curl -s -XPATCH "$BASE/admin/users/$USER_ID" \
    -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
    -d "{\"holdSec\":$1}" | pp
  ;;

queue)
  require_up
  curl -s "$BASE/x/queue" -H "Authorization: Bearer $(relay_key)" |
    python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("ok"): print(json.dumps(d, indent=2)); sys.exit(1)
print("  slots: %s   next: %s" % (" ".join(d.get("slotsUtc") or []) or "(none)", d.get("nextSlotUtc") or "-"))
pending = d.get("pending") or []
if not pending: print("  (queue empty)"); sys.exit()
for p in pending:
    print("  #%-4s %-7s %-24s %s" % (p["queueId"], p["status"], p.get("slotUtc") or "-", p["text"][:60]))'
  ;;

submit)
  require_up
  [ -n "$1" ] || { echo 'Usage: sh ops/relay.sh submit "text" [submissionId]' >&2; exit 2; }
  body=$(TEXT="$1" SID="${2:-}" python3 -c '
import json, os, hashlib, time
text = os.environ["TEXT"]
# Without an explicit id, derive a stable one from the text so a re-run of the same
# command enqueues once rather than twice.
sid = os.environ.get("SID") or "cli-" + hashlib.sha256(text.encode()).hexdigest()[:16]
print(json.dumps({"text": text, "submissionId": sid, "source": "cli"}))')
  curl -s -XPOST "$BASE/x/queue" -H "Authorization: Bearer $(relay_key)" \
    -H 'content-type: application/json' -d "$body" | pp
  ;;

unqueue)
  require_up
  [ -n "$1" ] || { echo "Usage: sh ops/relay.sh unqueue <queueId>" >&2; exit 2; }
  curl -s -XDELETE "$BASE/x/queue/$1" -H "Authorization: Bearer $(relay_key)" | pp
  ;;

keys)
  require_up
  curl -s "$BASE/admin/users/$USER_ID/keys" -H "X-Admin-Key: $ADMIN_KEY" |
    python3 -c '
import sys, json
for k in json.load(sys.stdin).get("keys", []):
    print("  %-14s %-8s created=%s%s" % (
        k["keyId"], "active" if k["active"] else "inactive", k["createdAt"][:19],
        "  expires=" + k["expiresAt"][:19] if k.get("expiresAt") else ""))'
  ;;

key-add)
  require_up
  [ -n "$1" ] || { echo "Usage: sh ops/relay.sh key-add <label>   # e.g. news-mind" >&2; exit 2; }
  curl -s -XPOST "$BASE/admin/users/$USER_ID/keys" \
    -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
    -d "{\"label\":\"$1\"}" | pp
  echo
  echo "Shown once. Install it into that Mind with:"
  echo "  npm run ops -- ops/install-playbook.ts $BASE '<the key above>' \\"
  echo "      --playbook x-queue-v1 --alias relay:$1"
  ;;

key-revoke)
  require_up
  [ -n "$1" ] || { echo "Usage: sh ops/relay.sh key-revoke <keyId>" >&2; exit 2; }
  curl -s -XDELETE "$BASE/admin/users/$USER_ID/keys/$1" -H "X-Admin-Key: $ADMIN_KEY" | pp
  ;;

# Ground truth: what actually reached the relay. A Mind's self-report is not evidence.
audit)
  say_target
  sql "SELECT datetime(ts,'unixepoch') AS t, via, route, code, http_status FROM audit ORDER BY id DESC LIMIT 12" |
    python3 -c '
import sys, json
try: rows = json.load(sys.stdin)[0]["results"]
except Exception: print("  (no audit rows yet)"); sys.exit()
if not rows: print("  (no audit rows yet)"); sys.exit()
print("  %-20s %-9s %-21s %-22s %s" % ("time (UTC)","via","route","code","http"))
for r in rows:
    print("  %-20s %-9s %-21s %-22s %s" % (r["t"], r["via"] or "-", r["route"], r["code"] or "-", r["http_status"] or "-"))'
  ;;

posts)
  say_target
  sql "SELECT id, status, via, x_tweet_id, error_code, substr(text,1,44) AS txt FROM posts ORDER BY id DESC LIMIT 12" |
    python3 -c '
import sys, json
try: rows = json.load(sys.stdin)[0]["results"]
except Exception: print("  (no posts yet)"); sys.exit()
if not rows: print("  (no posts yet)"); sys.exit()
for r in rows:
    print("  #%-3s %-17s via=%-9s tweet=%-20s %s" % (
        r["id"], r["status"], r["via"] or "-", r["x_tweet_id"] or r["error_code"] or "-", r["txt"]))'
  ;;

tokens)
  sql "SELECT status, x_handle, substr(tokens_enc,1,16) AS token_ciphertext, datetime(expires_at,'unixepoch') AS expires FROM users" |
    python3 -c '
import sys, json
rows = json.load(sys.stdin)[0]["results"]
for r in rows: print("  status=%s handle=%s expires=%s ciphertext=%s..." % (
    r["status"], r["x_handle"], r["expires"], r["token_ciphertext"]))'
  ;;

*)
  # Print the usage comment block at the top of this file (stops at the first non-comment).
  sed -n '2,${/^[^#]/q;p;}' "$0" | sed 's/^# \{0,1\}//'
  ;;
esac
