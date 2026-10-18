# Hook Lab production handoff: retain E73/B2, no execution approval

## Decision boundary

Local browser acceptance passed on 2026-10-18 against the rebuilt programs,
a fresh disposable database/validator and the existing synthetic wallet roles.
This does **not** authorize production signing, funding, broadcasting,
deployment, merging, upgrades or unpausing. None was performed. The owner
performs final signing and live acceptance locally.

The local 100 bps creator fee and 200 bps wallet cap are test inputs only.
Production rate, cap and recipients remain unapproved. Preserve the implemented
model: each swap pays `floor(gross creator fee / 4)` to repo.ing and the
remainder to the creator; no additional platform surcharge.

## Source and artifact baseline

- App baseline: `New1Direction/repo.ing` PR #304,
  `d3eb0df2701be2b77e624d60750b99bc8bb23ebe`.
- Protocol baseline: `New1Direction/hook-lab` PR #5,
  `134e16de1aadeac921bb314284fd3fd181c86097`.
- Protocol source was not modified. Existing commit patches were not reapplied.
- Original `Gitfun` repository and unrelated payout work were not modified.
- Actual build: Agave 4.3.0, platform-tools 1.57, SBF v3, Rust 1.97.1.

The supplied protocol candidate tree
`3e25d73f3dd82c56e0d7456790ea88f64fdc0e01` is the PR #5 tree.
The vendor build manifest's historical `sourceCommit = a33957…` and
`runtimeSourcePatchSha256 = fa2e2a5c…` describe its earlier baseline/patch
provenance; they are not an assertion that `a33957…` equals `134e16…`.
The actual rebuilt ELF lengths and hashes below match the accepted pins.

| Artifact | ELF bytes | SHA-256 |
| --- | ---: | --- |
| Launch | 759,976 | `d4193f3634e68fb50c4bbfddc9ac2fc2e60f0ed2e1c6847c8a1580420875e9bb` |
| Swap | 554,808 | `3d5e1abee7fa2ff5f8d9a2b6c691b80849c75b298b4156f81d545dfa5f1caeaa` |
| Max-wallet gate | 188,960 | `d7233dd0fd23f58f2d1efec1543017395684f43827155e8b884a624c62493857` |
| External native token dependency | 326,504 | `7aa07deb41a5545bcaff0d3fb966d5344538ec8f5c9f2155db4de030e3255df1` |

The external token ELF was recovered and byte-pinned; its reproducible source
provenance remains unresolved. Do not treat a matching ELF hash as a source
audit or deploy a replacement token program as part of this checklist.

The public gate IDL is included in source at
`vendor/hooklab-event-abi/inclusive-max-wallet-candidate/hook_max_wallet.json`,
SHA-256 `fbcab6e26d3439c0b0afc3fb43a3afbab6c091ad11ba83cbfbefc11fab412b43`.
Its narrow ignore exception does not exempt wallet/keypair files.

## Existing public custody references — no keys exported

Base directory: `~/Library/Application Support/Hook Lab Custody/`.
The references below identify **public manifests and role entries**, not
unencrypted signing files. For every set, the Keychain service recorded in
its public manifest is `com.hook-lab.custody.<setID>`. Primary/recovery
manifests exist locally; same-Mac recovery is not independent backup proof.
No Keychain secret or encrypted wallet payload was opened/exported.

| Existing role | Public address | Public manifest reference relative to base |
| --- | --- | --- |
| Owner/admin | `DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5` | `custody-da8970c2-1b18-4dc7-a4bc-9f096e42d5cc/public-handoff/manifest.public.json`, `owner-admin` |
| Guardian/pause | `CT4SioSvVFHcnuJbJMfcVgdR3GHAyK7VmrjvR6y3RmEY` | Same manifest, `backup-pause` |
| Treasury/collector | `FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i` | Same manifest, `treasury` |
| Production upgrade authority | `9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md` | `production-upgrade-authority-v1/material/primary/manifest.public.json`, `production-upgrade-authority` |
| Operational payer | `3eCFwDiKetHe9pg1zNEkTohUECu2vtsZDRMZ3jeR4g5o` | `mainnet-canary-v1/material/primary/manifest.public.json`, `operational-payer` |
| Existing launch program signer | `E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft` | Same manifest, `launch-program` |
| Existing swap program signer | `B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk` | Same manifest, `swap-program` |
| Existing canary mint | `6qiwnQnLCUrSB5Z4GsY4JPJeSVT45bRwEavM8dY6nphK` | Same manifest, `single-canary-mint` |
| Separate agent test wallet | `DrAhCGXsHLNdJ9ihhRBkyKZSzY446qKg1Dcx6zEm9dmi` | `agent-test-wallet-v1/material/primary/manifest.public.json`, `test-wallet` |
| Controlled-test creator | `DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9` | `controlled-test-identities-v1/material/primary/manifest.public.json`, `dedicated-creator` |
| Controlled-test separate mint | `2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn` | Same manifest, `separate-mint` |

These dated manifests are custody references, not current approval certificates.
The refreshed live config/governance accounts assign the first three roles
to these same addresses, despite their older manifests saying "candidate".
That on-chain assignment is not approval of new economics or production
actions. No production wallet was created or role silently reassigned.

Local synthetic roles are separate and retained in the accepted state's
`local-chain.public.json`: wallet/creator
`7bbSzsD53WF77RDRseuw9DmPeUtNeDojiqKMu4dW2msf`, admin
`EPBZdCwHibqS3J3F18MqyEUb4fEtV9tfkSnpeZz1oyGB`, upgrade
`E329RvBeX2SEHhsXrjLz7NWZiJTYiZqb8v9fpLeqsFLi`, guardian
`2XHSoLGvYVTD3hXbFmVDWRzNgi3CX7UKD2uSfbBBHtMi`, collector
`9Wo1cx758K8iMsTVSz5CUimpQ7Z2UZB8Vi6NUJKNEWo7`.
Their public deterministic test identities must never be used for production.

## Read-only retained-state assessment

RPC: `https://api.mainnet-beta.solana.com`; verified mainnet genesis
`5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`.
Finalized headers were refreshed at slot 458,273,954. Config/governance
decoding used slot 458,275,222; owner-account inventories used slots
458,276,220–221. These are read-only observations from one provider, not
the two-independent-provider production dossier still required.

| Object | Observed state |
| --- | --- |
| Launch `E73c…rCKft` | Executable; ProgramData `FHSVsk3nonaqAeFtgu56BFU9hg9KugxbHLoGkAAxgfyp`, 709,509 bytes, 3,604,955,960 lamports |
| Swap `B2cr…pZJwk` | Executable; ProgramData `GuyHY9x78h52RX87RQ2nD8xnzr2dArnx5XDBz3HsJf7d`, 528,829 bytes, 2,687,101,560 lamports |
| Both upgrade authorities | `Some(9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md)` |
| Candidate gate `BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb` | Absent; its existing program-signer custody reference has not been identified |
| Operational payer | 1,175,000 lamports |
| Upgrade authority wallet | 902,231 lamports; the proposed payer remains the separate operational payer |
| Existing buffers under `9GCf…EN1md` | None in the finalized Loader V3 authority-filtered inventory |

**Retained-ID upgrades are supported by the loader.** Launch and swap do not
need new program identities or their program-identity keys to upgrade.
The current accepted ELFs require exact ProgramData extensions of 50,512 and
26,024 bytes. Both exceed the 10,240-byte minimum; Agave 4.3.0 does not round
an already-above-minimum extension to another 10 KiB multiple.

The accepted inclusive IDLs decode the existing 250-byte launch Config,
189-byte swap Config and both 348-byte governance accounts. Both config
pauses remain true, governance revisions are zero, and no admin transfer is
pending. The complete owner-account inventory at those slots contains only
Config and Governance for each program: no Launch, Pool or creator-grant
accounts were returned. This is observed layout compatibility, not a blanket
claim about every future market or a production upgrade rehearsal.

Code upgrades alone cannot enable the inclusive fee model:

| Live setting | Current | Required before an approved inclusive launch |
| --- | ---: | --- |
| Launch `max_creator_fee_bps` | 0 | Cover the owner-approved creator rate |
| Launch `rule_bounds.max_rules_fee_bps` | 0 | Cover the approved combined fee bound; the reviewed path still uses no rules |
| Swap `launch_protocol_share_bps` | 0 | 2,500: a quarter of gross creator fees, not an extra charge |
| Swap flat protocol fee, launch LP/sniper fees | 0 | Preserve zero for this fee model |
| Production wallet cap and recipients | Not approved for this release | Explicit owner selection; do not copy local 200 bps/test recipients |

Governed config updates change config digests/revisions and need their own
approved messages. Preserve existing roles and pauses while preparing them.
Gate deployment/read-back/irreversible finalization, creator authorization,
production ALT provisioning, funded quote access and any opening of gates
remain separate owner-controlled actions.

The gate is mandatory, not an optional fallback. Retaining E73/B2 does not
remove that dependency. Do not generate a gate key or replace `BdAa…` with
another identity. If the owner cannot identify its existing signer, stop
for explicit identity approval; a changed ID requires rebuild and acceptance.

## Exact conditional program-code/gate budget

**Recommended proposal:** retain E73/B2 and the existing payer/authority.
Use temporary Loader V3 buffers created with
`SystemProgram.createAccountWithSeed`, with the existing operational payer
as both payer and base, and `9GCf…EN1md` as buffer authority. These are loader
accounts, not new wallets or program identities; no buffer keypair is needed.
Only public addresses were derived/read and unsigned messages fee-quoted.
No account was created and no production signature or broadcast occurred.

The non-secret address labels and resulting absent buffer accounts are:

| Role | System address seed | Derived buffer address | Allocated bytes | Temporary deposit, lamports |
| --- | --- | --- | ---: | ---: |
| Launch | `hl-l-d4193f36` | `EPRbypMo4tSMCrFzYFqkBXh92bAHyKuFzC23LME1PvDJ` | 760,013 | 3,861,516,280 |
| Swap | `hl-s-3d5e1abe` | `HRHsqwCZQAreKfPjK4zjzDV4QTuBaC7HWyGuUjnwjqdo` | 554,845 | 2,819,262,840 |
| Gate | `hl-g-d7233dd0` | `5vu1QCSuXqLqdht9BDy7e4YWPBBL2aHAGrAJj9qkaEi6` | 188,997 | 960,755,000 |

Create and initialize each buffer atomically. For retained programs, include
its extension in that same initial transaction. Upload the exact ELF once,
then upgrade with the spill recipient set to the same operational payer.
For the absent gate, the separate Program account creation/deploy still
requires its existing identity signer; finalization is a separate approval.
This is an owner-review proposal, not an implemented production signing
tool or a rehearsed/executable production packet.

Finalized rent quotes fit `R(n) = 650240 + 5080 * n` lamports. Buffer metadata
is 37 bytes, ProgramData metadata 45 bytes, and a Program account 36 bytes.
Unsigned fee quotes at slots 458,276,216–218 confirmed these message costs:

| Proposed message | Required signatures | Wire bytes with reserved signature slots | Base fee, lamports |
| --- | ---: | ---: | ---: |
| Seeded launch/swap buffer create + initialize + extend | 1 | 460 | 5,000 |
| Seeded gate buffer create + initialize | 1 | 381 | 5,000 |
| Loader write, 916 payload bytes | 2 | 1,232 | 10,000 |
| Retained-program upgrade | 2 | 436 | 10,000 |
| Gate Program creation + initial deployment | 3 | 598 | 15,000 |
| Gate immutable finalization | 2 | 303 | 10,000 |

These are **unsigned size/fee measurements**, not production signatures or
simulation/execution success. The 916-byte write has a 1,103-byte message;
two reserved 64-byte signatures plus their count make 1,232 bytes.
A 917-byte payload measures 1,233 and is not allowed.

Omit the compute-unit-price instruction entirely. Even specifying zero
changes the CLI instruction/chunk geometry. The actual accepted ELF files
require 830 / 606 / 207 writes at 916 bytes; none of their chunks is all zero.
Count every write once, with no failed/re-signed attempts, priority fees,
other authority changes or on-chain IDL publication.

| Operation | Added permanent rent, lamports | Base network fees, lamports | Remaining component cost, lamports |
| --- | ---: | ---: | ---: |
| Launch extension + retained-ID upgrade | 256,600,960 | 8,315,000 | 264,915,960 |
| Swap extension + retained-ID upgrade | 132,201,920 | 6,075,000 | 138,276,920 |
| Gate deployment + separately approved immutable finalization | 961,628,760 | 2,100,000 | 963,728,760 |
| **Total** | **1,350,431,640** | **16,490,000** | **1,366,921,640** |

The exact conditional program-code/gate component is **1.366921640 SOL**.
It excludes the separately unapproved operations below; it is not an all-in
production spending cap.

### Peak funding and reclaimable rent

Use **launch -> spill back to payer -> swap -> spill back to payer -> gate**,
with execution gates/config pauses unchanged. Launch-first minimizes this
sequential schedule's peak; doing swap first leaves its spent rent/fees
unavailable when funding the larger launch buffer.

Before the launch spill, the payer must cover its 3,861,516,280 buffer
deposit, 256,600,960 extension and 8,315,000 stage fees: 4,126,432,240
lamports. Add a proposed retained payer reserve of 650,240 lamports:

| Funding measure | Lamports | SOL |
| --- | ---: | ---: |
| Peak payer balance including proposed reserve | 4,127,082,480 | 4.127082480 |
| Observed payer balance | 1,175,000 | 0.001175000 |
| Conditional payer funding shortfall | 4,125,907,480 | 4.125907480 |
| Cumulative upgrade-buffer deposits returned to the payer | 6,680,779,120 | 6.680779120 |
| Payer balance left after this component if funded to that peak | 2,760,160,840 | 2.760160840 |

The two buffer refunds are **recycled sequential credits**, not an extra
return to add to the final payer balance. Each ProgramData is already
rent-funded after extension; Loader V3 spills the whole corresponding
buffer deposit to the payer on upgrade. Gate buffer funding is recycled
into new permanent ProgramData rent, not a net reclaimable gate refund.
Existing E73/B2 program rent remains in place, not refunded. The immutable
gate's rent cannot later be reclaimed through an upgrade-authority close.
No funding, refund or return transfer was performed.

### Reconciliation with 7.660660400 SOL

The earlier number assumed **three fresh initial deployments**. It was not
the cost of retaining E73/B2, which already exist. It also counted only 829
launch writes; direct ELF chunk measurement requires 830, adding 10,000
lamports. The corrected same-length fresh benchmark is **7.660670400 SOL**
(7,644,155,400 permanent rent + 16,515,000 base fees).

Stock CLI retained-ID staging, with approved existing buffer identity
signers, would cost **1.366936640 SOL** and need a proposed peak payer balance
of **4.127128120 SOL** including the same reserve. CLI funds Buffer accounts
at the larger ProgramData rent, and each initial transaction has two
signatures. Its auto-extension is included in that transaction, not an
extra extension transaction. Do not use its default ephemeral signer
generation without approval. The seeded proposal avoids those new keys
and saves 15,000 lamports in initial-message fees.

The fresh benchmark is not an executable alternative: these binaries declare
the existing E73/B2 addresses. Different program identities would need
explicit approval, rebuilding, new pins and renewed acceptance. None was
generated.

### Costs and inputs not silently treated as zero

A final all-in production cap remains blocked on the owner-selected action
list and inputs: governed economics/config proposals, creator grants,
production ALT setup, quote funding/bridge access and liquidity, owner live
launch/buy/sell/collection amounts and rents, funding/return transfers,
priority fees and failed/re-signed-attempt allowance, independent custody
recovery proof and optional on-chain IDL publication.

The existing zero-fee config is not compatible with the accepted inclusive
100-bps test profile. Do not price that test rate into production approval,
silently reuse local recipients/cap, or pretend code upgrades include the
required migration. Quote the exact unsigned additional action list after
the owner selects production economics and quote access, then obtain an
all-in approval before any signing. Recheck balances, buffers, rent, fees,
authority and blockhashes immediately before that approval.

## Owner approval checklist — one canonical list

- [x] Read supplied source archives and setup instructions; retain exact PR baselines.
- [x] Rebuild launch/swap/gate and verify real on-validator ELF bytes.
- [x] Complete one fresh local browser launch, buy, sell and fee collection.
- [x] Verify packet limit, ALT activation, cap enforcement, rejection, natural
  expiry and same-signature lost-response recovery without duplicate send.
- [x] Retain the earlier expired partial operation and its old DB/ledger.
- [x] Include the public gate IDL; retain secret/keypair ignores.
- [x] Production build with public test-wallet flag set: no synthetic wallet
  choice in the real production browser; local operations returned 404 with
  local flag off and 409 with all local flags on; no signing row was created.
- [x] Direct production guards rejected the otherwise-valid local profile;
  synthetic adapter was absent and local-off genesis stayed mainnet.
- [ ] Supply the original non-secret seven-fixture pack or exact historical
  replay/export inputs; restore authenticity pins and rerun the 17 affected
  regression entries. The current regression gate is not green.
- [ ] Review the frozen source commit and the known local wallet-switch UI
  race below; explicitly authorize a separate fix if wanted. No source fix
  or feature was added after the freeze.
- [ ] Approve retained E73/B2 upgrades and seeded buffer staging using existing
  payer `3eCF…4g5o` / authority `9GCf…EN1md`; do not create new wallet keys.
- [ ] Identify the existing signer custody reference for gate `BdAa…Kfxb`
  and approve its deployment/read-back. Separately approve irreversible
  finalization only after verifying actual deployed bytes; no automatic final.
- [ ] Approve production creator rate, wallet cap, creator/collector recipients,
  quote asset/access and governed config changes while preserving existing
  admin/guardian/treasury/upgrade roles and closed execution.
- [ ] Resolve external token-source provenance, funded production quote/bridge
  assumptions and independent recovery proof. Same-Mac copies alone are
  insufficient; no replacement token program is authorized.
- [ ] Rehearse the exact retained-ID/seeded-buffer unsigned packet on separate
  disposable state. Do not restart or reset the accepted local environment.
- [ ] Obtain two genuinely independent production readers and fresh
  genesis/ELF/IDL/config/governance/recipient/authority observations, then
  regenerate the production dossier and ALT pins. Local evidence is not approval.
- [ ] Approve exact unsigned messages, signer roles, expiry/fee bounds, the
  component budget and a separately closed all-in budget/operational reserve.
- [ ] Owner signs and executes locally only after explicit authorization,
  verifies bytes/roles/pauses after each step, and separately authorizes
  bounded live tests and any later activation, merge or unpause.

## Verification limits and evidence

Local evidence lives outside source at
`/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/acceptance-2/`, including
`consolidated-acceptance.public.json`, browser screenshots and production-mode
probe results. No production keys are stored there by this work.

`npm run build -- --webpack` completed with exit 0. It reported an unrelated
missing `app/lib/model-pulse.mjs` import from
`app/components/hf/model-pulse-slot.jsx`, plus the existing bigint native
binding fallback. Neither warning was suppressed or represented as fixed.

The broad root Node invocation was not a supported full CI run. The grouped
runner requires distinct pinned database environments and destructive
scratch setup; it was not run against the preserved server. The supplied
source-only inventories explicitly omit historical max-wallet/custom Rust
vectors. Their authentic artifacts, not JS-derived substitutes, are required
for the blocked legacy regression files. Current inclusive generated evidence
is available through `HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR` and
`HOOKLAB_INCLUSIVE_TOKEN_ELF` as described in the local runbook.

The actual Hook Lab regression invocation, after fixing the Node/CommonJS
`BN` import and supplying authentic current inclusive evidence, was:

```sh
env NODE_ENV=development \
  HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR=/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/rebuilt-inclusive/evidence \
  HOOKLAB_INCLUSIVE_TOKEN_ELF=/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/rebuilt-inclusive/elf/bordrless_token.so \
  /usr/bin/sandbox-exec -f scripts/hooks-local-macos.sb \
  node --test --test-concurrency=4 tests/hooklab-*.test.mjs
```

| Observed tests | Passed | Failed on missing authentic fixture files | Skipped |
| ---: | ---: | ---: | ---: |
| 219 | 200 | 17 | 2 |

**This is not a green full regression gate.** The last observed 17 failures
were missing-fixture load errors, not 17 evaluated assertion failures.
The requested restoration/rerun remains blocked; it was not relabeled as
passed or replaced with a narrower test selection.

| Needed authentic artifact | Authenticity requirement |
| --- | --- |
| `hooklab-max-wallet-rust-vector.json` | File SHA-256 `1c7b0bbd26faab7246f0e5c0ef3f58b0f56d93313c4dd368ed9861a1f23a2962` |
| `hooklab-max-wallet-buy-rust-vector.json` | Original executed legacy Rust vector, not the inclusive v2 output |
| `hooklab-max-wallet-sell-rust-vector.json` | Original executed legacy Rust vector, not the inclusive v2 output |
| `buy-app-plan.json` | Original plan paired with that Rust buy vector |
| `sell-app-plan.json` | Original plan paired with that Rust sell vector |
| `hooklab-custom-rust-vector.json` | Identifies original full source-vector SHA-256 `42a557ce9e91e2c092b51b590ebbbee6223a3df6708ec70d20923744a677a523` |
| `hooklab-custom-launch-rust-vector.json` | Pinned source-vector identity `f5820f16ea1a4ab59598f8d85e0c068c7e44492ce81c18acfbb617b5a6d389f2` |

Use `HOOKLAB_GENERATED_FIXTURE_DIR` for the five-file legacy set; its app-plan
aliases resolve to `buy-app-plan.json` / `sell-app-plan.json`. The custom
pair has direct `tests/fixtures/` paths. Keep ELF-bearing generated data out
of the source commit.

Both supplied source-only inventories deliberately exclude these payloads.
They were not found in the inspected workspaces/public artifact caches,
temporary vector files or tracked fixture history. Authenticated GitHub
access works; the inspected consumer CI artifact contains only TAP/timings,
and its workflow uploads reports rather than these vectors. Public API 404s
were not treated as proof of inaccessible repository credentials.

The public eight-account fixture, paused proposal and token ELF already
exist at `hooks-local-state/build-inputs/`. They are not the missing inputs.
The existing legacy builder exporter uses random public fixture keys unless
given its original replay vector; regenerating arbitrary new keys cannot
match the frozen hash. The supplied source lacks the historical custom
and legacy buy/sell export paths needed to reproduce the whole pack.
Provide those non-secret original payloads or exact replay/export inputs,
not keys. No golden-vector fabrication, inclusive substitution or pin change
was made.

The updated late-policy-receipt regression in
`tests/hooklab-native-signing-db.test.mjs` is among the files blocked by the
missing max-wallet fixture; it is not represented as passed. Real local
launch/trade/collection and production isolation have separate exercised
browser/runtime evidence.

## Final freeze checks and review limits

The accepted 50-file integration runtime source was hashed before handoff
work. Its aggregate is
`a1688fd2f3f3af1af358ac050e435886acdad8b2c11ee3dea1f1fa3a8290bd27`.
Only handoff documentation changed after that freeze. No accepted service,
database or ledger was restarted or reset, and no financial flow was replayed.

The final offline guard/sender smoke command passed **8/8**, without touching
accepted state:

```sh
env NODE_ENV=development /usr/bin/sandbox-exec -f scripts/hooks-local-macos.sb \
  node --test tests/hooklab-local-acceptance.test.mjs \
  tests/hooklab-native-transaction-sender.test.mjs
```

This is additional guard evidence, **not** a substitute for the blocked
17 historical regression entries. It covers production/mainnet/origin/DB
refusal, exact synthetic signing/rejection, expired requests, slot/deadline
crossing, failed simulation, lost-response single-send and message identity.

Separate static review found a P2 local-only UI race in
`app/components/hooklab-local-operations.jsx:28`: disconnect/switch while
`wallet-request` awaits a response can recreate a partial operation after
the wallet effect clears it; rendering then dereferences `operation.review`.
The ID/wallet-guarded update is the proposed fix. It was not applied under
the requested runtime freeze. Backend ownership checks remain separate.
Missing persistent route/ALT/finality regression cases and unbounded local
PostgreSQL waits were recorded as coverage/residual limits, not falsely
reported as observed failing assertions.

Nine local review lenses completed. The independent Claude CLI pass
requested `claude-opus-5` at high reasoning but timed out with no usable
artifact. Actual serving model/effort and cross-model independence remain
unverified; adversarial coverage is degraded, not green. No production
action or automatic source fix resulted from review.

## Primary references

- [Agave 4.3.0 CLI deployment/chunking implementation](https://github.com/anza-xyz/agave/blob/v4.3.0/cli/src/program.rs)
- [Agave 4.3.0 compute-budget construction](https://github.com/anza-xyz/agave/blob/v4.3.0/cli/src/compute_budget.rs)
- [Agave 4.3.0 loader Buffer drain and deploy/upgrade semantics](https://github.com/anza-xyz/agave/blob/v4.3.0/programs/bpf_loader/src/lib.rs)
- [Loader V3 state sizes](https://docs.rs/crate/solana-loader-v3-interface/7.0.0/source/src/state.rs)
- [Solana rent-exemption RPC](https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption)
- [Solana unsigned message-fee RPC](https://solana.com/docs/rpc/http/getfeeformessage)
