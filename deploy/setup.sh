#!/usr/bin/env bash
# One-shot deploy for the HSP A2A Settlement Terminal on a fresh Linux box
# (Ubuntu/Debian). Installs Node 20 + pnpm, installs deps, prints the egress IP
# you must give HSP, and starts the server.
#
# Usage (run from inside the project directory on the VM):
#   bash deploy/setup.sh            # mock mode (default)
#   HSP_MODE=live bash deploy/setup.sh   # live mode (needs allowlisted IP + wallet)
#
# Get the project onto the VM first, from your laptop:
#   rsync -av --exclude node_modules --exclude .git "hash key project/" user@<vm-ip>:~/hsp/
#   ssh user@<vm-ip> 'cd ~/hsp && bash deploy/setup.sh'
set -euo pipefail

echo "==> HSP A2A Settlement Terminal — VM setup"

# --- Node 20 via NodeSource (skip if already present and >= 20) ---
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] 2>/dev/null && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    node $(node -v)"

# --- pnpm via corepack ---
if ! command -v pnpm >/dev/null 2>&1; then
  echo "==> Enabling pnpm via corepack"
  sudo corepack enable || npm i -g pnpm
fi
echo "    pnpm $(pnpm -v)"

# --- install deps ---
echo "==> pnpm install"
pnpm install

# --- .env ---
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from .env.example — edit MERCHANT_NAME / SIGNER / BURNER_PRIVATE_KEY before live mode"
fi

# --- the IP to allowlist ---
echo ""
echo "============================================================"
echo "  Give THIS IP to HSP for QA allowlisting:"
echo -n "    IPv4: "; curl -s -4 -m10 https://api.ipify.org || echo "(could not detect)"
echo ""
echo -n "    IPv6: "; curl -s -6 -m10 https://api64.ipify.org 2>/dev/null || echo "(none / not used)"
echo ""
echo "  This box's IP is stable, so one allowlist request is enough."
echo "============================================================"
echo ""

MODE="${HSP_MODE:-mock}"
echo "==> Starting server in ${MODE} mode on port ${PORT:-4100}"
echo "    From your laptop:  ssh -L 4100:localhost:4100 <user>@<vm-ip>   then open http://localhost:4100"
echo ""
HSP_MODE="$MODE" pnpm server
