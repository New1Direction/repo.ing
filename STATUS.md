# Restoration checkpoint — 2026-10-23 agent signing failure contained

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
- VERIFIED after 21:45 UTC signing failure: durable test run disabled, phase prepared, step 0, spent 0, history empty. Replacement session 0b1f1faf-b663-4dee-893c-72c2cd704ef7 is unsigned and expired; both finalized providers report unchanged 0.1 SOL and only the original funding transaction. Original unsigned session remains archived.
- GATED: existing-market execution; six wallet-restricted swaps have not completed finalized acceptance.
- GATED: ordinary launches, bundles, Hook Playground activation, beneficiary claims/payouts.
- DISABLED: historical replay/general worker; do not restart it. Credits/inference restoration is deferred.
- Public notice now distinguishes read-only finalized-chain charts from still-unverified fee accounting/payouts. Transient RPC failures can withhold individual progress after its five-minute freshness deadline; they never fabricate fresh timestamps.
- Production image is repoing-agent-trading@sha256:5bde71c4b26197e4a782ef20c248023ee05df7debc510cbe5caa6d6801deb230, source 52cbf8a52938407eba15bc59281bdc03e651e98c; Worker bb509dea-d826-4414-aeaf-089ded43ea10. Isolated and production acceptance completed 21:43 UTC. Restricted test-stage submission binding is true, but the durable run is disabled. Token/wallet/one-use guards remain; public trading is closed. Active config: .amp/in/cloudflare-compatibility-20261022/trading-test-standalone.jsonc. Accepted unarmed rollback Worker: b4c3856c-d857-45b2-ab6b-33661ae406cb, image hook-playground-preview@sha256:ff52bd7a4f393fa5c821a5309b78419b73c030f12525d50241ca35e3210fd3c9. Rollback requires both Worker and container rollout.

## Original unsigned preparation and one replacement authorization
- At 20:12:43 UTC, a local console security probe intended to test a forged Host header instead prepared swap 1. Node fetch ignored its Host override; this was a test-harness mistake, not a bypass of the server Host check.
- No wallet was connected to the console; no signature, broadcast, settlement or swap spending occurred. Session 1e1ac587-13aa-4ee9-af41-e15fc86fe409 remains retained byte-for-byte in retired-unsigned-session-original.json and durable state.retiredUnsignedSessions[0].
- At 20:13 UTC the run was disabled and marked stopped, preserving its pending message, and production automatically returned to the accepted unarmed Worker on the same healthy image. A subsequent native http GET probe verified forged Host denial without any mutating route.
- Owner subsequently authorized exactly one unsigned replacement. Two finalized providers confirmed the original blockhash expired and complete wallet history since before preparation was empty; wire signatures were zero and no signed/submitted record existed. Original SHA256: 0cbc819f4c6387e1b85a0c4279db94f42fe4cdc7138ea5d30a1f781c125e859f. Native-http GET /state with forged Host returned 403 with unchanged DB state; no POST security probe is permitted.
- The authorization was recorded once and the original archived before rearming. The one replacement was CONSUMED at 21:45:54.884 UTC by session 0b1f1faf-b663-4dee-893c-72c2cd704ef7. Do not repeat authorize-one-unsigned-replacement.mjs, rerun agent-six-swap-execute.mjs, remove its lock/journal, reset history/spending, or prepare another message without explicit additional replacement authorization.
- Evidence: unsigned-probe-stop.json, six-swap-console-events.jsonl, post-stop-safety.json, unsigned-probe-unarmed-rollback.log under the existing-market artifact directory.
- Loopback console on port 3148 was STOPPED after owner said they do not possess the assumed Backpack wallet. Browser space 3 was handed off; do not reclaim it. Owner's space 2 was untouched. Sources .amp/in/six-swap-{console,client}.mjs are historical, not the new signing path.
- Evidence: unsigned-replacement-verification.json, one-unsigned-replacement-authorization.json, one-replacement-stage-readiness.json and wallet-control-handoff-stopped.json.

## Agent signer: funding approved, unsigned replacement expired after local failure
- Latest owner requests agent execution, not a Backpack handoff. No new trade preparation or signature may rely on assumed owner browser-wallet control.
- DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9 is the locally created controlled-test-identities-v1/dedicated-creator, selected from historical canary pins. Existing encrypted custody verifier successfully authenticated/decrypted and derived its public address without exporting keys or signing. Its 0.017862160 SOL is the remainder of a 0.05 SOL Hook canary transfer from the operational payer; do not silently reallocate it.
- DrAhCGXsHLNdJ9ihhRBkyKZSzY446qKg1Dcx6zEm9dmi is the separate locally created agent-test-wallet-v1/test-wallet. Its custody verifier also passed. Both finalized providers observed 0.1 SOL; complete history contains only the Oct17 funding transfer 24iVv9BBgKkatAhH1sDuJYBjiN5EcnFaTX2n9xgxPHy53iCsnPH3eFisj4miMPDL4QwLGQrqxswEMAcZRcvtunxD from FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy (documented custody buyback wallet).
- Original human provenance recovered from thread T-01a146fc-4b3c-70aa-ba5a-afef1de4145f: human #1700 reported sending 0.10 SOL, #1704 directed testing, and #1749 explicitly authorized agent buy/sell with DrAh. The 0.04 SOL test budget / 0.06 SOL untouched reserve wording was assistant #1703, not an independently stated human allocation. Preserve the reserve, but do not ask again for generic agent buy/sell permission. No human statement establishes freedom from buyback/beneficiary obligations.
- Neither test identity appears on the documented exposed hosted-key list; that alone is not absolute non-exposure proof. No exposed key, vault assets, beneficiary liability, new transfer or multisig bypass was used.
- CLEARED: owner directly answered “yes spend it” in T-01a16a2e-8386-7058-85c7-8ea910a43c4a to the specific DrAh funding-obligation request. Agent execution may spend up to 0.021225960 SOL, preserving 0.06 SOL untouched, the original unsigned evidence, one-replacement limit, markets/order/amounts and no-retry rules. No top-up is required.
- Guard now binds DrAh instead of DkD5; regression first failed on the old binding, then all 22 targeted durable-sequence/adapter/Worker tests passed on disposable PostgreSQL without skips. Source 52cbf8a is deployed and verified pushed to the backup branch. All 39 prior commits remain included; main is unchanged.
- Actual with-custody-keys.sh/keyserve access succeeded and solana-keygen independently derived DrAh through the private FIFO; command exited successfully with cleanup. No private material was exported. The corrected exact-message adapter has synthetic validation below, but no successful real swap signature or execution yet.
- The agent prepared swap 1, then the private signer failed before any submission. Prepared gross reservation was 4003858 lamports; durable spent remains zero. The executor disabled the run and retained the exact original/replacement messages and journal. No third message was prepared.
- Reproduced local signer defect with a synthetic key: Keypair.fromSecretKey retains the supplied Uint8Array, so wiping it before signing produces an invalid signature. The private adapter now keeps that buffer until signing finishes and wipes all mutable inputs in finally. Three synthetic exact-message/lifetime/rejection tests pass, including invalid-input cleanup; this is not real swap acceptance. The fixed adapter remains local under .amp/in/agent-swap-private.mjs, outside Git and image contexts.
- Read-only verification at finalized slots 460602175/460602183 confirms expired blockhash, no additional DrAh history, 100000000 lamports on both providers, unsigned retained wire, disabled run and unchanged original evidence hash. Evidence: agent-six-swap-execution.json, agent-signing-stop-verification.json. No valid signed wire, signature or submission exists in the retained execution journal. One additional unsigned replacement needs explicit authorization; spending permission alone does not extend the replacement limit.
- Existing keyserve helper can release the role through a private FIFO with a per-application Keychain grant; custody verification is not proof of that helper's current access or a tested exact-message signing adapter. Do not export keys, change Keychain ACLs, or treat prior synthetic signing tests as live execution.
- Artifacts: wallet-provenance-current.json, dedicated-creator-access-check.log, agent-test-wallet-access-check.log. No SOL spent in this investigation.
- Finalized slot 460579006 confirms H7TK remains feeClaimer on all four historical configs: accrued/new DBC partner trading fees and eligible partner surplus remain claimable. Creator trading fee share is 71%; migration fee percentage is zero. Last two configs still name H7TK as leftover receiver. DAMM NFT custody migration did not revoke these rights. Evidence: dbc-remaining-rights-detail.json. Owner accepted this historical exposure route; public reopening still requires six-swap acceptance.

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
- DONE: root multi-stage Dockerfile, default-deny build context and Next output:'standalone'. Initial accepted standalone measured 400,588,800 uncompressed layer bytes / 123,631,066 compressed bytes; current DrAh image remains approximately 400 MB uncompressed / 123.6 MB compressed. Eleven custody/ABI/runtime file hashes matched, including .railwayignore. Current isolated/production evidence: agent-image-acceptance.json. Local Docker transport recovered without restarting the VM; local entrypoint/database health subsequently passed in agent-local-health-recovered.json.
- Isolated rollout completed with ImagePulled/VMStarted on 4GB. Health, 12 JS hashes and forced binding-change restart passed. Production cutover accepted at 19:27:43 UTC; rollback armed but not needed.
- Previous healthy image 7e0d18bcc0cffcea142c28a7fe88b98621bebb0ce9168ddeb725ea0b9814d050 and Worker 417ee713-06f3-4a45-9b0a-0daad504a7cc are retained as pre-cutover fallback. Reverting requires BOTH Worker and container rollout.
- .railwayignore source audit found its explicit reader in tests/railway-upload.test.mjs, not application runtime. Kept it in tracing and verified its exact bytes; did not infer a missing app dependency.
- MCP recovery fix passed 49/49 tests and isolated/production acceptance: SELECT-only-compatible quotas and read-only alias; launch preflight stays unavailable during recovery. Prior standalone image f960eb… and Worker 0a4f7396-9dc5-4271-92c6-3f3368adcd2f remain historical rollback evidence; the current rollback pair is listed above.
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
- DONE: reconcile.mjs includes all phases' held creator liabilities, but only DAMM collections in DAMM creator/partner withdrawal comparisons. Regression reproduced the old phase-selection failure, then passed on disposable Unix-socket PostgreSQL with mixed DBC/DAMM collections and partial payouts. 24/24 targeted reconciliation tests pass, no skips; prior unchanged 82 custody tests were not repeated. This follow-up is packaged in the current image, but its consumers remain gated until migration 0085 and real-receipt acceptance.
- Before deployment of ledger consumers: install the reviewed schema; new ledger queries require the new columns.
- Before real acceptance: validate exact DBC CPI/evidence shape against independently retained finalized execution; fixtures are not chain proof.
- No collector/request endpoint or transaction execution was enabled by this checkpoint.

## Open blockers and remaining owner actions
- Image and read-only restoration are deployed; source checkpoint 52cbf8a52938407eba15bc59281bdc03e651e98c was pushed to backup/restoration-checkpoint-20261023 and the exact remote SHA verified, including all prior checkpoints, packaging and MCP. Main is untouched. This status-only follow-up uses the same authorized backup destination and does not change the deployed image.
- Temporary render-debug container removed and disposable chart PostgreSQL stopped; existing containers and the live chart LaunchAgent are preserved. Loopback signing console is stopped.
- Funding and actual private-helper access are cleared, DrAh binding is deployed, and the one authorized unsigned replacement was consumed by a contained signing failure. The message is now expired. Required bounded decision: authorize exactly one additional verified-unsigned swap-1 replacement, with the same 0.021225960 SOL six-swap cap and 0.06 SOL reserve. No generic buy/sell permission, wallet connection, exposed key or automatic retry is needed or permitted.
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
- Six swaps: gross ceiling 0.021225960 SOL; owner-authorized agent signing with DrAh and 0.06 SOL reserve; exactly one verified-unsigned replacement authorized and CONSUMED, zero spent; no further replacement retries or sale-proceeds budget credits without explicit authorization.
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
