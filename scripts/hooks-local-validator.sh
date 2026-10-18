#!/usr/bin/env bash
# Run inside the isolated Docker/Colima VM only. Genesis programs and assets are LOCAL.
set -euo pipefail
[[ -f /state/genesis/wallet-native.json ]] || { echo 'Prepare the explicit synthetic wallet genesis allocation first' >&2; exit 1; }
: "${LOCAL_UPGRADE_ADDRESS:?synthetic local upgrade public address required}"
[[ -f /state/genesis/quote-mint.json && -f /state/rebuilt-inclusive/elf/bordrless_launch.so ]] || exit 1
cd /state/rebuilt-inclusive/elf
printf '%s\n' \
 'd4193f3634e68fb50c4bbfddc9ac2fc2e60f0ed2e1c6847c8a1580420875e9bb  bordrless_launch.so' \
 '3d5e1abee7fa2ff5f8d9a2b6c691b80849c75b298b4156f81d545dfa5f1caeaa  bordrless_swap.so' \
 'd7233dd0fd23f58f2d1efec1543017395684f43827155e8b884a624c62493857  hook_max_wallet.so' \
 '7aa07deb41a5545bcaff0d3fb966d5344538ec8f5c9f2155db4de030e3255df1  bordrless_token.so' | sha256sum -c -
exec /root/.local/share/solana/install/releases/v4.3.0/solana-release/bin/solana-test-validator \
 --ledger /ledger --bind-address 172.29.17.2 --rpc-port 18999 --faucet-port 19900 \
 --url http://127.0.0.1:18999 --mint 11111111111111111111111111111112 --limit-blockstore-size 2400000 \
 --upgradeable-program E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft /state/rebuilt-inclusive/elf/bordrless_launch.so "$LOCAL_UPGRADE_ADDRESS" \
 --upgradeable-program B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk /state/rebuilt-inclusive/elf/bordrless_swap.so "$LOCAL_UPGRADE_ADDRESS" \
 --account-dir /state/genesis
