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

## Consolidated owner approval sheet — NO-GO, no spending authorized

This is the single approval sheet for retaining the existing E73/B2 program
identities and deploying the already-pinned BdAa gate. It is not an execution
packet or permission to fund anything. **Authorized spend now: 0 SOL.**
Local browser acceptance and production-isolation evidence remain valid;
the historical-fixture blocker is resolved by the 475/475 rerun below.

### Decisions required before an executable plan

| Approval field | Verified fact / proposed use | Current decision |
| --- | --- | --- |
| Retained launch/swap IDs | E73/B2 and their existing `9GCf…EN1md` upgrade authority, not new program IDs | Owner approval pending |
| Upgrade authority custody | `production-upgrade-authority-v1/material/primary/manifest.public.json`, role `production-upgrade-authority` | Public reference found; owner must verify usable custody and independent recovery |
| Payer and buffer base | Existing `3eCF…4g5o`, `mainnet-canary-v1/material/primary/manifest.public.json`, role `operational-payer`; seeded buffers from the budget table | Owner approval pending; funding source and refund destination must also be selected from existing roles |
| Gate program signer | Existing address `BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb` | **BLOCKED:** no matching signer role found in the 11 existing public custody manifests inspected; provide its public manifest path/role only, never keys |
| Gate finalization | Read back exact ELF, then separately approve irreversible removal of upgrade authority | Not approved; never finalize automatically |
| Gross creator fee rate | Explicit production basis-point value, covered by launch fee bounds | **Not selected.** Local 100 bps is not a production recommendation |
| Wallet cap | Explicit production basis-point cap in the pinned v2 policy | **Not selected.** Local 200 bps is not approved |
| Platform split / surcharge | `platform = floor(gross / 4)`, `creator = gross - platform`, per swap; swap share 2,500 bps; no flat/sniper/LP/rules surcharge | Required unchanged contract; no extra platform surcharge |
| Production recipients | Existing treasury `FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i` is the existing collector-role candidate, not an approved new destination | Approve exact creator and collector public keys and derived quote receiving accounts; do not promote controlled-test/synthetic identities by default |
| Admin / guardian / treasury | Retain `DVdd…Tj8S5` / `CT4S…RmEY` / `FhEw…sW3i` and their public custody references above | No role rotation or new production wallets proposed |
| Quote and live acceptance | Existing token/quote program, funded access/bridge, liquidity, exact bounded launch/buy/sell/collection amounts and native/quote rents | **Not selected/priced;** recovered token ELF source provenance unresolved |
| Funding and failure policy | Select existing funding/return roles, reserve, priority-fee bound, failed/re-signed-attempt allowance and whether on-chain IDL publication is excluded | **Not selected;** no implicit retry, additional transfer or priority fee authorized |
| Release evidence | Two independent fresh production readers, custody recovery proof, exact unsigned packet/expiry bounds and disposable-state rehearsal | Incomplete; dated single-reader observations are not current authorization |

No new program identity may be generated to work around the missing gate
signer. If its existing custody cannot be identified, stop for a separate
identity decision; rebuilding and renewed acceptance would then be required.
No production key, encrypted wallet payload or Keychain secret was opened.

### Exact action order, after the approval fields and all-in quote close

The sequence below fixes the instruction-family order; message bytes,
recipients, governance hashes, live amounts and fee bounds are still pending.
It must not be presented as an already-built/rehearsed production packet.

| Order | Owner-controlled action | Required checkpoint before continuing |
| ---: | --- | --- |
| 0 | Review the source commit and pinned ELFs/IDLs; identify BdAa signer custody; resolve token provenance, quote access and recovery proof; build/rehearse the entire unsigned packet on separate disposable state | Approve all inputs and the complete funding ceiling; fresh independent-reader proofs must agree on genesis, code, authorities, config/governance, recipients and buffer absence |
| 1 | Fund only the existing operational payer from the approved existing source, using the approved transfer message and reserve | Confirm finalized funding and approved balance; no new payer or identity keys |
| 2 | Launch first: atomic seeded buffer create + initialize + exact 50,512-byte ProgramData extension; write the pinned ELF in 830 chunks of at most 916 bytes; verify buffer bytes; upgrade E73 with spill to the same payer | Verify deployed ELF, unchanged `9GCf…EN1md` authority, retained roles/pauses and returned buffer deposit before funding the next stage |
| 3 | Swap second: atomic seeded buffer create + initialize + exact 26,024-byte extension; 606 writes; verify buffer; upgrade B2 with spill to the same payer | Same byte/authority/role/pause/refund verification; never stage both large buffers concurrently |
| 4 | Gate: seeded buffer create + initialize, 207 writes and read-back; create/deploy BdAa with its existing program signer, existing payer and approved upgrade authority | Verify Program/ProgramData addresses, exact pinned ELF, expected authority and rents; gate signer custody must already be proved |
| 5 | Only under its separate explicit approval, finalize the verified gate immutable | Read back null gate upgrade authority and exact deployed bytes; irreversible rent/authority consequences accepted |
| 6 | Migrate existing swap and launch economics with their `governed_set_config(expected, args)` instructions: swap share 2,500 and surcharge fields zero, then launch approved fee bounds; preserve both existing config pauses and all roles | Re-read config/governance after each message; refresh expected hashes/revisions rather than replaying stale ones; do not reinitialize existing Config/Governance |
| 7 | Review/init the selected creator authorization (`init_creator_authorization` only if fresh inventory still proves it absent), recipient quote holdings and exact production ALT create/extend messages | Verify authorization limits, quote ownership, ALT activation and refreshed post-config dossier/table pins before preparing any launch |
| 8 | Owner separately approves necessary gate/pause changes and bounded live launch, buy, sell and collection messages, amounts, sizes and fee ceilings | No live test or unpause is authorized by this sheet; verify the per-swap floor/remainder split and single-transaction retry identity, and restore the agreed paused state |
| 9 | Reconcile actual spend/refunds; return surplus only via the approved existing recipient and message | Stop on any mismatch; any later activation, merge or general unpause is a distinct owner decision |

All messages retain the 1,232-byte limit. Loader writes are 916 bytes at
most and omit the compute-unit-price instruction under the quoted zero-priority
geometry. Never use default CLI ephemeral key generation, silently retry a
re-signed transaction, or advance after an unverified/unknown outcome.
The currently observed governance gate bits are mixed (launch creation true,
trading false; swap creation false, trading true); both config pauses are true.
"Closed execution" means retaining those pauses, not claiming every gate bit
is false. No gate or pause was changed by this work.

### All-in funding ceiling — blocked, not the component estimate

The exact conditional **code/gate component** and peak payer funding remain
the figures in the budget tables above: 1.366921640 SOL non-reclaimable
rent/base fees, 4.127082480 SOL peak payer balance including the proposed
reserve, and 6.680779120 SOL cumulative recycled upgrade-buffer deposits.
Those amounts assume one successful attempt per write/action, no priority
fees, no on-chain IDL publication and separately approved gate finalization.
The dated payer shortfall is not an instruction to transfer money.

**There is no defensible numeric all-in production ceiling yet.** Do not
approve 1.366921640 SOL as total spend or 4.127082480 SOL as a complete funding
request. Additional governed-config/authorization/ALT messages, funding and
return fees, quote/bridge/liquidity/live-test amounts and rents, priority or
retry allowances, and the reserve must first be explicitly selected and quoted.
Unknown components are not zero.

The final non-reclaimable ceiling must sum the code/gate component and every
approved additional action's net rent, network fees and bounded test costs.
The funding ceiling must separately be the maximum chronological cumulative
outflow minus verified refunds, plus the approved reserve; do not add recycled
buffer deposits to profit or mistake gross turnover for net cost.
Re-quote using fresh rent/fee/balance/authority data and include the funding
transaction's source-wallet fee before requesting owner approval.
Until that complete numeric sheet and exact unsigned messages exist, **NO-GO:
no signing, spending, broadcasting, deployment, merging or unpausing**.

## Verification limits and evidence

Local evidence lives outside source at
`/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/acceptance-2/`, including
`consolidated-acceptance.public.json`, browser screenshots and production-mode
probe results. No production keys are stored there by this work.

`npm run build -- --webpack` completed with exit 0. It reported an unrelated
missing `app/lib/model-pulse.mjs` import from
`app/components/hf/model-pulse-slot.jsx`, plus the existing bigint native
binding fallback. Neither warning was suppressed or represented as fixed.

The full repository CI runner requires distinct pinned database environments
and destructive scratch setup; it was not run against the preserved server.
The supplied source-only inventories omitted historical vectors; their
authentic restoration and the completed 17-file rerun are recorded below.
Current inclusive evidence uses `HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR`
and `HOOKLAB_INCLUSIVE_TOKEN_ELF` as described in the local runbook.

### Historical-fixture regression blocker — resolved

The retained ZIP SHA-256 was verified as
`8aedbb40b75de2e119eaaa7150852b7ed091b576ae657e9e401ac2e7a2594263`.
Only the seven permitted fixture payloads were read and restored privately.
The five legacy vectors/plans match their source pins and pairings; the
custom pair preserves original vector identities
`42a557ce9e91e2c092b51b590ebbbee6223a3df6708ec70d20923744a677a523` and
`f5820f16ea1a4ab59598f8d85e0c068c7e44492ce81c18acfbb617b5a6d389f2`.
No historical source/deployment files were applied and no golden pins changed.

The additionally supplied authentic public legacy IDL was restored at
`vendor/hooklab-event-abi/max-wallet-candidate/hook_max_wallet.json`,
SHA-256 `d9b0d22e56156035df0ada4935d9cd00f0520019b049fec0d6238e4df8ca4088`.
Its narrow ignore exception is separate from the inclusive IDL exception;
wallet/keypair ignores remain active. Neither IDL replaces the other.
The private fixtures, including custom-vector and plan aliases, stay excluded.

All **17 affected test files executed: 475 tests passed, zero failed,
zero skipped, exit 0**. This includes the late-policy finalized-receipt
regression in `tests/hooklab-native-signing-db.test.mjs`. It is not a claim
that the entire repository/CI suite passed.

Tests used an unchanged private copy of current source, a macOS sandbox
denying outbound access except loopback PostgreSQL 55432, UUID-named scratch
databases, and the existing `HOOKLAB_GENERATED_FIXTURE_DIR`,
`HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR` and `HOOKLAB_INCLUSIVE_TOKEN_ELF`
overrides. Two initial Linux-default inclusive-artifact path errors were
resolved through those existing overrides, not source or pin changes.
No validator or app submission was possible from the test process.

Private evidence:
`/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/historical-fixture-recovery-8aedbb40/legacy-idl-regression-results.private.json`.
Raw TAP and historical payloads remain under that private 0700 directory
with 0600 payload/report files. They must not be published, committed,
broadcast or substituted into the accepted deployment candidate.
The accepted services were not restarted. All checked program ELF copies,
the separate inclusive IDL and existing database identities were preserved;
the tests left no scratch databases. No custody secrets were accessed.

## Final freeze checks and review limits

The accepted 50-file integration runtime source was hashed before handoff;
its historical aggregate was
`a1688fd2f3f3af1af358ac050e435886acdad8b2c11ee3dea1f1fa3a8290bd27`.
After that freeze, the owner explicitly authorized the missing public legacy
IDL restoration, narrow ignore exception and local wallet-switch fix.
The only runtime implementation changed is the local operations component.
No accepted service, database or ledger was restarted/reset, and no financial
flow was replayed. Runtime dependencies were not reinstalled: new test-only
DOM dependencies were installed in the private source copy.

The final offline guard/sender smoke command passed **8/8**, without touching
accepted state:

```sh
env NODE_ENV=development /usr/bin/sandbox-exec -f scripts/hooks-local-macos.sb \
  node --test tests/hooklab-local-acceptance.test.mjs \
  tests/hooklab-native-transaction-sender.test.mjs
```

This guard evidence covers production/mainnet/origin/DB refusal, synthetic
signing/rejection, expiry/deadlines, failed simulation, lost-response
single-send and message identity. The formerly blocked historical regression
gate is now separately resolved by the 475/475 run above.

### Wallet-switch P2 — fixed and exercised

`app/components/hooklab-local-operations.jsx` previously recreated a partial
operation when a late `wallet-request` response arrived after a wallet reset.
The response now checks the live wallet and retained operation ID before
updating state; the functional update preserves null or a different operation.
The operation identity is also rechecked after asynchronous hashing and wallet
signing, so switching away and back cannot reuse a cleared review.
Backend ownership, signature and production-isolation checks are unchanged.

`tests/hooklab-local-operations-ui.test.mjs` renders the actual component with
real React state/effects and a DOM. Before the fix, wallet switch, disconnect
and switch-away/back all failed with the `operation.review` render crash;
the unchanged-wallet handoff passed. After the fix **4/4 passed**.
A real Chromium isolated-component smoke, offline and with signing forbidden,
also exercised a deferred response followed by wallet switching: zero render
errors, zero signing calls, zero retain calls, no revived operation card,
and the retained signing ID remained visible. This was a component regression,
not a replay of financial acceptance or a fake on-validator success.

The consolidated Hook Lab rerun selected **62 files: 678 tests, 676 passed,
zero failed, two skipped**, exit 0. The two skips are the existing opt-in frozen
production ELF round-trip and frozen production Rust-builder execution tests;
they were not represented as exercised. The historical vectors and current
inclusive evidence were both supplied through their existing private paths.
Initial broader-harness failures from omitted app/scripts files and denied
ephemeral HTTP test-server access were corrected in the private harness,
not by changing source expectations.

The broad run used complete current-source copies, an external-network/custody/
accepted-file-write sandbox and an inherited private Node socket guard refusing
accepted app/validator ports. Its preflight proved ephemeral loopback HTTP
worked while ports 3443, 18898, 18899, 18999, 19000, 8909, 8910 and 3001 and
external traffic were denied. The original PostgreSQL-only sandbox for the
17-file rerun was unchanged. Raw TAP, browser proof and fixture data remain
private under `historical-fixture-recovery-8aedbb40/`.

### Unresolved review findings and verification limits

- Unbounded local PostgreSQL connection/query waits remain a reliability limit;
  no timeout feature was added as part of the wallet-switch fix.
- Dedicated persistent local-route/ALT-activation/finality-boundary coverage
  remains incomplete beyond the passing sender/late-policy cases. Prior real
  acceptance is not a substitute for every future permanent boundary test.
- The full repository CI matrix, with its destructive scratch-service setup,
  was not run against the retained environment. The 62-file result is Hook Lab
  coverage, not a green entire-repository claim.
- The prior nine-lens local review's independent Claude CLI attempt timed out
  without a usable artifact; its serving model and independent adversarial
  coverage remain unverified. Do not relabel that historical review green.
- Gate signer custody, independent recovery proof, external token-source
  provenance, production economics/quote/recipients, exact unsigned rehearsal,
  fresh independent readers and the all-in ceiling remain release blockers
  in the consolidated approval sheet. No production action was performed.

Current fix-scoped reviews of the async UI/tests/ignore boundaries and the
upgrade-sheet arithmetic/action order both returned **no actionable findings**.
They were local reviewers, not a claimed replacement for the missing
independent cross-model review. The unrelated local resume helper was excluded.

## Primary references

- [Agave 4.3.0 CLI deployment/chunking implementation](https://github.com/anza-xyz/agave/blob/v4.3.0/cli/src/program.rs)
- [Agave 4.3.0 compute-budget construction](https://github.com/anza-xyz/agave/blob/v4.3.0/cli/src/compute_budget.rs)
- [Agave 4.3.0 loader Buffer drain and deploy/upgrade semantics](https://github.com/anza-xyz/agave/blob/v4.3.0/programs/bpf_loader/src/lib.rs)
- [Loader V3 state sizes](https://docs.rs/crate/solana-loader-v3-interface/7.0.0/source/src/state.rs)
- [Solana rent-exemption RPC](https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption)
- [Solana unsigned message-fee RPC](https://solana.com/docs/rpc/http/getfeeformessage)
