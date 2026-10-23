# Restoration checkpoint — 2026-10-23 20:15 UTC

## Delivery and instructions
- Repository: New1Direction/repo.ing; working branch: repair/creator-selected-hooks.
- Backup destination: backup/restoration-checkpoint-20261023; never merge or push main without authorization.
- Backup checkpoint f5986d4 (39 prior commits + tested custody changes) was pushed and its remote SHA verified; main is unchanged.
- Priority: checkpoint → standalone image below 600 MB → read-only routes/live data → existing-market trading → independently accepted launches/hooks/claims.
- Surplus/gacha remain deferred. Do not restart inference or repeat completed credential rotations/custody transactions.
- No private Hook Lab ELFs, recovery envelopes, secrets or custody material belong in Git or image build contexts.

## Live now / gated
- LIVE: https://repo.ing public browsing, discovery, keyword search and fresh repository listings.
- LIVE 19:27 UTC: standalone container and `/api/health` (HTTP 200), exact image/12 JS assets verified; all 12 safety-boundary checks passed.
- LIVE 19:40 UTC: `/api/mcp/readonly` and read-only `/api/mcp` alias; market lookup/totals work, unknown trade tool rejected, all 12 financial-denial checks passed again for this changed image.
- LIVE: bounded discovery writer and restricted public/operational database readers; historical accounting repair accepted.
- LIVE 20:04 UTC: chart-only finalized-chain indexing and fresh graduation observations; all 77 markets passed one complete scan, 59 new swaps inserted on the initial pass. Curve and graduated charts rendered and screenshots inspected.
- VERIFIED 20:14 UTC after safety rollback: `/api/health` reports ok, public submission returns 403, durable test run disabled/stopped with zero signed/broadcast/finalized swaps and zero reserved spending.
- GATED: existing-market execution; six wallet-restricted swaps have not completed finalized acceptance.
- GATED: ordinary launches, bundles, Hook Playground activation, beneficiary claims/payouts.
- DISABLED: historical replay/general worker; do not restart it. Credits/inference restoration is deferred.
- Public notice now distinguishes read-only finalized-chain charts from still-unverified fee accounting/payouts. Transient RPC failures can withhold individual progress after its five-minute freshness deadline; they never fabricate fresh timestamps.
- Production image is standalone ff52bd7a4f393fa5c821a5309b78419b73c030f12525d50241ca35e3210fd3c9; Worker b4c3856c-d857-45b2-ab6b-33661ae406cb; test stage is unarmed and submission disabled. Active config: .amp/in/cloudflare-compatibility-20261022/trading-test-unarmed.jsonc.

## Required owner decision: unintended unsigned first preparation
- At 20:12:43 UTC, a local console security probe intended to test a forged Host header instead prepared swap 1. Node fetch ignored its Host override; this was a test-harness mistake, not a bypass of the server Host check.
- No wallet was connected to the console; no signature, broadcast, settlement or swap spending occurred. Durable state: step 0, spent 0, history empty, pending signature null. Session 1e1ac587-13aa-4ee9-af41-e15fc86fe409 remains retained, never replaced.
- At 20:13 UTC the run was disabled and marked stopped, preserving its pending message, and production automatically returned to the accepted unarmed Worker on the same healthy image. A subsequent native http GET probe verified forged Host denial without any mutating route.
- The no-replacement rule requires an owner decision before replacing this expired unsigned message. Do not rearm/reset the run or prepare another swap under the existing authorization.
- Evidence: unsigned-probe-stop.json, six-swap-console-events.jsonl, post-stop-safety.json, unsigned-probe-unarmed-rollback.log under the existing-market artifact directory.
- Loopback console remains on port 3148, browser space 3 page p2; all signing is disabled. Sources .amp/in/six-swap-{console,client}.mjs; only the server holds the restricted API token, no private signing key. Owner's space 2 was untouched.

## Read-only indexer and verification
- scripts/recovery-chart-indexer.mjs uses independent finalized providers, canonical DBC/DAMM parsers and separate recovery_charts cursors/observations. It never advances accounting cursors or loads signing keys.
- Scoped repoing_chart_recovery role and site_public observation projection are installed. Encrypted credential: neon-repoing-chart-recovery.age in the existing custody backup directory. Do not reprovision.
- Persistent local LaunchAgent ing.repo.chart-recovery runs .amp/in/run-chart-recovery.mjs every 120 seconds without overlapping advisory-lock holders. It depends on this Mac/user LaunchAgent being available. Last report: chart-recovery-latest.json; transient failures retain only prior verified observations until expiry.
- Browser acceptance found a missing dammVolume24hLamports field causing BigInt(undefined) in GraduationProgress. The indexer now supplies the real 24-hour sum scoped to the verified destination pool and migration slot. Both market variants rendered successfully afterward; no app-image rebuild was needed.
- 19/19 targeted recovery/Worker tests passed. Restricted disposable PostgreSQL validation passed actual DBC/DAMM fixtures, sell amounts, idempotency, disagreement withholding and denied accounting writes.
- Broader targeted run: 22 passed, 3 DB-dependent tests skipped, 1 migration test failed because its required dedicated DATABASE_URL was absent. That migration suite was not validated; no shared migration was run. Prior 82 custody tests were not repeated.
- Unarmed production test-stage acceptance passed 19 checks with unchanged run/accounting counts; subsequent armed-stage gate checks passed before the probe mistake. Neither is six-swap acceptance.

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
- DONE: root multi-stage Dockerfile, default-deny build context and Next output:'standalone'. Current image is 400,588,800 uncompressed layer bytes / 123,631,066 compressed bytes; runtime app is 147 MiB. Eleven custody/ABI/runtime file hashes matched, including .railwayignore.
- Isolated rollout completed with ImagePulled/VMStarted on 4GB. Health, 12 JS hashes and forced binding-change restart passed. Production cutover accepted at 19:27:43 UTC; rollback armed but not needed.
- Previous healthy image 7e0d18bcc0cffcea142c28a7fe88b98621bebb0ce9168ddeb725ea0b9814d050 and Worker 417ee713-06f3-4a45-9b0a-0daad504a7cc are retained as pre-cutover fallback. Reverting requires BOTH Worker and container rollout.
- .railwayignore source audit found its explicit reader in tests/railway-upload.test.mjs, not application runtime. Kept it in tracing and verified its exact bytes; did not infer a missing app dependency.
- MCP recovery fix passed 49/49 tests and isolated/production acceptance: SELECT-only-compatible quotas and read-only alias; launch preflight stays unavailable during recovery. Prior standalone image f960eb… and Worker 0a4f7396-9dc5-4271-92c6-3f3368adcd2f are the immediate rollback pair.
- Read-only freshness audit covered all 77 markets: current cursors trail chain activity (many latest transactions are the completed custody moves, not new swaps). DAMM activity continues through Oct 23 19:19 UTC. Existing accounting cursors must not advance in a chart-only indexer.
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
- Image and read-only restoration are deployed; authorized backup-branch delivery includes packaging 1288e0d, MCP 2e5a0a2 and this chart recovery checkpoint. Verify the backup remote equals local HEAD after pushing; main stays untouched.
- First unblock the unsigned-message replacement decision above; only then obtain human signatures and continue exact six-step acceptance. No automatic retry is authorized.
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

## Railway follow-up, separate from site recovery
- The incident notice concerns kikka's Projects but the current CLI identity can see ares's Projects only. Obtain the notice's workspace/project IDs and membership/token access to that exact workspace.
- Then inventory every named service/environment and deployment credential there, map notice coverage to rotated versus still-live credentials, and verify revocations independently. Existing ares workspace checks do not establish kikka coverage. No Railway rotation is claimed complete for the inaccessible workspace.

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
