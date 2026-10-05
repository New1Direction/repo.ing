#!/usr/bin/env bash
# Builds the contributor early access hook (programs/early-access-hook, docs/EARLY_ACCESS.md) for Solana and writes the
# stripped program to tests/fixtures/validator/early_access_hook.so, the copy the chain tests load and the owner deploys,
# and the sha256 of the sources it was built from to early_access_hook.sources.sha256 (tests/early-access-hook.test.mjs
# fails when the sources change without a rebuild).
# Needs Solana's platform tools: either `cargo build-sbf` on the PATH, or the platform-tools rustup toolchain that
# cargo-build-sbf installs (PLATFORM_TOOLS_VERSION, default v1.53, under ~/.cache/solana).
#   scripts/build-early-access-hook.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROGRAM="$ROOT/programs/early-access-hook"
OUT="$ROOT/tests/fixtures/validator/early_access_hook.so"
VERSION="${PLATFORM_TOOLS_VERSION:-v1.53}"
TOOLS="$HOME/.cache/solana/$VERSION/platform-tools"

cd "$PROGRAM"
if command -v cargo-build-sbf > /dev/null; then
  cargo build-sbf --tools-version "$VERSION" -- --locked
  BUILT="$PROGRAM/target/deploy/early_access_hook.so"
else
  TOOLCHAIN=$( (rustup toolchain list 2>/dev/null || true) | awk '{print $1}' | grep -- "-sbpf-solana-$VERSION\$" | head -1 || true)
  [ -n "$TOOLCHAIN" ] || { echo "no cargo-build-sbf and no sbpf-solana-$VERSION toolchain; install the Solana CLI" >&2; exit 1; }
  cargo "+$TOOLCHAIN" build --release --locked --target sbpf-solana-solana
  BUILT="$PROGRAM/target/early_access_hook.stripped.so"
  "$TOOLS/llvm/bin/llvm-objcopy" --strip-all "$PROGRAM/target/sbpf-solana-solana/release/early_access_hook.so" "$BUILT"
fi
cp "$BUILT" "$OUT"
cd "$ROOT"
cat programs/early-access-hook/Cargo.toml programs/early-access-hook/Cargo.lock programs/early-access-hook/src/lib.rs \
  | shasum -a 256 | cut -d' ' -f1 > "${OUT%.so}.sources.sha256"
echo "wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$OUT" | cut -d' ' -f1))"
