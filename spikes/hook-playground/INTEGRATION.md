# Hook Playground integration plan

Status: **isolated metadata export implemented; production integration remains proposed and execution disabled**. Reviewed 2026-10-17 against repo.ing local base [381fb99](https://github.com/new1direction/repo.ing/commit/381fb99c912e081b9c655444ec5875880a8f05b9). Playground code stays in this directory. No production RPC was queried here; source capability is not deployment acceptance. Recheck these contracts against the reviewed integration base before implementation.

## Implemented milestone and ownership

The standalone **Scope & assumptions → Start separate plain draft** workflow now authors a blank metadata-only file. It carries no scenario payload, requires acknowledgement, validates UTF-8 name/ASCII ticker, previews the exact existing envelope with `blocks: []`, and invalidates that preview on any edit. No app route, account save, network binding, wallet, RPC, SDK or transaction functionality was added. All six simulation modules and the saved simulation remain unchanged. The browser-local authoring function mirrors the narrow existing metadata wire contract without importing app code; the receiving app must validate independently. This is the local export portion of S2, not production integration.

Focused validation: `npm test` passes 13 tests; `CHROMIUM_PATH=… npm run test:browser` passes 14 Chromium-desktop/WebKit-mobile checks, including empty/error/review accessibility, exact downloaded JSON, stale-preview invalidation, cancellation, unchanged storage, recipe-import refusal and zero interaction network requests. No broad repository test suite, production build, chain operation or live receipt acceptance is claimed; the standalone app has no build step.

Backend/indexer work is owned separately in [the backend thread](https://ampcode.com/threads/T-01a149f3-dfcc-720c-b113-3705cb46a89e). No changes were imported from that checkout. That thread reports restrictive plain-only deployed binaries at a different source revision, zero configured protocol fees and no graduation proof; those reports are not independently adopted deployment evidence in this checkout. Do not substitute this plan's source candidate for those binaries.

### Backend contract requirements and owner-operated gates

- Capability responses must be versioned and fail closed per action: creation, buy, sell, recovery, fee accrual, fee collection, graduation and custom Hooks are distinct. A validated draft, indexed event or successful synthetic test enables none of them. No environment/client flag activates public submission.
- Bind production intent separately to adopted genesis/profile/ELF/dependencies/config, exact signer/message/ALT bytes, raw amounts, slippage/debit caps, deadline and expiry. Never accept simulation JSON, client snapshots, booleans or quote decimals as authority. Keep authentication separate from spending approval.
- Index finalized Hook-native raw receipts by genesis/profile/signature plus outer-instruction and inner-instruction ordinal. Preserve block lineage, provider agreement, raw event bytes, emitting program and event-authority binding, transaction failure and unknown events. Advance a durable cursor only in the same transaction as retained evidence; missing/pruned/divergent receipts stay unresolved. Do not route these rows into Meteora aggregates.
- A buy/sell event must bind pool, trader, recipient, direction, exact input, actual delivered output, ordered deltas, burns/cuts, LP/protocol fees, reserves, swap counter and slot. Receipt acceptance additionally requires signed-message identity, finalized success, adopted program policy and transaction-position account/economic evidence. Later account snapshots cannot prove past postconditions.
- **Nonzero fee proof:** source math support and zero-fee trades prove no routing. Independently test nonzero quote accrual and separate collector settlement, rounding/dust, buy/sell asymmetry, sniper window/first-creator exception and fee-ledger versus reserve accounting. Creator recipient splits are not protocol fee collection and remain unsupported in this plain export.
- **Graduation proof:** independently test the quote-threshold and sold-out-base paths, one raw unit below threshold, reserve top-up/burn, cleared virtual offsets, LP supply/holding ownership and post-graduation swap accounting. An event or progress meter alone is insufficient. No permanent LP lock claim while upgrade authority exists.
- **Custom Hooks require a reviewed upstream release for the pinned guarded production path.** Generic source supports some custom token Hooks, but guarded creation rejects custom attribution and the production profile declares Kit incompatible. The owner/protocol team must approve compatible programs, compiled dependency/signers, profile/IDL/SDK, registry/extra-account/authority policies, adversarial callback tests and deployment acceptance. Plain must never be relabeled custom Hooks. SDK-only work cannot remove on-chain restrictions.
- Owner gates remain separate: source/release review; deployment adoption; approved nonzero economics and bounded validation attempts; custody/partial-signature/restore acceptance; DB/hosting/monitoring rollout; and any real-money or unpause authorization. None is granted by this export milestone. No new protocol binary, fee change, public unpause or trade was attempted here.

## Recommendation: keep three separate products and data contracts

1. **Playground:** educational scenarios; `repoing-playground/1` exports and `repoing-playground-draft/1` backups. Local numbers, no identity, wallet, RPC, SDK, account store or transactions. Keep its separate origin, storage key and `connect-src 'none'` CSP. Production publication of this simulator is a web release, not chain activation.
2. **Recipe authoring:** `repo-ing/hook-lab-recipe/1` envelope containing `hook-lab/1`. The existing `/coins/new` supports lossless drafting/saving and read-only devnet inspection. A saved recipe or successful format validation is not a launch authorization.
3. **Production plain preparation:** `repoing/plain-intent/1`, built by server-side `preparePlainReview`. This separately pinned candidate prepares exact unsigned bytes offline. It is not connected to public simulation/signing/submission. `/api/hook-lab/production` POST and `submitPlainTransaction` unconditionally refuse with 423.

“Production-capable” below means **expressible by the pinned production source builder**, not available to a user today. Production readiness currently returns `activeProfile: null` and all operation capabilities false. No UI state, import, query parameter, environment toggle or successful simulation may override that gate.

### F1 — “Plain” has different meanings across the current contracts

The older authoring template named `plain` permits optional `creator_fee` and `burn` blocks. Current devnet consumer preflight refuses **any nonempty block list**, even explicit zero-valued blocks. The production source candidate independently forces creator fee zero, no rules, no Kit/template/custom-hook configuration, no initial buy and no quote liquidity seeding. Do not infer a production capability from a template name, IDL presence or SDK export.

Sources: [templates](../../src/hook-lab-templates.mjs), [recipe persistence](../../src/hook-lab-recipe.mjs), [preflight](../../src/hook-lab-preflight.mjs), [disabled plain adapter](../../src/hooklab-plain.mjs), [production consumer contract](../../docs/HOOK_LAB_PRODUCTION_CONSUMER.md).

## F2 — Exact module boundary

| Playground module / field | Production-source counterpart | Integration rule |
| --- | --- | --- |
| Bonding curve / `reserve` (5–100 SOL*) | Creation intent `virtualQuote` is an integer raw quote amount within inspected launch-config bounds. Supply, decimals, curve allocation and derived virtual base come from that config. | **Conceptual analogue only.** Never copy or unit-convert the toy reserve automatically. Production preparation starts with a blank explicit choice, checked against trusted quote mint/decimals/config. No selectable arbitrary curve function. |
| Fee splitter / `fee` (0–15%) | Production builder forces `creatorFeeBps: 0`. Protocol LP/sniper economics remain applicable; plain is not fee-free. | **Unsupported.** No fee split, creator recipient, creator-fee block or projected creator income may cross. Do not “disable” this module by translating it to a zero-valued rule block. |
| Treasury / `share`, `lock` | Treasury and collector are program-configured recipients, not launch-user choices. Creation pays fees/rent; trading fee accrual is not a project treasury split. | **Unsupported.** Never map to creator lock, LP lock, fee collector override or custody assurance. |
| Graduation / `target` (20–200 SOL* net) | Graduation quote is derived from `virtualQuote`, supply and curve allocation. It is not an independent creation input. | **Derived read-only explanation only.** No editable target, countdown guarantee, migration transaction or graduation button. No post-graduation price prediction. |
| Governance / `delay` (hours) | Production config/upgrade authorities and creator grants are separate controls. The pinned launch/swap profile has no admin/upgrade timelock. | **Unsupported.** Do not turn a slider into a promised delay, quorum, immutable policy or upgrade protection. Show actual adopted authorities and powers only after verification. |
| Safety / `limit` (single purchase) | No plain per-purchase or per-wallet rule. Creation has economics/debit/deadline guards; swap min-output is a distinct lifecycle contract. | **Unsupported.** A toy purchase guard is neither a creator grant nor transaction slippage protection. Never translate it to Kit `max_wallet`. |
| Scenario / `demand`, `buyer`; displayed risk | Neither is a launch instruction parameter. A launch creates no first-buyer purchase. | **Simulation only.** No forecast, guarantee, live buy quote or risk certification. Keep “Moderate/Elevated” out of transaction readiness. |

All six cards can remain available in the **simulation**. A later production plain form is a separate surface, not Expert mode and not the same module graph with disabled sliders. Custom Hooks, Kit, Half-Life, burns, holder rewards, fee claims, swaps and add/remove liquidity remain excluded from the first production increment.

## F3 — No lossless simulation-to-recipe conversion exists

The simulation scenario contains no coin name/ticker, URI, creator, mint, fee payer, network, profile or transaction budgets. The new metadata form is separate from that scenario. Its economics are not recipe fields. Renaming the simulation JSON format or dropping connected modules would fabricate a different intent.

**Handoff contract (local metadata export implemented; app navigation remains proposed):**

- Retain the original scenario unchanged. A user may explicitly choose **Start a separate plain draft**, after reading that no simulation settings or predicted returns will be carried over.
- Open a blank metadata form; no simulation JSON in a URL, local-storage bridge, API body or production recipe. No cross-origin auto-import or `postMessage` bridge. A simple navigation to an approved authoring entry point carries no scenario payload.
- Validate metadata with existing authoring rules: nonempty trimmed name ≤32 UTF-8 bytes; ticker 1–10 ASCII alphanumerics, explicitly normalized by the existing exporter. Do not truncate, invent defaults or silently sanitize invalid input.
- Use `createHookLabTemplateDraft('plain', coin)` → `exportHookLabTemplate` → `createHookLabRecipe(raw, 'plain')`, and independently require `blocks.length === 0`. Do not widen or silently normalize the persisted recipe contract. No wallet or signing identity is created merely to draft metadata.
- Shape after explicit user input:

```json
{
  "schemaVersion": "repo-ing/hook-lab-recipe/1",
  "template": "plain",
  "recipe": {
    "format": "hook-lab/1",
    "coin": { "name": "User-entered name", "ticker": "USER" },
    "blocks": []
  }
}
```

This example is a **draft**, not a production intent. The envelope has no network binding. Network/profile must be separately confirmed at preparation, never inferred from this JSON or added as unsupported envelope fields. Existing devnet inspection stays devnet-only; do not send production intent to `/api/hook-lab`.

For existing richer recipes, preserve every field and refuse production conversion. Offer a separate blank plain draft only with an explicit choice; never overwrite the richer original. Playground imports continue refusing `hook-lab/1` and transaction formats. A draft backup remains different from mint/signature custody.

### Production intent needs inputs the recipe does not contain

`plainIntentSchema` requires `schema`, `creator`, `feePayer`, `mint`, `name`, `symbol`, `uri`, `virtualQuote`, `deadlineSlot`, `maxLaunchFeeLamports`, `maxPoolCreationFeeLamports`, `maxRentLamports`, `maxInstructionDebitLamports`, `maxNetworkFeeLamports`, `computeUnitLimit`, and `computeUnitPriceMicroLamports`. u64 amounts are canonical decimal **strings**, not JS floating-point SOL values. URI is empty or HTTPS, ≤200 UTF-8 bytes. Wallet connection does not select the approved creator or approve a budget.

Server-owned preparation additionally needs finalized deployment/config/control/grant bindings, blockhash and last-valid height, observation/review expiry, exact network fee, account rents and retained address lookup tables. Never accept client-supplied snapshots, readiness booleans, governance hashes, RPC URLs or quote decimals as authority. The existing offline snapshot argument is a test/preparation interface, not a safe public request schema.

## F4 — Economics must be replaced, not relabeled

Playground `model.mjs` uses 1 billion virtual tokens, floating-point arithmetic, a toy 1% protocol fee, optional creator fee and treasury percentage, independent net graduation target, and aggregate buy-only demand. It omits actual supply allocation, raw token decimals, time-dependent sniper fees, integer rounding, rent and network costs. `src/hooklab-quote-model.mjs` is also explicitly hypothetical/nonexecutable; it is not a shortcut to a live quote service.

At the pinned production source, for integer raw supply S, curve allocation b basis points and virtual quote Vq:

```text
C  = floor(S × b / 10,000)       curve allocation
R  = S − C                      launch reserve
require C > R
Vb = floor(C × R / (C − R))      virtual base
T  = floor(Vq × (C − R) / R)     derived graduation quote
```

These are creation-state derivations, not a demand forecast. Initial real quote and LP supply are zero; creation still creates a pool and deposits C base tokens. Production plain creator fees are zero. LP/sniper fees route to protocol under the pinned launch-pool rules; the quote-vault accrual and configured collector are not arbitrary beneficiary payouts. Source graduation mints first LP to the launch PDA holding with no withdrawal instruction in that pin. Upgradeability means **do not promise permanent lock, burned LP or immutable custody**.

Required economics work before production review:

1. Obtain an approved source/profile/config/quote-mint pin and independently reconstruct creation allocations with BigInt, checked integer boundaries and source-equivalent rounding. Derive display values from verified raw values; never use the simulation floats to form instructions.
2. Verify creator instruction debit (rent + launch + nested pool fee) separately from the outer payer's network/priority fee. Use exact message fee quotation, exact rent inventory, reviewed caps and requested-CU priority-fee rounding. Supply a human-readable debit breakdown without counting a virtual reserve as deposited SOL.
3. Obtain producer raw vectors and independently derived expectations for allocations, authority clearing, pool/vault links, fee destinations and grant consumption. Cover min/max Vq, one raw unit outside bounds, non-divisible allocation, zero/nonzero program fees, distinct fee payer and creator, fee/rent cap drift and u64 overflow. Historical devnet fees are not production defaults.
4. Defer all buy/sell outcomes and live price quotes. They require production-aware lifecycle SDK builders plus independently verified buy/sell integer math, fee ordering, sniper-window boundaries, first-creator exception, net-min-output protections and real receipt vectors. Do not display simulated creator revenue as expected launch proceeds.

## Implementation sequence and acceptance gates

The standalone export subset of S2 is implemented as described above. App integration and the other production steps below remain **proposed**. S3–S6 have explicit evidence/operational gates; no step's success grants permission for the next external action.

### S1 — Freeze the simulation/publication boundary

Owner: web/UI. Scope: this directory only, its `README.md`, tests and eventual standalone deployment configuration. Keep the existing visual system and browser safeguards. Do not add wallet packages, RPC or production imports. A later integration entry point must label the destination as a separate workflow.

Acceptance: retain the 13 Node and 14 Chromium/WebKit tests; verify module edits make no network requests, invalid data suppresses results, two tabs cannot overwrite drafts, unsupported imports refuse, and 320px/mobile touch states remain usable. Complete real-device and screen-reader testing. Deploying the standalone site still requires an approved HTTPS origin, headers, edge limits, health monitoring and rollback owner. No production app route changes in this stage.

### S2 — Add an explicit blank plain-draft entry point, not a converter

Owner: authoring/UI. Proposed entry: a metadata-only section on the existing `/coins/production` page, owned by `app/(site)/coins/production/page.jsx` and `app/components/hooklab-plain-preparation.jsx`. Reuse `src/hook-lab-templates.mjs` and `src/hook-lab-recipe.mjs` validation; do not mount the existing recipe planner's custody flow or replace `/coins/new`. Create the section without requiring a wallet. Export a new metadata draft to a file; optional account save uses a new draft UUID/revision through the existing authenticated save API, never its devnet inspection/quote actions. Do not overwrite the existing local recipe slot. Keep schema versions and account-save revision checks; keep the standalone Playground unchanged until the explicit navigation is separately approved.

Acceptance: test all six selected simulation modules and both draft formats are never treated as production input; test zero-valued rule blocks and opaque extensions still refuse production conversion; preserve original simulation/rich drafts byte-for-byte; test metadata UTF-8 limits and blank/zero/omitted distinctions. Cancel leaves both originals unchanged. All production action capabilities stay false. Account storage, if offered, retains existing owner/session/same-origin/quota/revision controls; no new database schema is required for metadata-only authoring.

### S3 — Bind source and live evidence to read-only production preparation

Owners: protocol/SDK + consumer security. Reuse `src/hooklab-plain.mjs`, `hooklab-production-observer.mjs`, `hooklab-production-rpc.mjs`, `hooklab-message-boundary.mjs` and `scripts/vendor-hooklab-readonly.mjs`. The separately namespaced candidate pins [Hook Lab f3062df](https://github.com/new1direction/hook-lab/commit/f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32); its presence is not adopted deployment evidence. Add a producer-specific verified config/control/grant adapter at the existing server boundary, not inside the Playground.

Prerequisites: frozen source/profile/SDK/IDL/lock/provenance package and independently verified signed provenance; complete transitive program/quote dependency inventory; operator-reviewed dossier; two genuinely independent RPC trust domains; finalized ProgramData/ELF/authority/account bindings. Current observer proves byte matches, not policy/provenance or launch readiness. Full quote/supply hashes remain required; do not adopt historical hash exceptions.

Acceptance: reconstruct exact production-ID v0 bytes through `createLaunchMainnet(..., PRODUCTION_PROGRAMS)` and ordered account/ALT privileges. Fail closed on wrong genesis, stale/lagged/divergent snapshots, paused creation, grant expiry/quota exhaustion, config/authority drift and all unsupported fields. Exercise source-independent vectors and the existing message/observer/plain tests. Keep public POST and `submitPlainTransaction` unconditionally refusing; offline success does not expose a wallet prompt. Production RPC credentials or DB observation writes need separate operator authorization.

### S4 — Complete creation economics and exact review, still without execution

Owners: economics/SDK + consumer UI. Use the F4 requirements and extend existing plain review/postcondition owners; do not import `spikes/hook-playground/model.mjs` into a quote or intent builder. UI owner is `app/components/hooklab-plain-preparation.jsx`, not the educational inspector.

Acceptance: decoded exact message review shows supply/allocation, raw/display units, both pause states, recipient/authority identities, grant consumption and exclusive expiry, creation deadline, all signers, separate creator and outer-payer cashflows, review/blockhash expiry. Simulation uses retained unsigned bytes with `replaceRecentBlockhash: false`; re-observation on any drift invalidates review. Official vectors plus independently derived expectations must agree; synthetic responses alone are insufficient for adoption. No production quote/sign button is enabled.

### S5 — Design and validate custody, authorization and recovery before signing

Owners: security + wallet + recovery. Owner must first choose mint custody (Q2). Reuse wire/signature checks, `src/hooklab-plain-journal.mjs`, `hooklab-plain-receipts.mjs`, production account routes and existing same-origin/session patterns. Do not reuse `/api/bind` payout authorization or the recipe vault as a production signing contract. Current journal only retains fully signed transactions; external partial-signature retention is an explicit missing feature.

Acceptance: retain one mint and exact message before prompts; prove encrypted backup/independent restore if client custody is chosen, or implement public-identity-bound external partial signatures if external custody is chosen. Bind identity proofs to origin/GitHub session/wallet/operation/full genesis/profile/message; atomically consume single-use challenges. Test replay, cross-user access, signature order/identity mismatch, altered bytes, rejection/disconnect, partial signer loss, storage/DB failure, expiry, restart, history pruning and RPC divergence. With separate outer payer, creator + mint + payer are three signers. Never sign-and-send automatically, refresh blockhash automatically, delete unresolved records, retry with a new mint or treat an absent receipt as non-submission.

Recovery keeps original signed bytes/signature and first-finalized raw evidence, and is readable independently of wallet connection or grant expiry. Current poststate reads are later finalized state, not historical state; producer retained ordered post-operation evidence is required to accept a past operation after drift/re-pause. A finalized transaction alone is not verified economic postconditions.

### S6 — Separately authorize observation rollout, then a bounded creation canary

Owners: operations + security + explicit owner approval. Inspect all pending migrations, not just `0081_hook_lab_plain_recovery.sql` and `0082_hook_lab_plain_authorization.sql`; current web deployment can run migrations. Require encrypted backup/decrypt/disposable restore, target-specific schema approval, journal permissions and an approved deployment revision. Do not execute a deploy command from this plan.

First stage may enable **read-only** account recovery/monitoring after its own rollout approval; these flags cannot activate execution. Wire alert delivery/acknowledgement, RPC lag/config/ELF drift, aged unresolved signatures, journal health and named on-call/pause ownership. The current monitor is not scheduled and alert transport is absent.

Only a later separately reviewed change may replace the hard execution refusal. It requires adopted deployment/economics, approved creator/mint/metadata, lifetime grant cap and exclusive expiry, exact budgets, creation deadline, creation unpause, wallet acceptance and an explicitly approved creation attempt. Trading may remain paused. Minimum producer blocker: a deployment-bound creation acceptance fixture with raw message, signer roles, simulation/account snapshots, finalized receipt, fee/rent/debit and counter postconditions. The existing paused-only package is not that evidence; if the first receipt must be generated, that is a separately approved protocol acceptance operation, not an action for the Playground.

Rollback: disable new work and preserve reconciliation/journals. A web rollback cannot undo token creation or pause a program. Authority pause/revoke actions and shared DB restore each need separate approval; never restore stale database state over accepted chain activity. Trading pause also blocks LP withdrawal, so do not promise emergency withdrawal.

## Concrete blockers and decisions

| ID | Blocker / decision | Required deliverable / owner | Blocks |
| --- | --- | --- | --- |
| Q1 | Publication/integration scope | Owner chooses a standalone simulation release (recommended first) or later metadata-only app integration. Default without approval: keep the current Portal isolated; no route, push or deployment change. | External S1 release / S2 integration |
| Q2 | Mint custody | Owner/security chooses retained external signer or separately approved client-generated encrypted custody. Prefer external custody for the first bounded creation if a retained signer is confirmed; otherwise require a separately reviewed client-vault/restore design. Default: no key generation or signature prompt. | S5 implementation and execution |
| B1 | No adopted production trust root | Protocol/security provides reviewed frozen provenance/dependency package and finalized dual-provider bindings plus decoded policy semantics. | Live S3–S6 |
| B2 | No accepted production economics/creation fixture | Protocol/economics provides raw creation acceptance vectors, exact rent/fees and reviewed configuration. Historical devnet receipt and synthetic fixtures do not substitute. | S4 adoption / S6 activation |
| B3 | Missing production custody/wallet acceptance | Security/wallet completes identity proof exposure review, partial signatures, backup/restore and same-mint recovery acceptance. | S5–S6 |
| B4 | No rollout/operations authorization | Owner/ops selects target, all pending migrations, backup/restore evidence, monitoring destinations/on-call and independent pause procedure. | Shared deployment / DB changes |
| B5 | Lifecycle SDK mismatch | Protocol must deliver explicit production-ID swap/graduate/liquidity/fee builders and receipts before any later lifecycle feature. Generic helpers retain default/devnet derivations. | Trading, graduation action, liquidity and claims; not metadata-only drafting |

## Verification commands for the future implementation

Run only local/disposable checks until separately authorized. These are an acceptance checklist, not claims that the planned integration exists:

```sh
# Standalone simulator (from spikes/hook-playground)
npm test
npm run test:browser

# Consumer authoring and inactive security boundaries (from repository root)
node --test tests/hook-lab-templates.test.mjs tests/hook-lab-recipe.test.mjs \
  tests/hooklab-message-boundary.test.mjs tests/hooklab-production-observer.test.mjs \
  tests/hooklab-plain.test.mjs

# DB tests only with a verified disposable local PostgreSQL instance
node --test tests/hook-lab-recipe-db.test.mjs tests/hooklab-plain-journal-db.test.mjs

# Before approving a cross-app integration, run existing broader checks
node scripts/ci/run-quick-tests.mjs
node scripts/ci/run-tests.mjs
npm run build
```

Add browser acceptance for beginner/expert separation, mobile and keyboard navigation, unchanged simulation/rich drafts, explicit handoff cancellation, disconnected/wrong-wallet states, stale reviews and disabled actions. Use ephemeral test identities with signing methods that throw until the dedicated signing work is authorized. CI success is software evidence, not protocol/deployment acceptance. Recheck any optional upstream test skips rather than reporting skipped conformance as passed.

## Evidence and unresolved risk

- Local source contracts: [production consumer](../../docs/HOOK_LAB_PRODUCTION_CONSUMER.md), [plain adapter](../../src/hooklab-plain.mjs), [production public route](../../app/api/hook-lab/production/route.js), [message boundary](../../src/hooklab-message-boundary.mjs), [receipt verifier](../../src/hooklab-plain-receipts.mjs), [journal](../../src/hooklab-plain-journal.mjs), [production wallet UI](../../app/components/hooklab-plain-preparation.jsx).
- Pinned upstream ABI: [production builder, explicit IDs and prohibited options](https://github.com/new1direction/hook-lab/blob/f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32/sdk/packages/sdk/src/mainnet-controls.ts#L25-L112); [runtime plain restrictions](https://github.com/new1direction/hook-lab/blob/f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32/programs/bordrless_launch/src/lib.rs#L80-L110).
- Economics: [integer allocation derivations](https://github.com/new1direction/hook-lab/blob/f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32/crates/bordrless-core/src/lib.rs#L598-L634); [fee routing](https://github.com/new1direction/hook-lab/blob/f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32/crates/bordrless-core/src/lib.rs#L362-L444); [sniper behavior](https://github.com/new1direction/hook-lab/blob/f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32/programs/bordrless_launch/src/instructions/hooks.rs#L126-L157).
- Authority and SDK limitations: [production profile](https://github.com/new1direction/hook-lab/blob/f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32/deployments/production/profile.json#L39-L62); [production README](https://github.com/new1direction/hook-lab/blob/f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32/deployments/production/README.md#L44-L64).
- **R1:** pins/contracts may change before integration. Earliest signal: manifest/source/profile/IDL differences. Stop and regenerate the mapping and acceptance vectors; do not auto-refresh pins.
- **R2:** source controls may differ from deployed controls. Earliest signal: provider/dependency/config/authority mismatch or absent dossier. Fail closed; preserve existing recovery.
- **R3:** “protocol LP” can be misread as permanent custody. Earliest signal: copy promises burned LP, immutable lock or withdrawal. Reject that copy; source has no transfer route at this pin but retains upgradeability.

Out of scope: implementation in production modules, pushing, deployment, shared migrations, mainnet reads, real wallets/keys, transaction submission, token deployment, arbitrary Hooks, post-graduation trading, or a claim that this simulation predicts production outcomes. Exact host, approved creator/budgets, live economics, deployment evidence, and custody design remain unspecified until the listed owners supply them.
