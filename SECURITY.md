# Security

## Report privately

Do not put exploitable details, credentials, private keys, or signed transactions in a public issue. Contact the repository owner through an existing private channel first, or use GitHub's **Report a vulnerability** option if it is available on this repository. A dedicated public security address and response SLA have not been published yet. No bug bounty is promised.

Include affected code or page, a minimal reproduction using local fixtures, expected impact, and relevant public transaction signatures. Do not test by moving other users' funds or disrupting production.

## Review boundaries

- GitHub checks establish current repository admin authority; OAuth login alone is insufficient.
- Wallet messages bind domain, repository, chain, nonce, and expiry.
- Fees use verified event evidence and integer base units.
- Payouts use durable intents, exact settlement checks, and replay protection.
- Worker recovery reuses previously authorized transactions.
- Database, RPC, GitHub, and signing secrets are server-only and excluded from Git.
- Builder and partner fee authorities are controlled by protected platform signers. Application checks enforce who may receive payouts; this is not an independently verified GitHub escrow contract.

See [Architecture](docs/ARCHITECTURE.md), [GitHub verification](docs/GITHUB_VERIFICATION.md), [claim recovery](docs/CLAIM.md), and [backup recovery](docs/BACKUPS.md).

Local tests and mainnet receipts in this repository are implementation evidence, not an independent security audit. No completed external audit is claimed here.
