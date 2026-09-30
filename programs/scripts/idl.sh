#!/usr/bin/env bash
# Generate the Anchor IDL for the escrow into target/idl/ (host build with the idl-build feature).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGAVE_BIN="${AGAVE_BIN:-$HOME/.local/share/agave/solana-release/bin}"
export PATH="$AGAVE_BIN:$PATH"
cd "$ROOT"
mkdir -p target/idl
anchor idl build -p repo_donation_escrow -o target/idl/repo_donation_escrow.json
echo "IDL written to $ROOT/target/idl/repo_donation_escrow.json"
