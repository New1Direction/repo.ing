# Hook Lab production handoff: retain E73/B2, no execution approval

## Decision boundary

Local browser acceptance passed on 2026-10-18 against the rebuilt programs,
a fresh disposable database/validator and the existing synthetic wallet roles.
This does **not** authorize production signing, funding, broadcasting,
deployment, merging, upgrades or unpausing. None was performed. The owner
performs final signing and live acceptance locally.

The recommended values below are **not approved**: 100 bps gross creator fee
and a 200 bps v2 wallet cap. **The proposed 2% cap differs from the earlier
1% proposal and doubles the permitted per-wallet allocation.** Reusing local
test values does not approve production settings. repo.ing receives
`floor(gross / 4)` per swap, the creator receives the remainder, and there is
no additional platform surcharge.

**Release status remains NO-GO; the PostgreSQL regression blocker is resolved.**
The disk-full incident stopped the local services. The owner subsequently approved
deleting only the npm download cache and two webpack caches, and recovering only
the existing PostgreSQL cluster. Its normal WAL recovery completed; all six
database identities and six retained finality receipts match the saved evidence.
The final five-test PostgreSQL run and no-signing SQL/HTTP smoke both passed.
VM/Docker, validator, bridge and browser recovery was not approved or performed.
The accepted browser URL is not currently served. Production actions remain blocked.

## Source and artifact baseline

- App baseline: `New1Direction/repo.ing` PR #304,
  `d3eb0df2701be2b77e624d60750b99bc8bb23ebe`.
- Accepted app runtime baseline: `4f611561f2502699e2ffb039ef759fa65f36380c`.
  Prior approval-only commit: `38f635e5167e5f39ed073727ee10fb52edb629b9`.
  This follow-up adds the verified database deadline fix and its regression tests;
  it does not replace the earlier financial browser-acceptance baseline.
  No program source, artifact pin or identity changed.
- Protocol baseline: `New1Direction/hook-lab` PR #5,
  `134e16de1aadeac921bb314284fd3fd181c86097`.
- Protocol source was not modified. Existing commit patches were not reapplied.
- Original `Gitfun` repository and unrelated payout work were not modified.
- Build tooling: Agave 4.3.0, platform-tools 1.57, SBF v3. The cached SBF
  compiler reports Rust 1.95.0; Rust 1.97.1 was the host compiler metadata,
  not the SBF compiler version.

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

Independent preparation checks use **Solana Labs**
`https://api.mainnet-beta.solana.com` and **Allnodes/PublicNode**
`https://solana.publicnode.com`, both with mainnet genesis
`5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`.
The first new 26-role/four-ProgramData snapshot agreed on state but its secondary
observations spanned 22 slots, so independent review correctly rejected it as
a five-slot freshness certificate. `allComparedStateAgrees` alone is insufficient.

A subsequent read-only recollection compared all **30 accounts in 814 ms**.
Both providers returned **slot 458381139**: zero slot spread, within the
unchanged five-second/five-slot limits. State agreed independently; the shared
`quoteMint`, `solVault` and `nativeWrapper` accounts had changed since the earlier
packet snapshot. Those changes are explicitly recorded, not waived or attributed
to an assistant transaction. The unsigned packet requires fresh state binding.
No rent/fee quote or funding-ceiling change was observed.

PublicNode `getMultipleAccounts` returned HTTP 403; one JSON-RPC batch of
individual `getAccountInfo` calls succeeded. This is a private read-only evidence
probe, not a production adapter change. The earlier dRPC rejection and an
initial read-only HTTP 429 were not treated as successful readers. No signing,
simulation or submission RPC was used. Re-read before every owner action;
even the successful preparation observation is not a lasting signing certificate.

| Object | Observed state |
| --- | --- |
| Launch `E73c…rCKft` | Executable; ProgramData `FHSVsk3nonaqAeFtgu56BFU9hg9KugxbHLoGkAAxgfyp`, 709,509 bytes, 3,604,955,960 lamports |
| Swap `B2cr…pZJwk` | Executable; ProgramData `GuyHY9x78h52RX87RQ2nD8xnzr2dArnx5XDBz3HsJf7d`, 528,829 bytes, 2,687,101,560 lamports |
| Both upgrade authorities | `Some(9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md)` |
| Candidate gate `BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb` | Absent; its existing program-signer custody reference has not been identified |
| Operational payer | 1,175,000 lamports |
| Upgrade authority wallet | 902,231 lamports; the proposed payer remains the separate operational payer |
| Proposed seeded launch/swap/gate buffers | All three absent on both independent readers; addresses below |

**Retained-ID upgrades are supported and their loader mechanics have now been
rehearsed on separate disposable state.** Launch and swap need neither new
program identities nor their program-identity keys to upgrade.
The current accepted ELFs require exact ProgramData extensions of 50,512 and
26,024 bytes. Both exceed the 10,240-byte minimum; Agave 4.3.0 does not round
an already-above-minimum extension to another 10 KiB multiple.

The accepted inclusive IDLs decode the existing 250-byte launch Config,
189-byte swap Config and both 348-byte governance accounts identically on
both readers. Both pauses remain true, governance revisions are zero and no
admin transfer is pending. The selected creator grant and receiving holdings
are absent. The older full owner-account scan returned only Config and
Governance, not Launch/Pool/grant accounts; it is not a fresh global inventory.
The rehearsal below proves loader execution and preserved config bytes under
synthetic authority, not possession of any production signer.

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
Only public production addresses/accounts were derived/read and unsigned
messages fee-quoted. No production account creation, signature or broadcast
occurred. The separate local rehearsal uses deterministic synthetic signers.

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

Fresh finalized rent quotes from both readers fit
`R(n) = 650240 + 5080 * n` lamports. Buffer metadata is 37 bytes,
ProgramData metadata 45 bytes, and a Program account 36 bytes.
The original exact loader-message measurements are:

| Proposed message | Required signatures | Wire bytes with reserved signature slots | Base fee, lamports |
| --- | ---: | ---: | ---: |
| Seeded launch/swap buffer create + initialize + extend | 1 | 460 | 5,000 |
| Seeded gate buffer create + initialize | 1 | 381 | 5,000 |
| Loader write, 916 payload bytes | 2 | 1,232 | 10,000 |
| Retained-program upgrade | 2 | 436 | 10,000 |
| Gate Program creation + initial deployment | 3 | 598 | 15,000 |
| Gate immutable finalization | 2 | 303 | 10,000 |

The production packets remain unsigned. Their write geometry was additionally
exercised with real synthetic signatures in the disposable rehearsal:
the 916-byte payload reaches, but never exceeds, 1,232 serialized bytes.
The 917-byte negative measurement is 1,233 bytes and remains forbidden.

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

Before the launch spill, the code stage requires 4,126,432,240 lamports:
3,861,516,280 buffer rent + 256,600,960 extension rent + 8,315,000 fees.
The recommended **50,000,000-lamport retained payer reserve** replaces the
earlier 650,240-lamport dust proposal. The complete chronological funding
ceiling, including both funding-transfer fees and the canary, appears in the
single approval sheet below.

Cumulative launch/swap buffer deposits returned to the payer:
**6,680,779,120 lamports**.

The two buffer refunds are **recycled sequential credits**, not an extra
return to add to the final payer balance. Each ProgramData is already
rent-funded after extension; Loader V3 spills the whole corresponding
buffer deposit to the payer on upgrade. Gate buffer funding is recycled
into new permanent ProgramData rent, not a net reclaimable gate refund.
Existing E73/B2 program rent remains in place, not refunded. The immutable
gate's rent cannot later be reclaimed through an upgrade-authority close.
No production funding, refund or return transfer was performed.

### Reconciliation with 7.660660400 SOL

The earlier number assumed **three fresh initial deployments**. It was not
the cost of retaining E73/B2, which already exist. It also counted only 829
launch writes; direct ELF chunk measurement requires 830, adding 10,000
lamports. The corrected same-length fresh benchmark is **7.660670400 SOL**
(7,644,155,400 permanent rent + 16,515,000 base fees).

Stock CLI retained-ID staging with separately approved existing buffer signers
would cost 1.366936640 SOL for the code/gate component, not the recommended
seeded component. CLI funds buffers at the larger ProgramData rent and adds
an initial signature. Its auto-extension is part of that initial transaction.
Do not use its default ephemeral signer generation. The seeded route avoids
those keys and saves 15,000 lamports in initial-message fees.

The fresh benchmark is not an executable alternative: these binaries declare
the existing E73/B2 addresses. Different program identities would need
explicit approval, rebuilding, new pins and renewed acceptance. None was
generated.

## Consolidated owner approval sheet — one bounded route, NO-GO

**Authorized production spend/signatures/broadcasts now: zero.**
Recommend retained E73/B2 upgrades, the existing BdAa gate and **one controlled
owner-led canary**, ending with both execution config pauses restored.
This is not approval for general rollout, production web activation, merging
or leaving execution open. No new production wallet or program ID is proposed.
Historical-fixture recovery is resolved; its actual results are below.

### Recommended values for every pending decision

Every recommendation remains pending explicit owner approval.

| Decision | Recommended value | Required approval/evidence |
| --- | --- | --- |
| Launch/swap identities | Retain E73/B2; exact pinned ELFs above, exact 50,512/26,024-byte extensions | Approve source/artifact pins and retained-ID route |
| Upgrade signer | Existing `9GCf…EN1md`; do not use it as fee payer or rotate it | Owner verifies usable custody and independent recovery, public result only |
| Payer / buffer base | Existing `3eCF…4g5o`; seeded buffers above; authority `9GCf…EN1md` | Approve exact addresses, seeds, rents and spill-to-payer recipient |
| Funding / surplus recipient | Existing treasury `FhEw…sW3i` for funding and all surplus; existing owner single-signature SOL wallet prefunds it | Treasury currently has zero lamports. Record the prefunder's public address/custody reference; no new wallet. A multisig, swap or different funding fee requires re-approval |
| Payer reserve | Retain **50,000,000 lamports / 0.05 SOL** after surplus return | Reserve is held capital, not permission to spend it |
| Admin / guardian | Retain `DVdd…Tj8S5` / `CT4S…RmEY` | No role reassignment; recovery verified locally by owner |
| Gate signer | Existing **`BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb`** only | **Blocking:** locate its existing signer; exact non-exporting next step below |
| Gate authority / finalization | Existing `9GCf…EN1md` initially; recommend immutable only after exact byte/ID read-back | Separate irreversible-finalization consent; never automatic |
| Gross creator fee | **100 bps / 1%** | Set launch maximum creator fee to 100 and aggregate rules-fee bound to 100; the latter is a validation bound, not another charge |
| Platform share | **2,500 bps of gross creator fee**, integer floor per swap | Creator receives `gross - floor(gross/4)`; no extra platform fee |
| Other charges / author share | Flat launch/pool fee, protocol surcharge, LP/sniper/holder/burn fee and selected-config author share **all zero** | Preserve the inclusive model and direct creator remainder |
| Wallet cap | **Proposed 200 bps / 2% in PolicyV2, versus earlier 100 bps / 1%** | Requires explicit approval of the doubled allocation. Legacy selected rules remain all zero; preserve global legacy max-wallet bounds 1/1 |
| Platform recipient | Existing treasury/collector **`FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i`** | Verify its canonical A49 quote holding and pinned inclusive policy recipient |
| Creator recipient | Each launch's actual creator; first controlled canary only: **`DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9`** | Existing `dedicated-creator` role, not a general production default |
| Canary mint | Existing **`2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn`**, `separate-mint` role | Verify custody/absence. Do not repurpose the old `6qi…` mint identity |
| Selected-config signer | Reuse an existing compatible creator/mainnet/profile-bound config identity | **Blocking:** public config address and local journal/custody reference not identified. If none exists, obtain separate consent for a config-account signer; do not silently generate or repurpose one |
| Creator authorization | One launch, enabled; `expiresSlot = S + 9,000`, where S is the fresh finalized slot used to build the grant | Display the exact absolute expiry before signing. Grant changes the governance commitment; refresh it before launch |
| Curve / mint parameters | Preserve 7,500 bps curve allocation, raw supply `1,000,000,000,000,000`, decimals 6, virtual quote `1,000,000,000` | No unrelated parameter migration |
| Canary metadata | Name `repo.ing Hook Canary`, symbol `RHOOKTEST`, URI empty | Both existing validators permit an empty URI. No fabricated URL, metadata hosting or public launch |
| Quote access | Existing native token `2X…`, bridge `CtL…`, quote **`A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i`**; wrap at most **10,000,000 lamports / 0.01 SOL** | No new wrapper/mint/vault, no external swap, no separate liquidity provision; attestation and fresh dependency checks remain mandatory |
| One buy / one sell | Buy exactly **1,000,200 raw native quote**; sell only the finalized acquired base, at most the entire acquired amount | Buy is inside the wrap allowance, not an additional capital charge. Recommended slippage 50 bps with fresh compiler-calculated integer min-out; no invented future output |
| Fee collection | Existing tested combined `claim_creator_fees` + `collect_protocol_fees`, paid by DkD and co-signed by DVdd | Pay native quote to DkD/FhE holdings. Do not substitute the unexercised SOL-collection path. Creator unwraps its remaining quote; treasury quote receipts remain held |
| Launch ALT | Canonical **38 addresses**, 1,272-byte table; authority DVdd, payer 3eCF | Two messages: create + first 20, extend remaining 18. Verify actual owner/authority/addresses/hash, active state and warm slot; retain table, do not freeze/deactivate/close it in this route |
| Creator tranche | Exactly **42,749,400 lamports** from 3eCF to existing DkD | 32,664,400 rents + 10,000,000 quote capital + 85,000 bounded creator fees; no further top-up |
| Review / expiry | Preserve 60-second review TTL and at most +96 slots, whichever expires first; reader age at most 5 seconds and lag at most 5 slots | Rebuild unsigned review after any control/config change; never reuse an expired signed request |
| Priority / retries | Zero priority fee; zero newly signed retry allowance; `maxRetries: 0`, normal signature checks and preflight | Unknown outcome: reconcile the original signature/ID only. Any new attempt requires a new reviewed budget |
| Publication / activation | No on-chain IDL publication or public metadata spend; no general unpause or merge | Both public IDLs remain source files; private fixtures, journals and wallets remain excluded |
| Reader policy | Two distinct operator endpoints agreeing on exact current state; use owner-approved production endpoints at signing time | Current Solana Labs/Allnodes read-only evidence is complete, but anonymous public RPC is not recommended as production app infrastructure |
| Recovery / provenance | Independent owner-controlled recovery proof for signers; authoritative source/build attestation for the external token | **Blocking:** same-Mac recovery is not independent, and matching external ELF bytes alone do not prove source provenance |

Public receiving/grant targets for that controlled canary, currently absent
on both readers:

| Account | Public address |
| --- | --- |
| DkD A49 quote holding | `Ct5SCe1bMqpPm6DN4iuKVcP77gyv5vQyzEP6Zc7gbK85` |
| FhE A49 quote holding | `GpFsm7FLfvkykG83VY55wwxxpWKoDeUcMeTB5ddHrhBx` |
| DkD creator authorization | `Ehfpy1rTpv9uiVpmWUKgYfM6ZQ9bYxuPFNCcxtpgu2mv` |

The existing external token is
`2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22`; the existing bridge is
`CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7`.
Neither program is part of the proposed upgrades.

### BdAa public-key check — completed, mismatch

No BdAa signer role was found in the eleven public custody manifests.
Filename-only searches found this **local rebuild artifact**, not a verified
production custody record:

```sh
/opt/homebrew/bin/solana-keygen pubkey \
  '/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/rebuilt-inclusive/elf/hook_max_wallet-keypair.json'
```

The documented command was run locally. Its sole public output was
**`CUBGH9bhbMQnWcfXgjtXhgNFCKUxdDCBiFQnY7SVxQ1i`**, which does **not** match
`BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb`.
No key contents were printed, copied, exported or uploaded, and no transaction
was signed. This local rebuild artifact cannot supply the existing BdAa identity.
Do not generate a replacement or treat the source's declared address as custody.

The exact next step is to obtain the **original BdAa program-identity custody
record** from its generation operator: public address and role, original
set/journal ID, manifest path, owner-local signer handle/reference, and Keychain
service/account labels if applicable. The operator then runs the same public-key
display against that original local reference and compares BdAa locally.
Return only the public result and custody reference—not the keypair, seed,
passphrase, encrypted payload or Keychain secret. An address match still needs
independent recovery proof.

For the separate selected-config prerequisite, recover only the public
config/journal identity and matching creator/mainnet/profile binding from the
original browser profile/origin or existing custody record. The planner's
“Unlock for recovery only” control is for mint/config journals, **not** a
generic program-signer finder. Do not create a journal or use a synthetic
config to bypass this prerequisite.

### Exact ordered owner actions and fee inventory

**Pre-sign hold point:** close custody, recovery, external provenance and
selected-config prerequisites; approve every value above; assemble the exact
unsigned instruction/account manifest with fresh absolute slots/blockhashes.
No production packet is claimed complete while the selected-config address
and funding-source public address are missing. Re-quote every actual message,
verify canonical address placement and all fully signed wire sizes ≤1,232,
and rehearse the final address-bound canary before authorizing any spend.

The existing **1,650 code/gate messages** run between rows 2 and 3:
launch create/init/extend + 830 writes + upgrade; verify complete spill;
swap create/init/extend + 606 writes + upgrade; verify spill; gate
create/init + 207 writes + initial deploy, exact read-back, then separately
approved finalization. Never stage both large buffers simultaneously.
Production gate initial deployment is not rehearsed or authorized by the
synthetic retained-program test.

| Order | Action | Fee payer; other required signers | Signature count | Fee ceiling, lamports |
| ---: | --- | --- | ---: | ---: |
| 1 | Existing owner wallet prefunds FhE with 4,175,262,240 lamports | Existing owner funding wallet | 1 | 5,000 |
| 2 | FhE funds 3eCF with 4,175,257,240; then execute the verified code/gate sequence above | FhE; code-stage signers as previously tabulated | 1 for transfer | 5,000 for transfer |
| 3 | Swap governed config: share 2,500, surcharge fields zero, preserve pause/roles | 3eCF; DVdd | 2 | 10,000 |
| 4 | Launch governed config: approved fee bounds, preserve other fields/pause/roles | 3eCF; DVdd | 2 | 10,000 |
| 5 | Initialize the absent one-launch DkD grant with exact expiry; refresh governance commitment | 3eCF; DVdd | 2 | 10,000 |
| 6 | Create canonical ALT and append first 20 addresses | 3eCF; DVdd authority | 2 | 10,000 |
| 7 | Append remaining 18, wait for finality/warm slot and pin actual table bytes | 3eCF; DVdd | 2 | 10,000 |
| 8 | Fund existing DkD with the exact 42,749,400-lamport tranche | 3eCF | 1 | 5,000 |
| 9 | Create DkD and FhE A49 quote holdings together, only if still absent | DkD | 1 | 5,000 |
| 10 | Existing bridge `wrap_sol` for exactly 10,000,000 lamports | DkD | 1 | 5,000 |
| 11 | Prepare v2 policy, registry and selected config; verify their exact bytes | DkD; existing mint and approved config identity | 3 | 15,000 |
| 12 | Separately approved launch creation opening; refresh unsigned launch controls | 3eCF; DVdd | 2 | 10,000 |
| 13 | Separately approved swap trading opening; refresh final unsigned launch/market review | 3eCF; DVdd | 2 | 10,000 |
| 14 | One guarded inclusive launch; verify finalized events, allocations and policy | DkD; mint and DVdd reviewer | 3 | 15,000 |
| 15 | Create DkD base holding **after the mint exists** | DkD | 1 | 5,000 |
| 16 | One bounded buy | DkD | 1 | 5,000 |
| 17 | One bounded sell of acquired base; reconcile original signature before continuing | DkD | 1 | 5,000 |
| 18 | Restore launch creation closed/config paused | 3eCF; DVdd | 2 | 10,000 |
| 19 | Restore swap trading closed/config paused | 3eCF; DVdd | 2 | 10,000 |
| 20 | Combined native-quote creator/platform fee collection with exact recipient checks | DkD; DVdd | 2 | 10,000 |
| 21 | Unwrap remaining DkD native quote; no treasury unwrap in this route | DkD | 1 | 5,000 |
| 22 | Close empty DkD quote holding, rent back to DkD | DkD | 1 | 5,000 |
| 23 | Close DkD base holding **only if actually empty and closable** | DkD | 1 | 5,000 |
| 24 | Return verified DkD surplus to FhE; leave enough for its exact transfer fee | DkD | 1 | 5,000 |
| 25 | Return 3eCF surplus to FhE, retaining 50,000,000 lamports | 3eCF | 1 | 5,000 |
| **Additional-message ceiling** | **25 messages, each at most once** | **39 signatures** | **39** | **195,000** |

Rows 18/19 restore the actual initial mixed gate state: launch creation=true,
trading=false; swap creation=false, trading=true. **True means closed.**
Both corresponding config pauses finish true. Fee-collection contract paths
do not reject a paused config, so gates need not stay open for collection.
Any mismatch/unknown outcome stops progression without re-signing; the owner
uses the already reviewed close actions and retains the original receipts.

### One exact all-in funding ceiling

**Recommended capital ceiling: 4,176,442,240 lamports = 4.176442240 SOL.**
This is the maximum capital required for the specified chronological route,
not net burn, an instruction to transfer, or a contingency allowance.
It includes the observed payer credit and both ordinary funding-transfer
fees. It is conditional on unchanged rents/fees/authority/account absence and
the exact finite inventory above; any variance stops for re-approval.

| Funding measure | Lamports | SOL |
| --- | ---: | ---: |
| Peak balance required in 3eCF, including 0.05-SOL retained reserve | 4,176,432,240 | 4.176432240 |
| Already observed in existing 3eCF | 1,175,000 | 0.001175000 |
| Required additional owner cash, including both funding-transfer fees | 4,175,267,240 | 4.175267240 |
| **Single all-in capital ceiling, existing credit plus fresh cash** | **4,176,442,240** | **4.176442240** |

Later operations occur **after verified buffer spills** and fit the remaining
cash; do not add their gross turnover to the launch-stage peak. The treasury
currently has zero lamports: existing funds have not been located or spent.

| Additional account rent | Bytes / count | Lamports |
| --- | --- | ---: |
| Creator authorization | 73 | 1,021,080 |
| Canonical per-launch ALT | 1,272 / 38 addresses | 7,112,000 |
| DkD quote/base plus FhE quote holdings | 204 × 3 | 5,059,680 |
| PolicyV2 + registry + selected config | 90 + 81 + 176 | 3,713,480 |
| Launch, mint, pool, LP mint, pool registry, five holdings, inclusive fee policy | 565 + 519 + 411 + 519 + 186 + 204 × 5 + 75 | 23,891,240 |
| **Additional gross rent** | | **40,797,480** |

| Final allocation / fee bound | Lamports | SOL |
| --- | ---: | ---: |
| All added account rent, code/gate plus canary | 1,391,229,120 | 1.391229120 |
| All network fees: 1,650 code/gate + at most 25 additional messages | 16,685,000 | 0.016685000 |
| **Added rent + network fees** | **1,407,914,120** | **1.407914120** |
| Maximum quote capital exposed, including the buy rather than adding it twice | 10,000,000 | 0.010000000 |
| Reserve retained in payer, not consumed | 50,000,000 | 0.050000000 |
| **Conservative maximum allocated after surplus return** | **1,467,914,120** | **1.467914120** |

The quote and reserve rows are held/exposed capital, **not network fees or
expected losses**. No sell proceeds, collected fees or account-close refunds
are assumed to finance an earlier action. The allocation bound conservatively
does not credit up to 3,373,120 lamports of DkD holding rent until both empty
closes are finalized. The FhE quote holding and active ALT are retained;
no refund from them is priced. ProgramData and immutable-gate rent are not
reclaimed in this route. Sequential buffer refunds are already recycled.

Under maximum debits, the payer balance immediately **before** its last
transaction is 2,758,533,120 lamports: transfer **2,708,528,120** to FhE,
pay that transaction's **5,000** fee, retain **50,000,000**. The final fee is
counted once in the 195,000-lamport additional-fee total, not subtracted twice.
Any verified creator surplus is additional. Calculate the actual return from
the finalized balance less that fee/reserve, never from an optimistic refund.
On-chain IDL publication, extra liquidity, extra buy/sell, priority fees and
newly signed retries are excluded **by explicit zero allowances**, not omitted
unknowns. A different action list requires a different reviewed ceiling.

### One owner approval checklist — no item is execution permission by itself

- [ ] Retain launch `E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft`
      and swap `B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk`;
      approve exact pins, extensions and sequential buffer/spill order.
- [ ] Verify original gate signer `BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb`,
      upgrade signer `9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md`,
      payer `3eCFwDiKetHe9pg1zNEkTohUECu2vtsZDRMZ3jeR4g5o`,
      admin `DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5` and guardian
      `CT4SioSvVFHcnuJbJMfcVgdR3GHAyK7VmrjvR6y3RmEY`.
      Supply independent recovery, existing selected-config binding and prefunder
      public address/custody reference. Do not generate replacements.
- [ ] Complete independent external-token source/build attestation and approve
      mutable dependency trust for token `2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22`
      and bridge `CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7`.
- [ ] Explicitly choose **proposed 2% cap versus earlier 1%**, **1% gross creator
      fee**, per-swap **floor 25% platform / remainder creator**, zero surcharge
      and zero author share. Platform recipient:
      `FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i`.
      Each launch pays its actual creator; this one canary uses
      `DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9` and existing mint
      `2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn`, not general defaults.
- [ ] Approve the exact ordered bounded canary: one-launch grant/absolute expiry,
      canonical warm ALT, 0.01-SOL wrap ceiling, one 1,000,200-raw-quote buy,
      sell no more than acquired base, quote fee collection and final closed gates.
- [ ] Approve **4.176442240 SOL total capital ceiling**, including existing payer
      credit; fresh cash at most **4.175267240 SOL**; 0.05-SOL retained reserve,
      zero priority fee/newly signed retries and no unpriced additional actions.
- [ ] Review stage-specific fresh address-bound unsigned messages, independent
      state and actual fee/rent quotes; every reserved signed wire size ≤1,232.
      Separately consent to immutable gate finalization after exact read-back:
      future gate upgrades/closure/rent recovery are then permanently unavailable.
- [ ] After every prerequisite closes, owner locally signs/executes only the
      separately approved paused-deployment/canary stages and verifies spills,
      receipts, fee arithmetic and restored pauses. This does not approve merging,
      public trading, a general unpause or any action by the assistant.

## Verification limits and evidence

Local evidence lives outside source at
`/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/acceptance-2/`, including
`consolidated-acceptance.public.json`, browser screenshots and production-mode
probe results. No production keys are stored there by this work.

### Accepted browser execution and actual fee split

The retained real-browser launch was **821 fully signed bytes**, buy/sell
705 bytes each, and combined fee collection 655 bytes, all below 1,232.
The accepted URLs remain `https://localhost:3443/hooks/launch-review` and
`https://localhost:3443/hooks/trade`. No financial browser flow was replayed
for this approval closure.

All amounts below are raw native quote, nine decimals; values are retained
actual finalized receipts, not predictions for the proposed future canary.

| Accepted swap | Gross creator fee | Platform receipt/accrual | Creator receipt/accrual | Extra surcharge |
| --- | ---: | ---: | ---: | ---: |
| Buy | 10,002 | 2,500 | 7,502 | 0 |
| Sell | 4,954 | 1,238 | 3,716 | 0 |
| Combined collection | 14,956 | 3,738 | 11,218 | 0 |

The floor is applied **per swap**: `10002 // 4 = 2500`,
`4954 // 4 = 1238`. Do not floor the combined gross: that would incorrectly
produce 3,739. Actual collection cleared both accrued balances and left the
pool reserve unchanged. Lost-response acceptance retained the same signature,
observed one RPC submission and refused duplicate submission with HTTP 409.
The cap-violation simulation returned the real gate `CapExceeded`/6001 with
signature verification enabled and no broadcast. Expiry issued no wallet
request, retained no signature and dispatched no expired transaction.

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
At the accepted `4f61156` freeze, the only runtime implementation change was the
local operations component. This follow-up additionally changes database-pool
construction and targeted tests, as detailed below. The owner later approved
PostgreSQL-only recovery after the disk-full service exits. No ledger/database
reset, validator/browser restart or financial transaction replay was performed.

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

### Closure evidence and disposition of every remaining coverage gap

Private closure evidence root:
`/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/approval-closure-20261018/`.
No private fixtures, serialized historical messages, wallet secrets or runtime
ledgers are source changes.

| Gap or finding | Disposition for the proposed bounded route | Evidence / reason |
| --- | --- | --- |
| Authentic historical fixtures / legacy IDL | **Resolved; non-blocking** | Verified archive and IDL pins; 17 affected files, 475/475 tests. No pin changes or historical source applied |
| Wallet-switch race | **Resolved; non-blocking** | Four actual-component regressions and real Chromium deferred-response smoke; no signing/retain call or revived card after wallet switch |
| Independent current production readers | **Fresh preparation recollection passed; signing-time refresh remains blocking** | 30 accounts agree at slot 458381139 in 814 ms. Earlier 22-slot secondary spread was rejected. Three shared quote/bridge accounts changed since the packet snapshot; rebind before signing |
| Retained E73/B2 upgrade mechanics | **Completed; non-blocking** | Separate validator, real old ELF bytes/lengths, exact extensions, 830/606 writes and real upgrades: **1,440 finalized signed transactions**, maximum **1,232 bytes**, exact candidate hashes, full buffer spills, unchanged config/governance bytes; wrong authority refused for both |
| Production local-route refusal | **Completed private boundary proof; non-blocking** | Actual POST handler under `NODE_ENV=production`: local flag off → 404; on → 409 even with local wallet flag set. Valid dev config was checked separately. Scratch signing-table fingerprint unchanged, zero accepted-validator sends |
| ALT owner/completeness/activation/warm boundary | **Completed private boundary proof; non-blocking** | Actual provider against the real retained 38-address table passes; declared client-side account-read faults for wrong owner, missing address, deactivated state and unwarmed slot all refuse. No table creation or validator writes |
| First finality / failed outcome / duplicate dispatch | **Completed scoped evidence; non-blocking** | Fresh offline two-file run: **17 tests passed, zero failed/skipped**, real scratch PostgreSQL plus fee-only failure collector tests. First finality is immutable, later conflicts force review, no second dispatch. Read-only accepted DB retains six finalized receipts; original RPC slots are pruned and were not fabricated/re-queried as success |
| Production-quote bridge access and close rent | **Completed local public-byte proof; non-blocking** | Separate native-token/bridge clone: four finalized signed transactions, max **484 bytes**, **10,000,000 lamports ↔ 10,000,000 raw quote**, no bridge surcharge, supply/vault restored, empty holding rent refunded. Mainnet and accepted validator untouched |
| Full final address-bound unsigned production/canary packet | **Blocking before signing** | Independently decoded 1,650 core messages have zero signatures and max reserved signed wire size 1,232 bytes. Config/prefunder identities, future deployment slots/controls, actual ALT and finalized trade amounts still prevent a final canary packet. Earlier blockhash/state must not be signed |
| BdAa custody and selected-config custody | **Blocking** | Public-only rebuild check returned CUBGH9…, not BdAa. Original BdAa custody record required. No compatible selected-config public identity/journal binding found; do not create or substitute one |
| Independent signer recovery | **Blocking** | Same-Mac backup manifests do not establish independent recovery. Owner supplies public expected/observed/match records from a separate trust domain/device, not secret material |
| External token source/build attestation | **Blocking until independent rebuild/attestation** | Public source commit/build recipe identified; raw `7aa07…` trims 15 zero bytes to canonical `ec9d9f…`, exactly the upstream/on-chain executable hash. This is not a binary mismatch. Public verifier reports `is_verified:false`; no local reproduction completed because of disk/VM limits |
| PostgreSQL deadline fix | **Resolved targeted regression blocker; non-blocking on its own** | Final real-DB run: 5/5 passed, zero failures/skips, including actual quota lock waiter/55P03, request rollback and runtime 14/15-second policy. Final actual smoke: 5,003-ms checkout, 30,007-ms idle rollback/replacement, production HTTP 404/409. Production topology/custody-adapter checks remain separate public-activation gates |
| Entire-repository CI / unrelated build warning | **Non-blocking for this restricted program/canary review; required before any later merge/general app release** | Hook Lab result is 676 pass/0 fail/2 skips, not a green whole repo. Full runner needs isolated destructive scratch services; missing model-pulse import warning remains unrelated and unresolved |
| Two opt-in frozen production SBF/Rust tests | **Non-blocking for these candidate ELFs** | Intentionally skipped tests pin the older `faa3…`/`abda…` baseline, not this candidate. Actual candidate browser execution and retained-ID loader rehearsal provide the relevant runtime evidence; no baseline repinning |
| Independent code/packet review | **Completed review and targeted post-review verification; not release approval** | Six local personas and attested Claude Opus 5 reviewed timeout scope. The confirmed lock-test gap is corrected and passes the final five-test real-DB run; final smoke also passes. Independent packet audit confirms size/signers/budget and rejects the original stale snapshot |
| Approved economics/recipients/funding and treasury availability | **Blocking owner decisions** | Every pending value now has one recommendation and finite ceiling. Treasury is zero; no assumption that funding is already available and no transfer authorized |

The retained-program rehearsal preserves the actual public E73/B2 IDs,
ProgramData addresses, old/new ELF bytes and exact capacities. In its genesis
only, deployment slots were normalized to zero and the loader authority was
replaced with the existing **synthetic** E329 role. The actual 9GC production
custody was never touched. Local rent uses the validator's different schedule;
its refund amounts are not substituted into the separately measured mainnet
budget. This proves upgrade mechanics, **not** BdAa initial deployment or
the still-missing full address-bound production packet.

The quote-access rehearsal copied public token/bridge ELF and mint/wrapper/
config/vault state, normalized deployment slots/local rent and used synthetic
balances. It left external authorities unchanged and never used them.
The initial probe's confirmation helper raised
`TransactionExpiredBlockheightExceededError`; its original holding-creation
signature was then read as finalized over HTTP and **not resent**. This was a
confirmation failure, not an expired transaction falsely counted as success.
The remaining three steps finalized normally. Four unique signatures and 20,000 total
local base fees were verified; holding rent 2,310,720 was fully returned.
The mainnet holding quote remains 1,686,560, not that local rent.

The live token remains upgradeable by external
`5wni4K2qdSfTr6JspbLXDStfbq1XSmzMpF75RSpwsjBH`; bridge by external
`5xsibKwtiN6ruxsYrEyWVpV3KcwuzSPbQd1n28a7spEd`.
Bridge ELF hash is
`9866c6b42409a9465756040f623c70200a10bd24bf3408f23abe1d2d98f25591`.
They are neither immutable nor controlled by the 9GC upgrade role.
Require exact fresh dependency read-back and owner acceptance of this trust
boundary; neither is an invitation to upgrade those external programs.

Evidence files (private, not part of the source commit):

- `preflight/two-provider-verified.private.json` and
  `preflight/seeded-buffers-verified.private.json`;
- `rent-fees.private.json` and `all-in-budget.private.json`, including the
  exact 25-message inventory and chronological reserve/spill conservation;
- `rehearsal/loader-upgrade-evidence.private.json`;
- `coverage/route-alt-evidence.private.json` and
  `coverage/finality-regressions.private.tap`;
- `bridge/native-quote-evidence.private.json` and the explicit synthetic
  genesis transformation records.

The earlier approval closure changed only this canonical document. This
follow-up prepares the explicitly requested database reliability fix, not new
features. Program identities, source/IDL/ELF pins, financial semantics, custody
boundaries and transaction lifecycle guards remain unchanged. The unrelated
local resume helper and private historical fixtures remain excluded.

## Release-prerequisite follow-up — exact remaining inputs

### Existing custody and independent recovery

No tool-accessible public record identifies an existing selected config compatible
with creator `DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9`, mint
`2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn`, mainnet genesis and the exact
candidate profile. The original controlled-test manifest is explicitly
local-first, and its same-Mac recovery record is not independent production proof.

The owner must provide **public-only**:

1. Original BdAa custody reference and matching owner-local public-key result.
2. Existing selected-config public address, matching creator/mint/genesis/profile
   binding, profile/manifest digest, original browser origin/profile and public
   journal/vault ID or custody manifest path. It must be a distinct on-curve
   identity and its expected on-chain account must still be absent. No decrypted
   journal, ciphertext export, secret or new identity is requested.
3. Existing owner prefunder's public address and local custody reference. FhE is
   the intended intermediary/recipient, not an assumed available funding source.
4. Independent recovery on a separate owner-controlled device/trust domain for
   every required signer: expected and observed public addresses, match result,
   date, device/control description, backup reference and helper hash. Recover
   locally and derive public addresses only; no test signing or secret transfer.

### External-token source/build evidence — corrected representation

The immutable public repository commit is
[`BordrlessDex/bordrless-programs@be0f9feb5503d246f3d71d7d641cc325c8ec2e08`](https://github.com/BordrlessDex/bordrless-programs/tree/be0f9feb5503d246f3d71d7d641cc325c8ec2e08),
tree `38f27df7fb771bbb10299f9e4f41fa18af4de6f1`. The committed `Cargo.lock`
Git blob is `303a70189a6852f7c7db9a280109d15e683af81d`.
Its README pairs token `2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22`
with canonical executable SHA-256
`ec9d9f528be0fa7e301e476e6e6a19ec79332fa45dc4e6bccd9f26f5355e5152`.

Observed raw `7aa07…` is 326,504 bytes. Removing 15 terminal zero bytes gives
326,489 bytes and exactly that canonical hash. **Do not call these two hash
representations a code mismatch, replace the raw artifact, or change its pin.**
The public [Osec status](https://verify.osec.io/status/2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22)
returns that same on-chain hash but `is_verified:false`, with no repo/commit
verification record. The README claim is not our completed independent build.

The documented build uses default token features, **not** the local fork's
`production` feature: Linux x86_64, Agave 4.3.0, platform-tools v1.57, SBPF v3,
Anchor 1.2.0, locked dependencies. The public verifier image tag currently resolves
to amd64 digest `sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd`.
The historical README pins a mutable tag, and the source commit is unsigned.

A private source download was retained briefly (archive SHA-256
`5b3357b7b3a66762e15883a8415049023a56d3ca310d9a763f9f55a12e050a92`),
but extraction failed with `ENOSPC` before any build. The new image pull was
cancelled; only that new archive was removed, and this request's public
preflight/unsigned packet were losslessly compressed to recover space.
No old source, private fixture, wallet or deployment candidate was replaced.
Default/orbstack Docker sockets were unavailable; the existing hooks-only daemon
was initially reachable, then metadata/help/guest free-block-trim commands timed
out. No daemon/VM was restarted and no broad image/data pruning was attempted.

To finish the **external-token build only**: restore adequate local disk/VM
availability (20 GiB free headroom is a recommendation, not a measured unpacked
image requirement), then separately authorize only the no-upload pinned build and
compare the **trimmed executable** hash. This build/download was not resumed by
the PostgreSQL recovery approval. Prevent build-time keypair generation; no new
identities are authorized. Alternatively obtain a complete independent attestation
binding exact source/tree/lock/features, image/toolchain digests, invocation,
live program/deploy slot and canonical hash. Do not run `verify-from-repo` or
any upload/signing command.

### PostgreSQL correction and verification boundary

`src/hooklab-database.mjs` reuses the existing error-listener pool wrapper.
Nine existing route/runtime/bootstrap constructors use the common bounded policy:
5-second connection/checkout, 2-second lock, request statement/client 4/5 seconds,
runtime statement/client 14/15 seconds, idle transaction 30 seconds.
The explicit runtime profile preserves the previous 15-second allowance.
Startup options cannot be overridden by URL parameters or `PGOPTIONS`.
No lifecycle claims, retry rules, auth, ownership, sender or activation flags changed.

`tests/hooklab-database-timeouts.test.mjs` uses real disposable PostgreSQL plus a
nonresponsive loopback PG handshake. Initial pre-fix run: 0 pass/2 fail; initial
post-fix run: 4 pass/0 fail. A separate actual SQL/HTTP smoke measured checkout
5,002 ms, idle SQLSTATE `25P03` at 30,012 ms, rollback and connection replacement,
and production responses 404/409 with the local wallet flag set.

Independent review found the quota test could pass before SQL. Its correction
observes an actual PostgreSQL waiter and asserts `55P03` under the same held lock.
The fifth regression exercises a six-second runtime write and subsequent
14-second server cancellation with rollback.

After explicit owner approval, only these three caches were deleted:
`~/.npm/_cacache`, the app's `.next/cache/webpack`, and
`.next/dev/cache/webpack`. Their measured allocation totaled 1,734,184,960 bytes.
The recovery-only operating gate was **1,073,741,824 bytes free on the Mac**;
the achieved pre-start free space was **1,866,874,880 bytes**. This is not a
claimed physical minimum or permission for a compiler-image pull. A full stack
restart remains separately gated on 2 GiB free on both Mac and VM.

PostgreSQL 17.11 was started with its unchanged data directory and loopback port.
Automatic WAL recovery completed. Startup warned while replaying a DROP for the
already-absent OID 68048 directory; no existing database directory or WAL was
deleted to work around it. All six pre-existing database OIDs remain unchanged,
and all six accepted signatures/original finalized slots match retained evidence.
Accepted operation-row fingerprints are identical before and after verification.
This is a scoped preservation check, not a full physical database-integrity scrub.

**Final post-review run: 5 tests passed, 0 failed, 0 skipped**, in 33.611 seconds:
`node --test tests/hooklab-database-timeouts.test.mjs`, under the retained
loopback-only sandbox/accepted-endpoint denial wrapper. The final separate actual
SQL/HTTP smoke passed: checkout **5,003 ms**, idle SQLSTATE `25P03` at **30,007 ms**,
rollback and replacement connection verified, and production HTTP **404/409**
with the local wallet flag set. No signatures or RPC submissions were generated.
All six existing database IDs and accepted operation fingerprints are preserved;
the tests/smoke left no scratch databases.

The earlier no-database subset also passed 11/11; syntax checks passed for all
11 changed code/test files, and eight ELF copies plus both public IDLs retain
their pins. Final evidence is private in `postgres-five-after-recovery.private.tap`,
`timeout-smoke.private.json`, and `database-preservation-*-tests.private.json`.
Pre-recovery smoke evidence was retained separately, not overwritten.
The PostgreSQL regression blocker is resolved. This is not a replay of browser
financial acceptance and does not authorize public activation.

Before public activation, also verify the actual production database topology
accepts the startup GUCs and reports the intended bounds; pooler compatibility
is untested, not a demonstrated defect. A chosen custody adapter must have a
bounded response below the 30-second idle limit and preserve unknown-signature
recovery. No new adapter or relaxed timeout path is introduced here.

### Unsigned packet and readiness split

Private evidence root:
`hooks-local-state/release-prerequisites-20261018/`.
`packet/core-unsigned.private.jsonl.gz` losslessly preserves all **1,650** messages;
uncompressed SHA-256
`f6df6a5bdd2c3ea5cae9a93287d228d9bef2f5fb5ec308accc2f220435178489`.
The independently decoded messages reserve every required signature slot, all
zero; maximum complete serialized size is **1,232 bytes**, with contiguous
830/606/207 writes and exact retained identities/authority/buffer placement.
`fresh-independent-preflight.private.json.gz` preserves the original rejected
snapshot; `fresh-reader-boundary.private.json` preserves the successful
814-ms recollection and the three changed shared accounts. Compression does
not make the old blockhash or state fresh.

The proposed **4.176442240 SOL** capital ceiling is unchanged. Independent review
reconciled 1,650 core messages plus at most 25 additional messages/39 signatures.
No extra retries, surcharge, identities or spending allowance were added.
The manifest remains explicitly a **core review subset**, not a final canary:
config/prefunder identities, post-upgrade deploy slots/controls, actual warm ALT,
absolute expiries and finalized buy/sell/collection state are still unavailable.
Regenerate each stage with fresh blockhash, dual-reader observations and fees;
never sign the expired review bundle or invent future amounts.

**Paused deployment/canary:** mechanics, core address placement, size and budget
have review evidence, but custody/recovery, source build attestation, final packet
and owner approvals still make this NO-GO. The bounded canary also requires its
separately approved temporary openings and verified restoration to closed state.
**Public trading:** additionally NO-GO for production topology/custody-adapter
checks and broader app release checks already listed above. The targeted
PostgreSQL regression is now resolved; the rest of the local stack remains
unrecovered under the owner's PostgreSQL-only approval. No merge, general
activation, compiler-image pull or production action is authorized.

## Primary references

- [Agave 4.3.0 CLI deployment/chunking implementation](https://github.com/anza-xyz/agave/blob/v4.3.0/cli/src/program.rs)
- [Agave 4.3.0 compute-budget construction](https://github.com/anza-xyz/agave/blob/v4.3.0/cli/src/compute_budget.rs)
- [Agave 4.3.0 loader Buffer drain and deploy/upgrade semantics](https://github.com/anza-xyz/agave/blob/v4.3.0/programs/bpf_loader/src/lib.rs)
- [Loader V3 state sizes](https://docs.rs/crate/solana-loader-v3-interface/7.0.0/source/src/state.rs)
- [Solana rent-exemption RPC](https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption)
- [Solana unsigned message-fee RPC](https://solana.com/docs/rpc/http/getfeeformessage)
- [Solana cluster endpoints and public-RPC limitations](https://solana.com/docs/references/clusters)
- [Allnodes PublicNode operator and endpoints](https://publicnode.com/)
