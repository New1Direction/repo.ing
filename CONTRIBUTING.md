# Contributing to repo.ing

Start with the [README](README.md), [architecture](docs/ARCHITECTURE.md), and [development guide](docs/DEVELOPMENT.md).

## A useful change

1. Describe the user problem and the affected launch, trade, verification, claim, or reconciliation path.
2. Keep changes focused. Preserve immutable repository identity, exact base-unit accounting, and existing market terms.
3. Verify the changed behavior with the smallest meaningful checks. Financial paths need explicit failure and recovery coverage.
4. Update the relevant guide and dated evidence. Distinguish local fixtures from finalized mainnet receipts.
5. Include screenshots for interface changes and explain deployment or migration requirements.

## Local verification

Follow [Development](docs/DEVELOPMENT.md) for environment setup. Do not run integration tests against production; some suites intentionally clear disposable fixtures. Never commit `.env` files, signing keys, database dumps, session cookies, or signed transaction payloads.

Run `git diff --check` and the production build for application changes. Use the lockfile and installed framework documentation. Do not enable execution gates, change fees, rotate live configs, submit mainnet transactions, or launch markets as part of a routine code test.

## Reporting a problem

For a normal bug, provide the page, expected behavior, actual result, and a public transaction signature if relevant. Never share a seed phrase or private key. For a vulnerability, follow [Security](SECURITY.md).

## License

Original repo.ing source code is licensed under [AGPL-3.0-only](LICENSE). Contributions of original source code are accepted under the same license. Preserve existing third-party license notices and document the source and license of any code or assets you add; third-party material retains its own terms.
