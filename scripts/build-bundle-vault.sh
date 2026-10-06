#!/usr/bin/env bash
# Builds the Bundle launch vault program (programs/bundle-vault, docs/BUNDLE_LAUNCH.md) for Solana and writes the
# stripped program to tests/fixtures/validator/bundle_vault.so, the copy the chain tests load and the owner deploys,
# and the sha256 of the sources it was built from to bundle_vault.sources.sha256 (tests/bundle-vault.test.mjs
# fails when the sources change without a rebuild).
# Needs Solana's platform tools: either `cargo build-sbf` on the PATH, or the platform-tools rustup toolchain that
# cargo-build-sbf installs (PLATFORM_TOOLS_VERSION, default v1.53, under ~/.cache/solana).
#   scripts/build-bundle-vault.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROGRAM="$ROOT/programs/bundle-vault"
OUT="$ROOT/tests/fixtures/validator/bundle_vault.so"
VERSION="${PLATFORM_TOOLS_VERSION:-v1.53}"
TOOLS="$HOME/.cache/solana/$VERSION/platform-tools"

cd "$PROGRAM"
if command -v cargo-build-sbf > /dev/null; then
  cargo build-sbf --tools-version "$VERSION" -- --locked
  BUILT="$PROGRAM/target/deploy/bundle_vault.so"
else
  TOOLCHAIN=$( (rustup toolchain list 2>/dev/null || true) | awk '{print $1}' | grep -- "-sbpf-solana-$VERSION\$" | head -1 || true)
  [ -n "$TOOLCHAIN" ] || { echo "no cargo-build-sbf and no sbpf-solana-$VERSION toolchain; install the Solana CLI" >&2; exit 1; }
  cargo "+$TOOLCHAIN" build --release --locked --target sbpf-solana-solana
  BUILT="$PROGRAM/target/bundle_vault.stripped.so"
  "$TOOLS/llvm/bin/llvm-objcopy" --strip-all "$PROGRAM/target/sbpf-solana-solana/release/bundle_vault.so" "$BUILT"
fi
cp "$BUILT" "$OUT"
cd "$ROOT"
cat programs/bundle-vault/Cargo.toml programs/bundle-vault/Cargo.lock programs/bundle-vault/src/lib.rs \
  | shasum -a 256 | cut -d' ' -f1 > "${OUT%.so}.sources.sha256"
echo "wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$OUT" | cut -d' ' -f1))"
