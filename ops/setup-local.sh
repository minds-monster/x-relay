#!/bin/sh
# Local bring-up for the X Relay. Idempotent — safe to re-run.
#
#   sh ops/setup-local.sh              prepare secrets + local D1
#   sh ops/setup-local.sh --reset      also wipe local posts/audit/users
#
# Does NOT touch remote Cloudflare resources and does NOT need `wrangler login`.
set -e
cd "$(dirname "$0")/.."

if [ ! -f .dev.vars ]; then
  echo "Generating .dev.vars with fresh secrets..."
  {
    echo "MASTER_KEY_B64=$(openssl rand -base64 32)"
    echo "ADMIN_KEY=$(openssl rand -hex 32)"
    echo "APPROVAL_HMAC_KEY=$(openssl rand -hex 32)"
    echo "RELAY_BASE_URL=http://127.0.0.1:8787"
  } > .dev.vars
  chmod 600 .dev.vars
  echo "  wrote .dev.vars (gitignored)"
else
  echo ".dev.vars already exists — leaving it alone."
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

echo "Applying schema to local D1..."
npx wrangler d1 execute x-relay --local --file=schema.sql > /dev/null
echo "  schema applied"

if [ "$1" = "--reset" ]; then
  echo "Resetting local data..."
  npx wrangler d1 execute x-relay --local \
    --command "DELETE FROM posts; DELETE FROM audit; DELETE FROM relay_keys; DELETE FROM users;" > /dev/null
  echo "  users, relay_keys, posts and audit cleared"
fi

echo
echo "ADMIN_KEY for curl calls:"
echo "  export ADMIN_KEY=$(grep '^ADMIN_KEY=' .dev.vars | cut -d= -f2)"
echo
echo "Next:  npx wrangler dev     then  curl -s localhost:8787/health"
