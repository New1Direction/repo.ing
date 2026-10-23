# Restoration checkpoint — 2026-10-23 19:10 UTC

## Delivery and instructions
- Repository: New1Direction/repo.ing; working branch: repair/creator-selected-hooks.
- Backup destination: backup/restoration-checkpoint-20261023; never merge or push main without authorization.
- Backup checkpoint f5986d4 (39 prior commits + tested custody changes) was pushed and its remote SHA verified; main is unchanged.
- Priority: checkpoint → standalone image below 600 MB → read-only routes/live data → existing-market trading → independently accepted launches/hooks/claims.
- Surplus/gacha remain deferred. Do not restart inference or repeat completed credential rotations/custody transactions.
- No private Hook Lab ELFs, recovery envelopes, secrets or custody material belong in Git or image build contexts.

## Live now / gated
- LIVE: https://repo.ing public browsing, discovery, keyword search and fresh repository listings.
- LIVE: bounded discovery writer and restricted public/operational database readers; historical accounting repair accepted.
- VERIFIED 18:52 UTC: homepage 200; trade submission, launch, claim and replay POSTs denied with 403.
- GATED: existing-market execution; six wallet-restricted swaps have not completed finalized acceptance.
- GATED: ordinary launches, bundles, Hook Playground activation, beneficiary claims/payouts.
- DISABLED: historical replay/general worker; do not restart it. Credits/inference restoration is deferred.
- READ-ONLY GAPS: /api/health, /api/mcp/readonly, read-only /api/mcp, market/chart freshness and stale-data notice need current-route acceptance.
- Production image remains the healthy trading-review image, not any failed candidate or diagnostic control.

## Image evidence and immediate next fix
- Original test candidate: sha256:4a16b2bd8ed80fa7b2347cf737e78c0e0d69f9a60001629a8b106418567097ef; source 84cfe76.
- Original layered filesystem measured about 3.83 GB against 4 GB disk. Flat/indexed variants also failed runtime unpack, including an 8 GB trial.
- No application startup error is proven by those pre-process failures. Do not keep increasing RAM or repeat the same failed rollout.
- Metadata-only healthy control 814c2db… completed rollout, ImagePulled and VMStarted on 4 GB; HTTP 200 confirmed.
- Fresh one-file layer control bb9e2a6… also completed rollout, ImagePulled and VMStarted; HTTP 200 confirmed.
- Those controls reject a blanket failure of all new manifests/layers; they do not validate the trading candidate.
- Clean seven-layer repack c8325a3… preserves all 41,097 /app files, permissions/links and runtime config; five local denial checks passed.
- That repack reached preparation READY at 19:08 UTC but was not deployed. It is still large and superseded by the standalone-image instruction.
- Cloudflare support case 02393828 is open; do not wait on it to implement standalone packaging.
- Implement root multi-stage Dockerfile + Next output:'standalone'; runtime includes must retain pinned vendor SDK/ABI/IDL and traced files.
- Verify package inventory, health, isolated runtime identity/restart, then production cutover with automatic rollback on failed acceptance.
- Cloudflare CLI works with current containers/Workers OAuth scopes. Legacy cloudchamber curl demands an unnecessary extra scope; use native commands or scoped Containers API.
- Isolated app: a032a61a-db51-460d-8658-55b962477bd4, repoing-candidate-acceptance.rebaserh-web.workers.dev.
- Diagnostic resource app: a0388128-43f9-4f54-ac17-c229ed566946; production app: a03e52fe-2cc5-4c08-bab9-8f0ef05dbe58.
- Evidence: .amp/in/artifacts/existing-market-trading-20261023/; local Docker context colima-hooklab-review.

## Custody checkpoint and verification
- Added offline one/two-item DBC receipt validation, atomic item ledger, replay/overspend controls and item-specific payout attribution.
- Collection never pays beneficiaries; DBC payouts must not count as DAMM withdrawals. Existing DAMM receipt shape remains supported.
- New forward migration 0085_custody_dbc_batch_items.sql; applied 0084 is unchanged.
- 82 tests passed, zero failed/skipped, including synthetic Unix-socket-only PostgreSQL 17 integration, rollback, concurrency and DAMM compatibility.
- Log: .amp/in/artifacts/dbc-batch-receipts-20261023/focused-final.tap. Disposable database was stopped/removed.
- NOT applied to shared DB: 0085. It is intentionally not registered in drizzle/meta/_journal.json yet.
- Before DBC imports: make reconcile.mjs phase-aware (all held liabilities versus DAMM withdrawals); existing default fails closed with DBC rows.
- Before deployment of ledger consumers: install the reviewed schema; new ledger queries require the new columns.
- Before real acceptance: validate exact DBC CPI/evidence shape against independently retained finalized execution; fixtures are not chain proof.
- No collector/request endpoint or transaction execution was enabled by this checkpoint.

## Open blockers and remaining owner actions
- Image: standalone build/complete runtime inventory, isolated boot/restart and production rollback acceptance outstanding.
- Read-only data: restore missing edge routes and a safe live reader/indexer without replay or rebroadcast; verify charts and timestamps before removing notice.
- Trading: fresh exact messages, wallet signatures, six-step finality/fees/refunds/session/DAMM checks still required. Do not infer execution from an HTTP 200.
- Owner accepted continued historical DBC fee-claimer exposure for reopening; moving pool custody did not revoke immutable fee-claimer/leftover rights.
- New launches: choose/bind safe replacement configs and fee destinations under recovered custody; never exposed keys.
- Hook release: adopted numeric ceilings/gate menu, exact publication/config/IDL/program/authority/ALT bindings and exact-message funding remain required.
- Hook irreversible gates: exact ALT freezes, tax authority removal, chain activation and signatures remain separate reviewed actions; app disablement does not protect direct callers.
- Recovery: leftover-token rescue then exposed-wallet sweep/finality/refund allocations; do not repeat the 12 completed custody transactions.
- Payouts: real claims/execution receipts, reconciled entitlements, 65 unbound creator recipients and partner allocation policy; beneficiary liabilities are not funding.
- Other allocations: base-token/TIP/bundle/rent policies and replacement-config count remain unbound; no defensible all-in quote yet.
- X/Slack rotations are approved but owner login is missing. Browser space 2 was handed off (p1 Slack sign-in, p2 X sign-in); never print credentials.
- Railway notice names kikka's Projects; current CLI sees ares's Projects. Need notice/workspace ID and correct access after site restoration.
- Surplus/inference keys, separate inference DB and internal secrets remain explicitly deferred, not revoked or cleared.
- Completed main DB, Helius, GitHub App/OAuth, R2 backup and HF OAuth rotations must not be repeated. HF invalid-code probes were not independent revocation proof.

## Budgets and safety gates
- Six swaps: gross ceiling 0.021225960 SOL; human signatures; no replacement retries or sale-proceeds budget credits.
- Rescue/sweep: 0.003011880 SOL; transient peak 0.004475320 SOL.
- Hook canary: 0.15 SOL all-in; release retry allowance: 0.025 SOL.
- Existing approved scopes/budgets stand. Stop only for required signatures, above-cap spend or a genuine unresolved risk decision.
- Existing scoped 2.096360080 SOL envelope excludes unresolved payouts/configs/provider bills; it is not an all-in completion quote.
- Do not spend collection principal or beneficiary liabilities. Preserve encrypted backups and the working production site.

## All 39 commits unpushed before this checkpoint (newest first)
561b729 Document required view-owner SET ROLE permission
68bac85 Replace discovery views using their existing noninherited owner role
6abb00a Restore public discovery through an isolated bounded writer and safe views
95a196e Identify the serving container policy across Worker propagation
6c2caae Bind production origin for same-origin repository search
5712a9c Restore public discovery and wallet routes without enabling financial writes
84cfe76 Gate existing-market tests with durable one-use budget and DAMM checkpoints
6fa4f40 Distinguish safe review rollout failure stages
85b259d Read pinned custody file inside the trading review image
b73a5db Bundle exact custody manifest within the review Worker
e75ff9a Pin review-only trading boundary and restricted database grants
a61d78c Scope existing-market trading recovery to reviewed custody and markets
89d7724 Require adopted Hook Playground bounds and gate menus
9ffd3ec Permit zero creator fees only for selected-hook requests
d64b99a Verify custody governance against complete finalized block history
713c70c Reconcile receipt-backed recovery and separate vault custody from payouts
67310f3 Bind custom-fee lifecycle tests to existing combined safety bounds
287e9e9 Disclose the included creator share throughout selected-hook trading
7d81d4a Honor the recorded creator-fee share and selected-hook customization
0ac9ddd Integrate exact token-tax split candidate and economic lifecycle evidence
36e8fee Clean disposable E2E runs and commit exact tax-hook browser evidence
d3cbf4f Persist selected-hook authority evidence and prove both economic lifecycles
c5b7842 Pin deployed token dependency and refresh V1 release preparation
aac4c09 Complete local creator-selected hooks V1 and clarify approval reviews
bfa9e6b Correct selected-hook availability copy for production release gating
e952802 Gate production selected signing on adopted release and deployed hook evidence
5c50b3f Record selected release acceptance, candidate binding and owner input blockers
7a6562c Verify nongate selected-hook lifecycle through exact-message local execution
ed3d3cf Count actual typed snapshot bytes within preparation evidence bounds
d81b7e6 Cover selected request and execution migration review boundaries
e7358cb Prepare offline upgrade message reviews with explicit signing blockers
41a27d8 Integrate selected-hook launch and measured native trading behind local acceptance
d7f1afb Persist creator-selected hook requests without opening signing
48daf42 Retain and reconcile selected-hook config-only preparation settlement
43e0379 Show creator-selected hook configuration without enabling signing
f28cf92 Retain selected-hook preparation intent and verify exact-message deltas
3159678 Pin independent placeholder fixture instead of newest final build
99c017e Build independent selected-hook launch and transfer account plans
f4dc396 Add registry-derived selected-hook ABI plans and fail-closed native boundaries

This checkpoint adds the eight custody source/schema/test files and this STATUS.md. See its commit for the exact diff.
