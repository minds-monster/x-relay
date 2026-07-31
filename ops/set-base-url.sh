#!/bin/sh
# Point the relay at a public URL (tunnel or deployed origin).
#
#   sh ops/set-base-url.sh https://abc-123.ngrok-free.dev
#   sh ops/set-base-url.sh --local          # back to http://127.0.0.1:8787
#
# RELAY_BASE_URL is what OAuth redirect links and approval links are built from, so a
# stale value silently produces links pointing at localhost that the Mind cannot use.
# It lives in two files: .dev.vars (read by the Worker) and .env (read by ops scripts).
set -e
cd "$(dirname "$0")/.."

url="$1"
[ "$url" = "--local" ] && url="http://127.0.0.1:8787"

if [ -z "$url" ]; then
  echo "Usage: sh ops/set-base-url.sh <https://...>   |   --local" >&2
  echo "Current: $(grep '^RELAY_BASE_URL=' .dev.vars 2>/dev/null | cut -d= -f2- || echo '(unset)')" >&2
  exit 2
fi

case "$url" in
  http://*|https://*) ;;
  *) echo "URL must start with http:// or https:// — got: $url" >&2; exit 2 ;;
esac

# Strip any trailing slash: X requires the callback to match byte-for-byte.
url=$(printf '%s' "$url" | sed 's|/$||')

set_var() {
  file="$1"
  [ -f "$file" ] || return 0
  if grep -q '^RELAY_BASE_URL=' "$file"; then
    tmp="$file.tmp.$$"
    grep -v '^RELAY_BASE_URL=' "$file" > "$tmp"
    echo "RELAY_BASE_URL=$url" >> "$tmp"
    mv "$tmp" "$file"
  else
    echo "RELAY_BASE_URL=$url" >> "$file"
  fi
  chmod 600 "$file"
  echo "  updated $file"
}

set_var .dev.vars
set_var .env

echo
echo "RELAY_BASE_URL = $url"
echo
echo "Now RESTART the relay (Ctrl+C in Terminal 1, then: npx wrangler dev)"
case "$url" in
  https://*)
    echo
    echo "If you want OAuth to work through this URL too, add this callback in the X portal:"
    echo "  $url/x/oauth/callback"
    ;;
esac
