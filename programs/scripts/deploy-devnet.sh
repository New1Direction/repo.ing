#!/usr/bin/env bash
# Deploy the repo donation escrow to DEVNET and initialise its config.
#
# DEVNET ONLY. This script refuses to run against any cluster whose genesis hash
# is not devnet's, never reads ~/.config/solana/id.json, and uses a throwaway
# deployer keypair it generates under programs/target/deploy/ (gitignored).
#
# Usage: programs/scripts/deploy-devnet.sh
#   DEVNET_RPC_URL   override RPC (must still be devnet; default public devnet)
#   ESCROW_VERIFIER  verifier pubkey (default: deployer; replace before any real use)
#   ESCROW_ADMIN / ESCROW_ALLOWLIST_AUTHORITY  (default: deployer)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGAVE_BIN="${AGAVE_BIN:-$HOME/.local/share/agave/solana-release/bin}"
export PATH="$AGAVE_BIN:$PATH"

DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
RPC_URL="${DEVNET_RPC_URL:-https://api.devnet.solana.com}"
DEPLOYER="$ROOT/target/deploy/devnet-deployer-keypair.json"
PROGRAM_KEYPAIR="$ROOT/target/deploy/repo_donation_escrow-keypair.json"
PROGRAM_SO="$ROOT/target/deploy/repo_donation_escrow.so"
MIN_BALANCE_SOL=4

genesis="$(solana genesis-hash --url "$RPC_URL")"
if [[ "$genesis" != "$DEVNET_GENESIS" ]]; then
  echo "refusing: $RPC_URL has genesis $genesis, not devnet ($DEVNET_GENESIS)" >&2
  exit 1
fi

test -f "$PROGRAM_SO" || "$ROOT/scripts/build.sh" build
test -f "$PROGRAM_KEYPAIR" || { echo "missing $PROGRAM_KEYPAIR (program id keypair)" >&2; exit 1; }

declared_id="$(grep -o 'declare_id!("[^"]*")' "$ROOT/repo-donation-escrow/src/lib.rs" | cut -d'"' -f2)"
keypair_id="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
if [[ "$declared_id" != "$keypair_id" ]]; then
  echo "declare_id ($declared_id) != program keypair ($keypair_id); update lib.rs + Anchor.toml and rebuild" >&2
  exit 1
fi

if [[ ! -f "$DEPLOYER" ]]; then
  solana-keygen new --no-bip39-passphrase --silent -o "$DEPLOYER"
fi
deployer_pubkey="$(solana-keygen pubkey "$DEPLOYER")"
echo "deployer: $deployer_pubkey   program: $keypair_id"

balance_sol() { solana balance --url "$RPC_URL" "$deployer_pubkey" | awk '{print int($1)}'; }
attempts=0
while (( $(balance_sol) < MIN_BALANCE_SOL )); do
  attempts=$((attempts + 1))
  if (( attempts > 4 )); then
    echo "devnet airdrop is not providing funds (rate-limited?)." >&2
    echo "Fund $deployer_pubkey with ${MIN_BALANCE_SOL} devnet SOL (e.g. https://faucet.solana.com) and re-run." >&2
    exit 2
  fi
  solana airdrop 2 "$deployer_pubkey" --url "$RPC_URL" || sleep 5
done

solana program deploy \
  --url "$RPC_URL" \
  --keypair "$DEPLOYER" \
  --upgrade-authority "$DEPLOYER" \
  --program-id "$PROGRAM_KEYPAIR" \
  "$PROGRAM_SO"

DEVNET_RPC_URL="$RPC_URL" \
DEPLOYER_KEYPAIR="$DEPLOYER" \
node "$ROOT/scripts/devnet-init-config.mjs"
