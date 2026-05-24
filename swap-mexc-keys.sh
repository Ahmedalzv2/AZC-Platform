#!/usr/bin/env bash
# Swap MEXC API key + secret in relay.env, restart the relay, verify.
# Run via: ssh -t root@srv1688368.hstgr.cloud bash /root/apps/ict-autopilot/swap-mexc-keys.sh
set -euo pipefail

ENV_FILE=/root/apps/ict-autopilot/relay.env
cd /root/apps/ict-autopilot

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

echo "Updating MEXC keys in $ENV_FILE"
read -r -s -p "MEXC_API_KEY: " KEY; echo
read -r -s -p "MEXC_API_SECRET: " SECRET; echo

if [[ -z "$KEY" || -z "$SECRET" ]]; then
  echo "ERROR: key or secret was empty — aborting" >&2
  exit 2
fi

python3 - "$ENV_FILE" "$KEY" "$SECRET" <<'PY'
import sys, re
path, key, secret = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    t = f.read()
t = re.sub(r'^MEXC_API_KEY=.*$', f'MEXC_API_KEY={key}', t, flags=re.M)
t = re.sub(r'^MEXC_API_SECRET=.*$', f'MEXC_API_SECRET={secret}', t, flags=re.M)
with open(path, 'w') as f:
    f.write(t)
PY

chmod 600 "$ENV_FILE"
echo "relay.env updated. Recreating container..."
docker compose -f docker-compose.relay.yml up -d --force-recreate >/dev/null
sleep 3
echo "--- verification ---"
docker exec ict-tv-relay node -e "console.log({K:!!process.env.MEXC_API_KEY, S:!!process.env.MEXC_API_SECRET, kLen:(process.env.MEXC_API_KEY||'').length})"
