#!/usr/bin/env bash
# Start a disposable solana-test-validator loaded with the Meteora program fixtures
# the chain tests use (see docs/METEORA_SPIKE.md). Usage:
#   scripts/ci/start-validator.sh <work-dir>
# Programs come from Meteora's DBC SDK test fixtures at a pinned commit; the DAMM v2
# migration config is a committed snapshot of the devnet account, so no network access
# to devnet is required.
set -euo pipefail

WORK_DIR="${1:?usage: start-validator.sh <work-dir>}"
RPC_PORT="${VALIDATOR_RPC_PORT:-8909}"
FAUCET_PORT="${VALIDATOR_FAUCET_PORT:-9909}"
READY_TIMEOUT_SECONDS="${VALIDATOR_READY_TIMEOUT_SECONDS:-120}"
SDK_COMMIT=a28b7239e71899eb52ff7aacac4dec90441885c4
FIXTURE_BASE="https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve-sdk/${SDK_COMMIT}/packages/dynamic-bonding-curve/tests/fixtures"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DAMM_CONFIG=Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp

FIXTURES="$WORK_DIR/fixtures"
mkdir -p "$FIXTURES"
for name in amm cp_amm dynamic_bonding_curve locker mercurial_vault metaplex; do
  if [ ! -s "$FIXTURES/$name.so" ]; then
    curl -sSfL --retry 3 -o "$FIXTURES/$name.so" "$FIXTURE_BASE/$name.so"
  fi
done

solana-test-validator --reset --quiet \
  --ledger "$WORK_DIR/ledger" \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" \
  --limit-ledger-size 50000000 \
  --account "$DAMM_CONFIG" "$REPO_ROOT/tests/fixtures/validator/$DAMM_CONFIG.json" \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$FIXTURES/dynamic_bonding_curve.so" \
  --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG "$FIXTURES/cp_amm.so" \
  --bpf-program Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB "$FIXTURES/amm.so" \
  --bpf-program LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn "$FIXTURES/locker.so" \
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$FIXTURES/metaplex.so" \
  --bpf-program 24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi "$FIXTURES/mercurial_vault.so" \
  > "$WORK_DIR/validator.log" 2>&1 &
echo $! > "$WORK_DIR/validator.pid"

deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
until curl -sf "http://127.0.0.1:$RPC_PORT" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; do
  if [ $SECONDS -ge $deadline ]; then
    echo "validator did not become healthy within ${READY_TIMEOUT_SECONDS}s" >&2
    tail -50 "$WORK_DIR/validator.log" >&2 || true
    exit 1
  fi
  sleep 1
done
# Wait for a finalized slot so tests that read with 'finalized' commitment see the programs.
until [ "$(curl -sf "http://127.0.0.1:$RPC_PORT" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}' \
  | sed -E 's/.*"result":([0-9]+).*/\1/')" -gt 0 ] 2>/dev/null; do
  if [ $SECONDS -ge $deadline ]; then echo "no finalized slot" >&2; exit 1; fi
  sleep 1
done
echo "solana-test-validator ready on http://127.0.0.1:$RPC_PORT"
