#!/usr/bin/env bash
# Start a disposable solana-test-validator for the stock-pair chain tests (docs/STOCK_QUOTES.md):
#   - the DBC, DAMM v2, Token-2022 and Metaplex programs exactly as deployed on mainnet (read with `solana program dump`);
#   - Meteora's DBC and DAMM v2 token badges for METAx, as on mainnet;
#   - the METAx mint as on mainnet, every byte and extension included (pause, freeze, permanent delegate, scaled UI amount,
#     transfer hook slot), except its mint authority, replaced by a test key written to <work-dir>/metax-authority.json so the
#     tests can hold METAx.
# Mainnet is read once per work dir (MAINNET_RPC_URL overrides the RPC). Usage: scripts/ci/start-stock-validator.sh <work-dir>
set -euo pipefail

WORK_DIR="${1:?usage: start-stock-validator.sh <work-dir>}"
RPC_PORT="${STOCK_VALIDATOR_RPC_PORT:-8919}"
FAUCET_PORT="${STOCK_VALIDATOR_FAUCET_PORT:-9919}"
READY_TIMEOUT_SECONDS="${VALIDATOR_READY_TIMEOUT_SECONDS:-180}"
MAINNET="${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
METAX=Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu
DBC=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
DAMM=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
TOKEN_2022=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
METAPLEX=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
FIXTURES="$WORK_DIR/fixtures"
mkdir -p "$FIXTURES"

for program in "dbc:$DBC" "cp_amm:$DAMM" "token2022:$TOKEN_2022" "metaplex:$METAPLEX"; do
  name="${program%%:*}" id="${program#*:}"
  [ -s "$FIXTURES/$name.so" ] || solana program dump "$id" "$FIXTURES/$name.so" --url "$MAINNET" > /dev/null
done
# Badge addresses are the programs' PDAs for the mint (seeds "token_badge", mint).
read -r DBC_BADGE DAMM_BADGE < <(cd "$REPO_ROOT" && node --input-type=module -e '
import { PublicKey } from "@solana/web3.js"
const mint = new PublicKey(process.argv[1]).toBuffer(), seed = Buffer.from("token_badge")
const pda = program => PublicKey.findProgramAddressSync([seed, mint], new PublicKey(program))[0].toBase58()
console.log(pda(process.argv[2]), pda(process.argv[3]))' "$METAX" "$DBC" "$DAMM")
for account in "$METAX" "$DBC_BADGE" "$DAMM_BADGE"; do
  [ -s "$FIXTURES/$account.json" ] || solana account "$account" --output json --url "$MAINNET" > "$FIXTURES/$account.json"
done
# The test mint authority: the base mint layout starts with COption<Pubkey> mint_authority (4-byte tag, then 32 bytes).
(cd "$REPO_ROOT" && node --input-type=module -e '
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { Keypair } from "@solana/web3.js"
const [source, target, keyFile] = process.argv.slice(1)
const authority = existsSync(keyFile) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8")))) : Keypair.generate()
writeFileSync(keyFile, JSON.stringify([...authority.secretKey]))
// Only the base64 data string is rewritten: re-serializing the JSON would turn the u64 rentEpoch into a float.
const text = readFileSync(source, "utf8"), encoded = JSON.parse(text).account.data[0]
const data = Buffer.from(encoded, "base64")
if (data.readUInt32LE(0) !== 1) throw Error("METAx has no mint authority to replace")
authority.publicKey.toBuffer().copy(data, 4)
if (text.split(encoded).length !== 2) throw Error("METAx account data is not unique in its JSON")
writeFileSync(target, text.replace(encoded, data.toString("base64")))' "$FIXTURES/$METAX.json" "$WORK_DIR/metax-test-mint.json" "$WORK_DIR/metax-authority.json")

solana-test-validator --reset --quiet \
  --ledger "$WORK_DIR/ledger" \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" \
  --limit-ledger-size 10000000 \
  --bpf-program "$DBC" "$FIXTURES/dbc.so" \
  --bpf-program "$DAMM" "$FIXTURES/cp_amm.so" \
  --bpf-program "$TOKEN_2022" "$FIXTURES/token2022.so" \
  --bpf-program "$METAPLEX" "$FIXTURES/metaplex.so" \
  --account "$METAX" "$WORK_DIR/metax-test-mint.json" \
  --account "$DBC_BADGE" "$FIXTURES/$DBC_BADGE.json" \
  --account "$DAMM_BADGE" "$FIXTURES/$DAMM_BADGE.json" \
  > "$WORK_DIR/validator.log" 2>&1 &
echo $! > "$WORK_DIR/validator.pid"

deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
until curl -sf "http://127.0.0.1:$RPC_PORT" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; do
  if [ $SECONDS -ge $deadline ]; then echo "validator did not become healthy within ${READY_TIMEOUT_SECONDS}s" >&2; tail -50 "$WORK_DIR/validator.log" >&2 || true; exit 1; fi
  sleep 1
done
until [ "$(curl -sf "http://127.0.0.1:$RPC_PORT" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}' \
  | sed -E 's/.*"result":([0-9]+).*/\1/')" -gt 0 ] 2>/dev/null; do
  if [ $SECONDS -ge $deadline ]; then echo "no finalized slot" >&2; exit 1; fi
  sleep 1
done
echo "stock-pair validator ready on http://127.0.0.1:$RPC_PORT"
