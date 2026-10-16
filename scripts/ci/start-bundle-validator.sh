#!/usr/bin/env bash
# Start a disposable solana-test-validator for the Bundle launch chain test (docs/BUNDLE_LAUNCH.md):
#   - the historical DBC fixture used by start-validator.sh, matching the version-0 launch-fee config snapshot;
#   - DAMM v2, Token-2022 and Metaplex token metadata programs read from mainnet with `solana program dump`;
#   - the DAMM v2 pool config a SOL curve migrates into (FixedBps100), the snapshot start-validator.sh loads;
#   - the bundle vault program (tests/fixtures/validator/bundle_vault.so, built by scripts/build-bundle-vault.sh) as an
#     upgradeable program whose upgrade authority is a test key written to <work-dir>/bundle-authority.json.
#   - a second copy of it at another address (<work-dir>/decoy-program.json) whose upgrade authority is another key
#     (<work-dir>/decoy-authority.json): init_platform must refuse that copy's ProgramData.
# Mainnet is read once per work dir (MAINNET_RPC_URL overrides the RPC). Usage: scripts/ci/start-bundle-validator.sh <work-dir>
set -euo pipefail

WORK_DIR="${1:?usage: start-bundle-validator.sh <work-dir>}"
RPC_PORT="${BUNDLE_VALIDATOR_RPC_PORT:-8939}"
FAUCET_PORT="${BUNDLE_VALIDATOR_FAUCET_PORT:-9939}"
# Its own gossip and dynamic ports, so it runs beside the CI (8909), stock-pair (8919) and early access (8929) validators.
GOSSIP_PORT="${BUNDLE_VALIDATOR_GOSSIP_PORT:-18300}"
DYNAMIC_PORTS="${BUNDLE_VALIDATOR_DYNAMIC_PORTS:-18301-18360}"
READY_TIMEOUT_SECONDS="${VALIDATOR_READY_TIMEOUT_SECONDS:-180}"
MAINNET="${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
# Test-only snapshot conformance, not current-mainnet compatibility. DBC 0.2.2 creates version-1 configs;
# never normalize that semantic difference or update production config pins to make this test pass.
SDK_COMMIT=a28b7239e71899eb52ff7aacac4dec90441885c4
DBC_SHA256=71e06857b67882bff19d9c57134b150530a168973eea30c75edc7ceec4eaf401
DBC_FIXTURE_URL="https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve-sdk/${SDK_COMMIT}/packages/dynamic-bonding-curve/tests/fixtures/dynamic_bonding_curve.so"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DBC=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
DAMM=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
TOKEN_2022=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
METAPLEX=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
BUNDLE=$(cd "$REPO_ROOT" && sed -n 's/^declare_id!("\(.*\)");$/\1/p' programs/bundle-vault/src/lib.rs)
DAMM_MIGRATION_CONFIG=Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp
[ -n "$BUNDLE" ] || { echo "declare_id! not found in programs/bundle-vault/src/lib.rs" >&2; exit 1; }
FIXTURES="$WORK_DIR/fixtures"
mkdir -p "$FIXTURES"

DBC_FIXTURE="$FIXTURES/dbc-$DBC_SHA256.so"
[ -s "$DBC_FIXTURE" ] || curl -sSfL --retry 3 -o "$DBC_FIXTURE" "$DBC_FIXTURE_URL"
printf '%s  %s\n' "$DBC_SHA256" "$DBC_FIXTURE" | sha256sum --check --status
for program in "cp_amm:$DAMM" "token2022:$TOKEN_2022" "metaplex:$METAPLEX"; do
  name="${program%%:*}" id="${program#*:}"
  [ -s "$FIXTURES/$name.so" ] || solana program dump "$id" "$FIXTURES/$name.so" --url "$MAINNET" > /dev/null
done
[ -s "$WORK_DIR/bundle-authority.json" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK_DIR/bundle-authority.json" > /dev/null
for key in decoy-program decoy-authority; do
  [ -s "$WORK_DIR/$key.json" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK_DIR/$key.json" > /dev/null
done
DECOY=$(solana-keygen pubkey "$WORK_DIR/decoy-program.json")

solana-test-validator --reset \
  --ledger "$WORK_DIR/ledger" \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" --gossip-port "$GOSSIP_PORT" --dynamic-port-range "$DYNAMIC_PORTS" \
  --limit-ledger-size 10000000 \
  --bpf-program "$DBC" "$DBC_FIXTURE" \
  --bpf-program "$DAMM" "$FIXTURES/cp_amm.so" \
  --bpf-program "$TOKEN_2022" "$FIXTURES/token2022.so" \
  --bpf-program "$METAPLEX" "$FIXTURES/metaplex.so" \
  --upgradeable-program "$BUNDLE" "$REPO_ROOT/tests/fixtures/validator/bundle_vault.so" "$WORK_DIR/bundle-authority.json" \
  --upgradeable-program "$DECOY" "$REPO_ROOT/tests/fixtures/validator/bundle_vault.so" "$WORK_DIR/decoy-authority.json" \
  --account "$DAMM_MIGRATION_CONFIG" "$REPO_ROOT/tests/fixtures/validator/$DAMM_MIGRATION_CONFIG.json" \
  > "$WORK_DIR/validator.log" 2>&1 &
echo $! > "$WORK_DIR/validator.pid"

deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
pid=$(cat "$WORK_DIR/validator.pid")
until curl -sf "http://127.0.0.1:$RPC_PORT" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; do
  if ! kill -0 "$pid" 2>/dev/null; then echo "validator exited before becoming healthy" >&2; tail -80 "$WORK_DIR/validator.log" >&2 || true; exit 1; fi
  if [ $SECONDS -ge $deadline ]; then echo "validator did not become healthy within ${READY_TIMEOUT_SECONDS}s" >&2; tail -80 "$WORK_DIR/validator.log" >&2 || true; exit 1; fi
  sleep 1
done
# The lookup table a v0 launch uses is created at a finalized slot.
until [ "$(curl -sf "http://127.0.0.1:$RPC_PORT" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}' \
  | sed -E 's/.*"result":([0-9]+).*/\1/')" -gt 0 ] 2>/dev/null; do
  if [ $SECONDS -ge $deadline ]; then echo "no finalized slot" >&2; exit 1; fi
  sleep 1
done
echo "bundle validator ready on http://127.0.0.1:$RPC_PORT"
