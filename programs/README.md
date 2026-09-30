# On-chain programs (devnet/localnet only)

`repo-donation-escrow` holds donations to a GitHub repository, keyed by its numeric repository ID, until repo.ing's verifier attests the maintainer's wallet. If a donation is still unreleased after 90 days, the donor can take it back. Settlement (release or refund) closes both the deposit record and its token vault in the same instruction, and returns all of their rent to the donor. There is no protocol fee.

**Unaudited. Do not deploy to mainnet.** No script here targets mainnet: the deploy script checks the devnet genesis hash and uses its own throwaway deployer key, never `~/.config/solana/id.json`.

## Toolchain

The versions are pinned: Anchor 1.0.2 (`anchor-lang`/`anchor-spl` `=1.0.2`), Agave 4.0.1 `cargo-build-sbf`, and Rust 1.95 on the host. `Cargo.lock` pins LiteSVM 0.16 and the Agave 4.2 runtime crates, because 4.3 needs Rust 1.97. If you re-resolve the lockfile, run `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update` so it stays on compatible versions.

```bash
# one-time: Agave release binaries (about 208 MB; platform-tools are downloaded on first build)
mkdir -p ~/.local/share/agave && cd ~/.local/share/agave
gh release download v4.0.1 -R anza-xyz/agave -p 'solana-release-aarch64-apple-darwin.tar.bz2'
tar xjf solana-release-aarch64-apple-darwin.tar.bz2 && rm solana-release-aarch64-apple-darwin.tar.bz2
```

## Build and test

```bash
programs/scripts/build.sh build    # target/deploy/repo_donation_escrow.so
programs/scripts/build.sh test     # LiteSVM tests (in-process, no validator)
programs/scripts/build.sh clippy   # clippy -D warnings, including tests
programs/scripts/idl.sh            # target/idl/repo_donation_escrow.json
```

The tests load the real mainnet SPYx mint bytes (`repo-donation-escrow/tests/fixtures/`) to cover the xStocks Token-2022 extension set. They also cover plain SPL, wSOL, and transfer-fee mints.

## Minimum deposits (about $5 per mint)

```bash
node programs/scripts/allowlist-mints.mjs            # dry run: prints the computed raw minimums
node programs/scripts/allowlist-mints.mjs --usd 5 SPYx USDC
DEVNET_RPC_URL=https://api.devnet.solana.com ALLOWLIST_KEYPAIR=<path> \
  node programs/scripts/allowlist-mints.mjs --send --mint SPYx=<devnet mint> SPYx
```

The default table covers SPYx, NVDAx, TSLAx, QQQx, AAPLx, USDC and SOL (wSOL).

- Prices come from the Jupiter price API v3 at run time and apply the xStocks `scaledUiAmount` multiplier.
- Each minimum is rounded up to two significant figures.
- The script prints the raw minimums for review and sends nothing without `--send`.
- `--send` works only against devnet or a local validator.
- `--mint SYMBOL=ADDRESS` swaps in a devnet test mint, which must have the same decimals as the mainnet mint.

## Devnet deploy

```bash
programs/scripts/deploy-devnet.sh
```

The script:

1. Refuses to run unless the RPC's genesis hash is devnet's.
2. Creates `target/deploy/devnet-deployer-keypair.json` (gitignored) and requests an airdrop.
3. Deploys with that key as the upgrade authority.
4. Runs `devnet-init-config.mjs`, which by default sets admin, verifier and allowlist authority to the deployer.

If the public faucet is rate-limited, fund the printed deployer address with about 4 devnet SOL and re-run. The program ID keypair lives in `target/deploy/` and is not committed; a fresh checkout must generate a new one and update `declare_id!` and `Anchor.toml`.
