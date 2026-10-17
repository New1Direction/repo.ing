#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
# This opt-in command runs only the retained public fixture and disposable SBF VM.
# It does not source .env, launch the production app, or access a wallet/RPC.
NODE="$(command -v node)"
exec env -i LANG=C.UTF-8 "$NODE" spikes/hook-playground/max-wallet-local-server.mjs --local-test "$@"
