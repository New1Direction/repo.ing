#!/usr/bin/env bash
# Run only in the isolated local Linux builder. Network access warms public tools;
# the supplied regeneration driver then builds and executes its offline canaries.
set -euo pipefail
[[ "$(uname -sm)" == 'Linux x86_64' ]] || { echo 'Linux x86_64 is required' >&2; exit 1; }
[[ -f /source/programs/tests/tests/inclusive_fee_support/regenerate.sh && -f /state/build-inputs/accounts.json ]] || exit 1
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends pkg-config libssl-dev libudev-dev ca-certificates curl bzip2 xz-utils python3
cd /source
rustc --version --verbose
cargo --version
bash scripts/solana/toolchain.sh install
export PATH="$HOME/.cargo/bin:$(bash scripts/solana/toolchain.sh path):$PATH"
cargo build-sbf --version
CARGO_NET_OFFLINE=false cargo fetch --locked
CARGO_NET_OFFLINE=true cargo fetch --locked --offline
export OLD_STATE_FIXTURE=/state/build-inputs CUSTOM_PAUSED_PACKET=/state/build-inputs
export TOKEN_SBF=/state/build-inputs/bordrless_token.so INCLUSIVE_OUTPUT=/state/rebuilt-inclusive
export INCLUSIVE_SBF_TARGET=/build/sbf INCLUSIVE_HOST_TARGET=/build/host
bash programs/tests/tests/inclusive_fee_support/regenerate.sh
