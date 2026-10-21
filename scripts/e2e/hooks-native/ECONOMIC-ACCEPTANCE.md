# Economic selected-hook candidate (not reviewed release evidence)

`selected-hook` remains the historical receipt/tester regression. The separate
`economic-hook` mode runs `tests/e2e/hooks-native/economic-hook.e2e.ts` without the
manual registry helper or model2 curve/native-trade expectation helpers.

## Build-owner handoff

Do not run with the old receipt launch/swap builds. Supply
`HOOKS_E2E_ECONOMIC_INVENTORY=/absolute/path/to/inventory.json`, then:

```
HOOKS_E2E_MODES=economic-hook HOOKS_E2E_KEEP=1 \
  node scripts/e2e/hooks-native-stack.mjs test
```

The inventory schema is exported by `economic-fixture.mjs`. Shape:

```
{
  "schema": "repoing/local-economic-candidate/1",
  "sourceCommit": "<40 lowercase hex supplied by build owner>",
  "pins": {
    "launch": ["target/creator-selected-v1-candidate/bordrless_launch.so", "<full ELF sha256>"],
    "swap": ["target/creator-selected-v1-candidate/bordrless_swap.so", "<full ELF sha256>"],
    "token": ["target/creator-selected-v1-candidate/bordrless_token.so", "<full ELF sha256>"],
    "gate": ["target/creator-selected-v1-candidate/hook_max_wallet.so", "<full ELF sha256>"],
    "selected": ["target/creator-selected-v1-candidate/tax_hook.so", "<full ELF sha256>"],
    "alternate": ["target/creator-selected-v1-candidate/transfer_receipt_hook.so", "<full ELF sha256>"]
  },
  "idls": {
    "launch": ["target/creator-selected-v1-candidate/bordrless_launch.json", "<candidate IDL sha256>"],
    "swap": ["target/creator-selected-v1-candidate/bordrless_swap.json", "<candidate IDL sha256>"],
    "gate": ["target/creator-selected-v1-candidate/hook_max_wallet.json", "<candidate IDL sha256>"]
  },
  "hooks": [
    {"role":"selected","program":"8KoeKiwydKzdH65uD4Z6uJgR9uKnj2w22HXRSdCXGhF2","flags":65,"name":"Economic transfer tax"},
    {"role":"alternate","program":"4P9UnqR2FgD1XjkcpyWzabQCrhPDTQkZy8631jvTnYqL","flags":3,"name":"Transfer receipt (no economic fee)"}
  ]
}
```

All paths are relative to `/Users/clubpenguin/Projects/hook-lab-custom-hook-repair`;
only public ELF bytes and independent IDLs/IDs are read. No keypair files are read.
Each ELF and candidate IDL is hash checked before starting the validator. Economic
mode never falls back to historical IDLs; those remain unchanged for historical
selected-hook regression. Generate launch/swap IDLs with the exact candidate
features. The unchanged gate IDL can be copied to the candidate directory and pinned.
`sourceCommit` records the checkout base, not proof that a dirty candidate equals
that commit. Retain build logs and source diffs separately; this inventory alone
is not clean-source or release provenance. Both selected programs
are seeded as genuinely immutable loader accounts, not Some(SystemProgram).
Tax flags are **65**, BEFORE_TRANSFER | TRANSFER_RETURNS_DELTA, not receipt flags 3.
Contract builds and any copying of verified outputs belong to the Rust/build owner.

## Reconciled local prerequisites (2026-10-21)

Candidate ELF inventory and additive launch/swap IDLs are available and hash
checked. Tester remains excluded and cannot substitute for the second catalogue
hook. Economic execution uses fresh disposable stacks with this inventory and
candidate IDLs, not historical selected-hook artifacts.

Implemented local acceptance wiring:

1. `stack.mjs` wraps the freshly collected economic own-stack bundle with
   `localEconomicPolicyBundle` **before hashing/writing it**, including on
   recollection. This binds release2 policy to the actual local profile/dossier;
   it does not fabricate a production dossier or independent trust domains.
   Economic mode no longer supplies `HOOK_LOCAL_SELECTED_HOOK_PIN_JSON`.
   Historical selected-hook mode keeps its singleton fixture behavior.
2. Local `selectedHookSettings` accepts that bound policy, rejects mixed
   policy/singleton inputs and retains the release in runtime config without
   adding a null singleton. `productionSettings().launchLimits()` supplies
   explicit setup limits: 1,400,000 CU, 20,000,000 lamports rent plus the bounded
   network fee, with the same freshly collected timing as preparation/launch.
   The existing runtime journals these setup limits; no runtime edits were made.
3. `validateLocalSelectedHookPolicy` validates the genuine local dossier,
   binding hashes, stable config-counter pins and labelled loopback endpoints.
   Compatibility observation accepts the shared `single-local-validator` trust
   domain only under the explicit development/loopback/nonmainnet acceptance
   boundary. Evidence retains `topology: single-local-validator-two-proxies`.
   Account agreement, executable/authority checks and retained identity remain
   mandatory. Outside that boundary, two distinct trust domains remain required.

The local release's `acceptanceSha256` and `releaseVerificationSha256` are hashes
of the explicit sentinels `LOCAL-UNMEASURED-ECONOMIC-CANDIDATE-NOT-ACCEPTANCE` and
`LOCAL-UNVERIFIED-ECONOMIC-CANDIDATE-NOT-RELEASE`, respectively. They are NOT
passing report hashes, owner consent, release evidence or production approval.

The launch collector now routes explicitly local release2 dossiers through
`validateLocalSelectedHookPolicy` while retaining ordinary operator and
production release validation. The two-proxy topology remains honestly recorded;
no fake second trust domain is introduced.

Production V2 enablement blocker and signing guards remain unchanged. This mode
alone does not solve those dependencies and must not be called passing acceptance.

## Observed execution and supplemental-table validation

The initial local economic browser run finalized hook setup and preparation, then
failed while waiting for launch review: **1 passed, 1 failed, 3 skipped**. Exact
launch compilation refused a **1,298-byte transaction**, exceeding Solana's
1,232-byte packet limit by 66 bytes, with a 48-byte URI, 22-byte name and 5-byte
symbol. The atomic collector-holding instruction is included. The existing
shared lookup table admits only its exact frozen constant-address inventory.
Do not weaken that validation or the packet limit, or use artificially tiny
metadata as acceptance. This was the reproduced failure before the
supplemental-table change, not the current execution result.

The supplemental-table implementation now keeps the shared inventory unchanged.
Hook setup creates, extends and permanently freezes a separate creator-funded
table in the exact approved transaction. Review discloses its observed rent,
inclusion in maximum wallet debit and unreclaimable-rent consequence before
Continue. Finalized setup evidence retains its exact plan; launch checks its
creator/slot-derived address, frozen contents, warm-up and dependencies again.
Mint creation and collector-holding creation remain one atomic launch.

The compiler matrix with maximum UTF-8 name (32 bytes), symbol (10 bytes),
URI (200 bytes), zero/one/two atomic holdings, and one/32 hook extras measured
complete signed-packet sizes of **920–1055 bytes**, all below 1232. Pre-spend
sizing matched actual compilation for all 12 configurations. Unsupported launch
or setup packet sizes fail before issuing approval. Substituted addresses,
contents, ownership, authority and unwarmed tables are rejected. These compiler
tests are not validator execution of every matrix configuration.

A subsequent browser run passed setup/table freeze, preparation, atomic launch
and collector holding, measured taxed buys/sells, reload and server-restart
send-once recovery. It also executed graduation, postgraduate trades and the
creator SOL claim before protocol collection exposed a model1 account-list
mismatch: **3 passed, 1 failed, 1 skipped**. The owner-driver now selects the
observed pool fee model; only model2 requires InclusiveFeePolicy. Its regression
checks passed after reproducing the failure. A fresh stack is required because
the old control process retains the previous owner-driver module.

One fresh-stack attempt failed with RocksDB `No space left on device` during
bootstrap, before browser acceptance. Its unknown finalization correctly stopped
the owner driver without blind resend. Disposable build caches were cleared;
the replacement local validator bounds retained ledger shreds at 10000. Neither
failure is production execution or a model/tool safeguard.

An intermediate rerun timed out after the disposable wallet rejected a sell
signature. An additional CDP inspection client had attached to the suite's
browser during that run; it is not counted as clean acceptance. The final run
used only the suite-owned browser. Screenshot inspection also found rough
estimates competing with measured/exact consent. The new browser assertion
failed on that visible stale summary, then passed after hiding the rough form
while consent is active; no signing or exact-message checks were removed.

The final local economic browser run passed **5/5 tests, zero skipped**, in
691.64 seconds. It verified both immutable exact-ELF catalogue identities,
publication/discovery/configuration, approved setup/table creation and freeze,
preparation, atomic launch/collector holding, measured taxed curve buys/sells,
reload/server-restart send-once recovery, graduation, postgraduation taxed
buys/sells, creator SOL claim, protocol collection and browser executable-assertion
refusal. The setup receipt authenticates the table's observed **5735040-lamport**
rent and frozen state. This observed cost is not a production price constant.
Evidence: `.amp/in/artifacts/v1-supplemental-economic-final.log`.

The reconciled app run recorded **861 passed, 0 failed, 506 skipped**, excluding
`hooklab-owner-local.test.mjs` and `hooklab-owner-stack-local.test.mjs`; local
validator disk exhaustion prevented counting those as verified. A final focused
run covering packet sizing, table/runtime retention, collection, fee rendering
and quote boundaries passed **30/30**, zero skipped. `git diff --check` passed
in both app and Rust working trees. These are scoped checks, not a green claim
for every repository test or release readiness.

The economic browser fixture exercises model1, the 200-bps transfer-tax hook,
zero configured burn/custom SOL cut and zero effective author share. The second
catalogue hook is discovery-only. Other configurations have compiler/contract
coverage but are not implied to have the same browser lifecycle evidence. Two
labelled proxies share one disposable validator; they are not independent trust
domains. Production enablement blockers remain in force. Local commit identities
are bound in the corrected offline review packet; nothing is pushed or deployed,
and no production table was funded or frozen.

## Intended evidence

Browser publishes both declarations; creator discovers both, selects tax,
configures 200 bps/zero cap/collector and separately approves journaled hook-setup,
preparation and launch. The exact launch message creates the collector holding
atomically after mint creation; no out-of-app repair or manual hook registry
initialization occurs. Receipt and collector balance deltas assert tax
ceil rounding, callback invocation and send-once recovery. Bounded app Max buys
drive graduation without the obsolete curve model. Postgraduate trades, creator
claim and platform payout use actual receipts. The alternate is discovery-only,
not economic acceptance. Tampered browser executable assertions must be refused.

Screenshots are requested at publication, creator configuration, each exact
setup/preparation/launch review, exact buy/sell review and pre/postgraduate tax
payout. Runner writes them under `tests/e2e/hooks-native/.e2e/` (see e2e.config.ts).
Inspect real emitted paths with `view_media` before presenting them. Live setup
disclosure has been inspected: the observed table rent and permanent-freeze,
no-close and unreclaimable-rent warnings appear before Continue. Static creator
economics evidence is separate from interactive execution. Measured and exact
trade captures scroll the review region into view; a prequote screenshot must
not be presented as measured evidence. Final live setup, measured buy and exact
sell screenshots were inspected and retained as
`.amp/in/artifacts/supplemental-table-live-setup.png`,
`.amp/in/artifacts/supplemental-economic-measured-quote.png`, and
`.amp/in/artifacts/supplemental-economic-exact-review.png`. Relevant disclosure,
fee, minimum and approval content is readable; the exact-review capture clips
only the following progress card, not the approval content.

## Final creator-language review

The post-copy lifecycle rerun passed **5/5, zero skipped**, in 715.77 seconds
(`.amp/in/artifacts/v1-copy-economic-final.log`). Live default and expanded setup,
launch, catalog, configuration, measured and exact trade screenshots were
inspected. Exact costs, minimums and irreversible effects stay visible while
program identities, hashes and raw diagnostic statuses start collapsed.

A final wording correction after that run replaces the misleading blanket
"No wallet holding limit" with "Wallet limits set by hook"; selected hooks can
impose their own restrictions. No transaction code changed. The final combined
UI/setup/runtime/approval/packet checks passed **92/92, zero skipped**, including
the two regression failures demonstrated before this correction. Offline real
component renders of a configured 500-bps cap and unconfirmed/error status were
also inspected. These static fixtures are not extra validator execution.

The corrected packet is
`.amp/in/artifacts/creator-selected-v1-release-packet/OWNER-REVIEW.md`, with source,
ELF/IDL and evidence hashes in `manifest.json` and `SHA256SUMS`. It is **NOT
SIGNABLE**. In particular, the tested local token ELF differs from the historical
deployed-token dependency; no token upgrade is approved and no production-parity
claim follows from these local runs. Historical receipt-only budgets remain
withdrawn. The new packet does not fabricate production fees or owner approval.
