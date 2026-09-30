#!/usr/bin/env bash
# Build the escrow program to target/deploy/repo_donation_escrow.so and run its LiteSVM tests.
# Usage: programs/scripts/build.sh [build|test|clippy|all]   (default: all)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Pinned Agave toolchain (cargo-build-sbf). Override with AGAVE_BIN if installed elsewhere.
AGAVE_BIN="${AGAVE_BIN:-$HOME/.local/share/agave/solana-release/bin}"
export PATH="$AGAVE_BIN:$PATH"
cd "$ROOT"

step="${1:-all}"

build() {
  cargo build-sbf --manifest-path repo-donation-escrow/Cargo.toml --sbf-out-dir target/deploy
}

run_tests() {
  test -f target/deploy/repo_donation_escrow.so || build
  cargo test -p repo-donation-escrow -- --test-threads=4
}

clippy() {
  cargo clippy -p repo-donation-escrow --all-targets -- -D warnings
}

case "$step" in
  build) build ;;
  test) run_tests ;;
  clippy) clippy ;;
  all) build && run_tests && clippy ;;
  *) echo "unknown step: $step" >&2; exit 2 ;;
esac
