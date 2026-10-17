# Inclusive creator-fee swap candidate

This is a separate source-candidate family. The legacy zero-fee profile and planner are unchanged. Production entry points remain unavailable; no synthetic snapshot is a receipt, deployment approval, or signing authorization.

## API

- `modelInclusiveCreatorQuote` models authenticated-state projections for fee model 2 only. Gross creator budget uses the existing ceiling calculation and existing tiny-trade omission when the fee consumes the entire leg. Platform receives `floor(gross / 4)` and creator receives the residual. Buy pricing uses input minus gross; sell pricing precedes the gross output fee.
- `buildInclusiveMaxWalletSwapReviewForFixture` consumes the separate inclusive profile, exact chosen creator fee, two matching synthetic state observations, current blockhash and bounded instruction budgets. It returns the exact unsigned swap message and account metas, with all execution/adoption flags false.
- `buildInclusiveMaxWalletSwapReview` always fails closed. Real authenticated runtime-state and production authorization work remains separate.
- The fixture adapter requires explicit actual LiteSVM export provenance and complete inventory. It does not manufacture account snapshots or reuse legacy ELF pins.

## Checks

PolicyV2 is exactly 90 bytes at `policy-v2`; the immutable collector policy is exactly 75 bytes at `inclusive-fee-policy`. The collector policy is the final read-only remaining swap account. Creation uses this same PDA writable. The two versioned callback names and discriminators are required in the bound Launch IDL.

The chosen fee must agree across request, profile, selected LaunchConfig, PolicyV2 and Launch state. Model 2 and share 2500 are explicit. Flat protocol/LP/sniper, rewards, modules, author shares, arbitrary custom hooks and nonempty rules are unsupported. The permitted custom gate remains the explicitly bound immutable max-wallet gate.

Balances distinguish curve quote reserve from accumulated platform fees. The quote vault must equal their sum. The Launch quote holding must equal net creator fees accrued minus claimed. Old accruals are retained separately from each new fee. This bounded adapter rejects creator-counter saturation and graduation crossings rather than broadening the supported state space.

## Evidence boundary

Unit tests cover rounding, conservation, minimum output, cap, fee mismatch, unsupported economics, overflow, exact serialized V3 commitment domains and collector account privileges. The full planner has been compared with actual new SBF buy/sell snapshots: exact instruction bytes, all 24 ordered metas and delivered/minimum outputs match. Reproduce with `HOOKLAB_INCLUSIVE_VECTOR_DIR=<absolute generated-vector directory> node scripts/check-inclusive-swap-vectors.mjs`; generated app plans remain outside source. Buy gross 10001 splits into platform 2500 and creator 7501; sell gross 3303 splits into platform 825 and creator 2478. Neither math tests nor matching hashes establish production provenance or authorizer approval. No ELF, account snapshot, live key or deploy profile is included in this source-only adapter deliverable.

## Authenticated trading path

`inclusiveTradeResolver` collects actual finalized state from two independently pinned providers, verifies the deployment dossier, reconstructs the candidate compiler input, checks blockhash and exact network fees with both providers, and simulates the exact unsigned message. Request bodies cannot supply observations, instructions, endpoints, program pins, a different payer or a different recipient.

`createInclusiveTradeRuntime` requires explicit server-owned trading, deployment and economics approvals. Installation is separate and defaults to null. The HTTP surface additionally requires `HOOK_INCLUSIVE_TRADING_ENABLED=true` and wallet identity enabled. No runtime was installed and no transaction was signed or sent during this work.

Trades reuse the same authenticated durable signing lifecycle with explicitly configured `inclusive-buy` and `inclusive-sell` stages. Apply `hooklab-native-signing-trade-schema.sql` after the existing signing context/refresh migrations. The wallet is the only signer; no mint/server custody keys are used. A trade's signing UUID is also its durable intent UUID. Repeating a quote for that UUID returns the retained original request. The UI must show that returned request, not assume a changed form replaced it.

The shared lifecycle validates exact wallet-signed bytes, claims submission durably before I/O, and never automatically resends an uncertain result. Reconciliation verifies the exact signed wire, finalized inclusion and matching reports from both providers, pinned executable evidence, fee-only native balance movement, and authenticated canonical self-CPI `Transferred`, `Swapped` and `InclusiveCreatorFeeAccrued` events. Ordered token transfers prove transaction-local before/after balances, owners, authorities, routes and conservation; reconstructed reserves must reproduce the actual curve result and exact fee split. Signed minimum output is enforced. Actual impact or advisory review-slot overruns remain finalized execution with explicit policy-review warnings; those two advisory ceilings are not encoded in the swap instruction. Finalized success/failure and conflicts are retained by the shared lifecycle.

HTTP tests cover default-off activation, origin/session controls, rejecting observation/owner/legacy-mode injection, original-intent retention, and routing only the requested submission. Full production activation still requires independently approved deployment evidence and operator bootstrap. Source compatibility and mocked HTTP tests are not production acceptance.

Receipt acceptance rechecks pinned executables and immutable policy accounts, but never substitutes later mutable holdings, pool or config state for historical transaction evidence. Later unrelated swaps cannot erase a proven receipt. The offline deterministic post-state helper remains separately byte-for-byte checked against the subsequent SBF snapshot. `initializeInclusiveTradeRuntime` constructs the database pool from the wallet-identity configuration. Runtime requires schema-2 counter-normalized launch and swap config bindings.

Transaction-local validation: set `HOOKLAB_INCLUSIVE_VECTOR_DIR` to the external `audit/inclusive/transaction-local` directory and run `node scripts/check-inclusive-swap-vectors.mjs`. The disposable SBF exporter retains authentic token self-CPI bytes and inner-instruction ancestry; no generated account snapshots or ELF binaries are included in this source manifest. Both actual buy/sell reconstruction and advisory impact warnings pass. Exact blockhash/blockheight lifetime remains mandatory, and pre-submit expiry gates are unchanged.
