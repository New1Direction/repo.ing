# Solana beneficiary wallet binding

Run date: 2026-09-24. Scope: `BIND_WALLET` only. No fee claim or transfer was made.

`src/wallet-binding.mjs` requires a successful `admin` verification for the same immutable `github_repo_id` and GitHub user ID, recorded within the last five minutes. It creates a five-minute, random one-time challenge. The server reconstructs the message from persisted challenge fields and verifies the wallet's Ed25519 signature against its Solana public key. A successful database transaction consumes the nonce and sets the repository's single active beneficiary. An expired, mismatched, or consumed challenge cannot update that row.

The signed UTF-8 message has this exact shape (with actual values substituted):

```text
git.fun repository beneficiary v1
I bind this Solana wallet as beneficiary for the repository.
Chain: Solana
Repository ID: 1384142609
Wallet: <Solana wallet address>
Nonce: <48-character random hex nonce>
Expires: <UTC ISO timestamp>
```

## Local evidence

The focused test used a dedicated PostgreSQL database with a fresh verification fixture matching the previously live-verified GitHub identity: `New1Direction`, user ID `285551516`, repository `New1Direction/Waternot`, immutable ID `1384142609`. This task did not repeat GitHub OAuth; the verification row in this test database was seeded. The wallet was a disposable Ed25519 key generated in memory and represented as a Solana address. No private key was saved.

| Result | Observed value |
| --- | --- |
| Beneficiary wallet | `Dbk1sUjeS1aLxigxLFQFv17cXfD5FMbmgTN9KtCmVAnE` |
| Bound at | `2026-09-24T14:12:59.948Z` |
| Persisted beneficiary rows for repo | `1`, with user ID `285551516` and the wallet above |
| Successful challenge | Nonce consumed once after valid signature verification |
| Invalid signature | Rejected; nonce remained unconsumed |
| Wrong wallet / repository | Rejected |
| Reused nonce / expired challenge | Both rejected; beneficiary unchanged |
| Unverified GitHub user | Could neither request a challenge nor bind |

`npm run test:wallet-binding` passed **4/4** focused tests. The migration applied successfully. No launch, index, trade, fee, or GitHub verification suites were rerun.

## Files, schema, limits

Changed: `src/wallet-binding.mjs`, `src/db/schema.mjs`, `drizzle/0004_fresh_puppet_master.sql` and Drizzle metadata, `tests/wallet-binding.test.mjs`, `package.json`, and this report. The migration adds `wallet_binding_challenges` (repo/user/wallet/unique nonce/expiry/consumption) and `repo_beneficiaries` (one row per repository). It adds no claim or payout state.

To reproduce, use a dedicated PostgreSQL database, run `npm run db:migrate`, then `npm run test:wallet-binding`. The test truncates its database, seeds a recent admin-verification fixture, and generates a new wallet. Its address and timestamp will differ from this report.

The existing GitHub verifier does not retain a user access token, so this binding module checks a recent successful verification record rather than making a new live GitHub API call. Current GitHub authority immediately before a real beneficiary change and a browser wallet adapter signing flow remain unverified. The future `CLAIM` transition must recheck live GitHub authority before payout and must not infer current authority from this beneficiary row alone.
