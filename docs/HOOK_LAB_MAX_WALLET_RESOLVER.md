# Max-wallet launch resolver: inactive server composition

This local implementation is composed into the default-disabled native runtime. No production deployment configuration is installed. Public `buildMaxWalletLaunchReview` still rejects caller evidence. The legacy adapter remains zero-fee-only; the separate explicit V3 family implements inclusive creator-quote fees with 25% platform and 75% creator, per-swap flooring and residual assigned to creator. The total creator fee must be selected explicitly and pinned, never defaulted.

## Interfaces

`coLocatedMaxWalletLaunchResolver(pool, { origin, config, profile, dossierJson, connections, clock })` returns `resolve({sessionToken, preparationId, request, limits, expectedReview})`. All factory parameters belong to trusted application composition, never HTTP JSON. The operator config is default-off, strict and contains no fee defaults. Operator approval is operational: an explicit approval reference and exact reviewed config must be provisioned by authorized operators. A cryptographic owner-adoption envelope is not a protocol requirement and is not fabricated here.

The resolver constructs its own co-located wallet journal and does not accept a caller principal/evidence resolver. It freshly reconciles retained signed preparation wire, transaction inclusion, two-reader account/program evidence, conflict state, current wallet session and exact request identity. The new journal `resolveForLaunch` is server-only and refuses the injected-principal candidate journal.

The collector reads finalized snapshots from two distinct configured connections with exact reviewed provider names, distinct trust domains and HTTPS origins. URL differences alone do not establish independence: operators must review trust-domain assignments. It validates actual genesis, precise program/ProgramData/ELF/authority/deployment pins, IDL/profile pins, immutable gate, token dependency hash, reviewed configuration/governance/quote bytes, current creator authorization, exact prepared policy/registry/selected-config hashes and absence of launch targets. Bootstrap config is used only to derive the exact inventory and must match the final snapshot.

A pinned ALT, if configured, is read from the same snapshot and validated for owner/hash/state/warmth. The blockhash is checked by both readers, and both quote the exact compiled message fee. Config explicitly names signature fee basis, supported creator/author fees, LP fee, maximum creator fee, protocol fee, launch protocol share, launch fee and pool creation fee. Observed values must equal them; no 1% or other hypothetical split is supplied as a default. Caller limits are debit ceilings, not permission to select alternate economics.

Compilation uses the same deterministic core as fixture tests, through a separate strict durable-proof schema. It never calls the fixture planner and never relabels synthetic fixture evidence as production. The raw compiler and collector are not authority boundaries; their direct-call outputs remain unauthenticated and cannot sign. Only the co-located server composition reports `operator-pins-and-state-verified`, with all sign/submit/retry flags false.

## Signing integration constraints

The result binds owner, stage, preparation ID/signature/intent, exact request, profile hash and message hash. A signing lifecycle must durably retain the operation-to-preparation/request/limits mapping; it cannot obtain it from an unauthenticated caller callback. Network collection and resolver journal transactions must happen outside any already-held signing/session lock to prevent cross-module lock inversion. After collection the resolver rechecks the current principal and record; the eventual signer still needs its own atomic current-session/custody-stage lock and exact review binding immediately before signing. Supply the retained `expectedReview` for revalidation. This preserves its exact blockhash, checks current two-provider validity/state/fees, recompiles the same intent and ceilings, rejects any change to message/identities/accounts/fees/deadlines, and returns the original review. Only fresh observation metadata may differ internally. The result also includes the decoded verified `observedAdmin`.

Collector and resolver runtime failures are redacted to fixed safe error text; raw RPC transport URLs, credentials and database exception details are not returned.

The integrated amendment below adds exact-wire settlement and default-disabled runtime composition. Local success does not authorize production activation.

## Local validation scope

- Existing 125 fixture tests retain identical deterministic bytes and closed public-export behavior.
- 25 new collector tests use injected synthetic RPC responses and the real compiler, including exact Rust-vector instruction/message equality and rejection cases.
- Synthetic tests establish deterministic behavior only. They do not establish live deployment, owner approval, actual RPC provider independence, fee design acceptance, production custody or successful chain execution.

Fresh external deployment material, operator review and explicit economics approval remain prerequisites. Enabling configuration or accepting a zero-fee deployment is not implied by this artifact.

## Integrated candidate amendment (not yet consolidated-validated)

The implementation now has an explicit inclusive family using `parseMaxWalletLaunchRequest` and shared inclusive profile/preparation schemas. The launch schema is `repoing/inclusive-max-wallet-launch-request/1`, with policy version 2, fee model 2, protocol share 2500 and explicitly chosen creator fee. It selects `create_launch_custom_v3`, PolicyV2, V3 commitments and the trailing immutable collector-policy account. Legacy requests retain their original zero-fee behavior. Exact new source/IDL/ELF/vector qualification remains required; adding a compiler family does not provision or approve a deployment.

Each resolved review includes `configurationSha256` and a private server-only `settlementContext` containing the original compiler input. The signing store retains that original context, including pre-state, instead of replacing it during freshness checks. It must never expose this private context through browser summaries.

`coLocatedMaxWalletLaunchResolver.reconcile` authenticates the current wallet against the durable preparation before and after read-only collection. It intentionally does not run the preparation launch-absence reconciler after launch. The new settlement collector verifies exact signed bytes, both finalized transaction responses, same block inclusion, safe balance metadata, authenticated self-CPI creation events and complete canonical initial postconditions. It also checks exact program-data pins after inclusion, unchanged prepared policy/configuration, one-step shared configuration and grant counters, all initial native-token mint/holding/pool state, exact treasury and payer deltas, rents and budgets. Inclusive state additionally binds creator fee, fee model, share and immutable collector account.

Settlement output contains only immutable inclusion/transaction/state/event hashes and verified native amounts; read timestamps and latest snapshot slots are excluded. Missing or inconsistent facts remain unresolved or conflicting and cannot authorize a replacement launch or retry. A failed transaction can finalize only with exact fee-only balance effects. Later legitimate trading or unrelated shared counter changes may make the conservative initial-state proof unavailable. Without an independently reviewed historical replay/archive, that case remains unresolved rather than treating a decoded creation event as full settlement.

The frozen token IDL is used only as a pinned account-layout codec. Its embedded historical address does not select an execution target. Actual token identity and ELF are separately bound by the reviewed profile/dossier and chain observations. This ABI compatibility must be qualified with the new deployed artifact package.

## Final V3 local integration evidence

The final actual SBF builder vector reproduces V3 launch instruction data and ordered account metas exactly. A local PostgreSQL integration exercises the real runtime, session, custody, preparation resolver, preparation journal, launch resolver, wallet/server signing boundaries, single-submit sender and both settlement stages with injected synthetic RPC and test-only keys. It preserves one generated mint, checks repeated reconciliation and rejected repeat submission, and refuses a revoked session. It does not contact production RPC or establish deployed readiness. The separate settlement rejection suite covers incomplete, conflicting, expired and altered evidence.

Generated executable-bearing test data stays external: `HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR/inclusive-builder-vector.json` and `HOOKLAB_INCLUSIVE_TOKEN_ELF`. The shared fixture has workspace defaults for source-rebuild validation; a clean checkout must generate or explicitly provide the final pinned fixtures. These generated artifacts must not be included in a source-only archive.

Schema2 dossiers explicitly support `config-counters-v1` only for canonical launch/swap Config PDAs. Each pin retains original approved bytes, their exact hash and the known IDL digest. Both baseline and observed Config are canonical decoded/reencoded, with only launches/pools_created permitted to increase from the approved floor. Every other byte remains exact; schema1 remains full-byte matching. The shared observer applies this to preparation, launch and trading reads. A two-launch runtime regression confirms the same reviewed dossier survives both creations.

All fourteen derived initial poststate accounts match a separately captured actual SBF after-create snapshot. Base mint derivation preserves the exact prior serialized-authority tail after revocation; it does not ignore allocation padding.
