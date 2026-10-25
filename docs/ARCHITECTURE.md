# Architecture and trust boundaries

[Documentation](README.md) / Architecture

## System overview

```diagram
Browser / wallet → Cloudflare Worker → Next.js Container (EWR)
                                           │
                         ┌─────────────────┼───────────────────┐
                         ▼                 ▼                   ▼
                   GitHub API       Neon PostgreSQL      Solana RPC
                                      (Ohio)                 │
                                         ▲                   ▼
                                         │             DBC / DAMM v2
                         Mac chart + accounting indexers ─────┘
```

As verified on October 24, 2026, `repo.ing` runs on Cloudflare Worker/Container service `repoing-public`, not the former Railway web service. The Container runs in EWR with 0.25 vCPU and 1 GiB RAM. PostgreSQL is Neon project `<neon-project>`, database `repoing_operational`, in Ohio. Migration 0085 and the restricted launch/accounting roles were applied to that Neon database. See [STATUS.md](../STATUS.md) for accepted Worker/image identities and rollback pairs.

Separate Mac LaunchAgents run the chart and fee-accounting indexers every 120 seconds, using distinct restricted database roles. Helius is the primary RPC; official mainnet independently verifies archive evidence, and PublicNode verifies recent chart observations. Provider failures withhold fresh evidence rather than fabricating progress. The general worker and transaction replay are disabled. Migration to the existing Hetzner host is authorized but not completed: fresh encrypted backup and historical Neon PITR verification passed. The owner will harden the host and create a unprivileged `indexer` account; migration must use only that account and must not change root login or sshd. No remote secrets or jobs were installed. Keep Mac writers active during zero-write shadow comparison; only after exact agreement disable/drain Mac before enabling Hetzner. Rollback disables/drains Hetzner before restoring Mac. Single-writer and ten-minute no-write phone-alert acceptance remain required.

The old Railway root PostgreSQL/backup deployments are stopped, with their volume and encrypted backups preserved; web/worker were already inactive. This does not mean all Railway services are retired: inference gateway, ops, PostgreSQL and staging dependencies are not proven unused. They are not the operational database above. No additional pause or deletion is justified by the web hosting move alone. Current backup evidence and its limits are in [Backups](BACKUPS.md).

| Component | Responsibility | Main code |
| --- | --- | --- |
| Web | Pages, quotes, wallet signing handoff, GitHub sessions, payout authorization | `app/`, `app/lib/` |
| Launch coordinator | Immutable repository identity, one canonical market, durable launch state | `src/launch-coordinator.mjs`, `src/meteora-launch.mjs` |
| Chart indexer | Independently verified finalized swaps, chart cursors and graduation observations; no accounting or signing | `scripts/recovery-chart-indexer.mjs` |
| Accounting indexer | Independently verified fee events and accounting cursors; no collection/payout/beneficiary writes | `scripts/recovery-fee-indexer.mjs` |
| Accounting | Verified DBC events, DAMM fee checkpoints, settled payouts, reconciliation | `src/fee-accrual.mjs`, `src/graduated-fees.mjs`, `src/reconcile.mjs` |
| Database | Workflow state, canonical mappings, evidence, payout intents | `src/db/schema.mjs`, `drizzle/` |
| Backup | Verified encrypted operational snapshots on Mac/USB; Neon six-hour history window | [Backups](BACKUPS.md) |

Web currently runs as one Container instance. Launch reviews (`launch_sessions`) and prepared trades (`trade_sessions`) are durable in PostgreSQL; short-lived read caches and SDK runtime objects are process-local. The public reader, ledger reader, ordinary launcher and trading database roles are separate. Financial verification retains current ledger/chain checks even when display data or SDK construction is cached. Indexing is not a browser request, although a token-page fee reconciliation can perform fresh RPC reads after its display cache expires.

## Sources of truth

- **GitHub:** immutable repository identity and the authenticated user's current effective admin permission.
- **Solana and Meteora:** canonical pool state, finalized swaps, earned fees, migration state, and actual settlement.
- **PostgreSQL:** workflow records and balances derived from verified evidence, plus the history required to recover pending and settled payouts.

Names and GitHub paths can change. The immutable numeric repository ID remains the canonical application key. A market's mint and pool must resolve against an approved config; a URL or a user-supplied account address is insufficient proof.

## Launch and trade flow

```text
Resolve public repository → find existing market → reserve canonical launch
→ prepare and review → wallet signs → submit → finalized evidence → index
```

The coordinator and database uniqueness rules prevent duplicate canonical launches. An ambiguous submission stays unresolved until its chain evidence can be checked. The accepted ordinary launch path has **no initial buy**. It uses the reviewed replacement config and an unfunded bootstrap co-signer, with creator rights handed atomically to the recovered 2-of-3 vault. The receipt verifier rejects missing or misdirected handoffs, even if a later transaction moves the creator to the vault.

Trades use server-prepared Meteora quotes and wallet-signed transactions. UI result cards distinguish pending from proven success or failure. Existing-market trading is limited to the independently accepted historical market/config bindings, with one-send/no-rebroadcast recovery. New-market trading remains disabled pending its separate admission and production acceptance. Read-only indexers find external canonical swaps; accounting does not depend solely on transactions initiated through the site.

Recovery ordinary launches require `ORDINARY_LAUNCH_CONFIG` to equal the pinned `RECOVERED_LAUNCH_CONFIG`; the four historical H7TK configs cannot select new ordinary launches. `DBC_CONFIG` and `DBC_LEGACY_CONFIGS` still identify previously approved markets for read/trade resolution. Resolution derives each market's canonical pool from its mint and an approved config; changing launch selection does not reprice existing markets.

## Authorities and trust

| Authority | What it controls |
| --- | --- |
| User wallet | User-signed launches and trades; discovery claim and wallet-binding messages |
| Current GitHub admin | Fresh repository-administrator evidence for future beneficiary consent; not sufficient alone for payment |
| Recovered 2-of-3 vault | Recovered creator positions and all lasting creator/partner destinations for safe new ordinary launches |
| Unfunded online bootstrap signer | Co-signs constrained ordinary creation plus atomic vault handoff; no lasting creator or payout authority |
| Historical H7TK fee claimer | Still has immutable partner rights on four legacy DBC configs; treated as compromised and excluded from new rights |

GitHub authorization is enforced by the application. Meteora verifies its on-chain signing authorities; it does not independently check GitHub identity. Builder and discovery payouts therefore depend on the platform's signer custody and authorization logic. The 50/50 migrated liquidity principal is permanently locked on chain, while position fees remain claimable.

The configured GitHub App requests Metadata read only. Its short-lived user credential is encrypted in a Secure, HttpOnly production cookie with a maximum one-hour session. Wallet binding requires a domain-separated, expiring message and a one-time nonce. The session and historical verification record do not replace a fresh GitHub authority check before sensitive actions.

Vault/member and former exposed creator/partner keys must not be supplied to the web service or indexers. The isolated online bootstrap identity is not a vault member or the recovered funded payer. No signer is required by the recovery indexers. RPC credentials, GitHub secrets, and signing keys must stay out of browser bundles and `NEXT_PUBLIC_` variables. General recovery/rebroadcast remains disabled.

## Fees, claims, and recovery

Money is stored in integer base units. DBC credits come from canonical finalized fee events with stable deduplication keys. DAMM credits come from increases in the validated creator position's cumulative SOL entitlement. The `builder_fee_credits` view combines both paths for lifetime builder earnings.

**Collections and payouts remain disabled.** Accrued, collected, paid, unverified and paused amounts are distinct; collection is not payment. `builder_fee_credits` is repository-keyed, not wallet-keyed. The 68 positive unbound repositories have launcher metadata, but that is not authorized beneficiary consent. No repository is claimable solely because fees accrued or its creator is the vault.

Future payout acceptance requires independently verified collection receipts, resolved custody coverage, owner-confirmed beneficiary policy, fresh repository-admin evidence and a beneficiary signature bound to repository ID and a one-use nonce. Durable intents and exact settlement verification must reject replay/double payment and distinguish fees from rent refunds. No transaction rebroadcast or live payout is authorized by preparing these checks.

The two historical collected-but-unpaid liabilities total 3.416465682 SOL. Their original-wallet balances were independently reconciled to 1.159189624 SOL, leaving a 2.257276058 SOL original-wallet coverage gap. Downstream attribution is still in progress; the gap is not a proven irrecoverable loss and must not be silently covered with unrelated recovered funds. CCTOOLKIT's 1.493333627 SOL creator accrual has no verified recovered-vault collection receipt. These are separate blockers.

Discovery has separate credits and claims, funded by partner fees. Its immutable rules are recorded per enrolled market. The operator must retain the partner fees backing earned unpaid rewards; the reward split is an application-managed obligation, not a separate on-chain escrow.

Reconciliation compares indexed entitlement, settled withdrawals, and current on-chain fees. Contradictions produce an error or review state. It does not alter credits to conceal a shortfall.

## Display data and scope

Repository metadata and market displays use cached or streamed reads for responsiveness. Authorization, signing, and payout decisions use their own current checks. USD values are estimates; SOL base units remain the accounting denomination.

After graduation, builder fee tracking covers the verified DAMM creator position; claims remain gated as above. DAMM trade evidence and SOL volume are indexed after canonical migration verification and used in graduation status and protocol analytics. Accepted historical graduated markets trade in the app's own panel against the verified DAMM v2 pool, and their finalized swaps continue the price chart; every swap settles on Meteora. Hooks, bundles and new-market trading require their own acceptance and exact activation approvals.

## Recovery boundaries

A Git checkout restores application source and migrations. Recovering the service also needs database backups, protected signer keys, and environment configuration. Restoring fee evidence without settled payout history could permit duplicate payments, so restore and reconcile the complete claim ledger before enabling payouts. Follow [Backups](BACKUPS.md) and [Production](PRODUCTION.md).

For verification evidence, use [Graduated fees](GRADUATED_FEES.md), [Claiming](CLAIM.md), and [Discovery rewards](DISCOVERY_REWARDS.md).
