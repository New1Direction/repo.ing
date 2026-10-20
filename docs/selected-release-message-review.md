# Selected release message preparation — NOT SIGNABLE

`scripts/hooklab-selected-release-message.mjs` prepares one offline **unsigned legacy
message review candidate**, not a signed transaction or release approval. It is not
the missing historical `final.sh`, an acceptance runner, or a custody integration.
The requested READY FOR OWNER SIGNING milestone is **not established** by this tool.
The nongate local application acceptance now passes; current production public
inputs, candidate adoption and independent message review remain blockers.

## Interface

Exports: `prepareSelectedReleaseMessage(envelope, { nowMs })`, `digestJson(value)`,
`sha256(bytes)`, `SELECTED_PROGRAMS`, `UNMET_PUBLIC_INPUTS`.
`nowMs` defaults to the current wall clock; override only for deterministic tests.
Invalid inputs throw; the CLI converts failures into a null message and exit 2.
Successful CLI preparation also exits 2 because signing is still blocked.

```sh
node scripts/hooklab-selected-release-message.mjs < owner-public-envelope.json
node --test tests/hooklab-selected-release-message.test.mjs
```

Only stdin JSON is consumed. No file paths, key discovery, RPC, signing, buffer
creation/upload, account extension, deploy/init/freeze/activation or submission.
Never pipe secrets or keypair files. Output contains exact message base64 and its
SHA256, required signer order and estimated fee; `canSign` and `canSubmit` are always
false and `signingGate` is always `NOT SIGNABLE`.

## Public envelope contract

Use `schema: "hooklab-selected-upgrade-review-v1"`, `inputs`, and
`approvedInputsSha256`. The latter is SHA256 of recursively key-sorted compact JSON
of **all** `inputs` (`digestJson`). Obtain that digest through a separately reviewed
public-input approval process, not by treating the builder's ability to recompute it
as approval. This is an integrity binding, **not authenticated owner consent**.
No offline tool can prove an RPC export, balance, approval or wall-clock assertion
is authentic/current. Re-export and review immediately before any future signing.

The test fixture in `tests/hooklab-selected-release-message.test.mjs` is the complete
executable shape reference. Its synthetic ELF, accounts, hashes and timing are
test-only and must never be used as release inputs. All these fields are mandatory:

- `programName`: launch or swap; identities pinned in `SELECTED_PROGRAMS`.
- `cluster`: mainnet-beta; `genesisHash`: exact mainnet genesis hash.
- `source`: full 40-hex `commit`, `tree`, `clean: true`; nonempty `sourceManifest`
  mapping reviewed source paths to full SHA256; `sourceManifestSha256`; `features`
  mapping program name to exact feature list; `featuresSha256`. Manifest hashes use
  `digestJson`. Caller must supply the complete reviewed source scope; this tool
  cannot prove scope completeness or reproduce the ELF from it.
- `snapshot`: finalized `commitment`, nonempty public `providers`, `slot`,
  `observedAtMs`, `maxAgeMs` (positive, at most 300000).
- `program`, `programData`, `buffer`: `address`, loader `owner`, boolean
  `executable`, exact `dataBase64`, full `sha256`, decimal-string `lamports`, and
  `slot` matching snapshot. ProgramData is independently PDA-derived from the pinned
  program and loader; Program must link to it. Loader discriminants, deployment
  slot, authority options/bytes and executable flags are decoded and checked.
- `deploymentSlot`, `capacity`: exact decoded ProgramData slot and payload capacity;
  no same-slot upgrade or implicit extension. `authority`: explicit public upgrade
  authority, matching ProgramData and buffer. `approvedBuffer`: independently
  reviewed existing buffer public address (buffers have no universal derivation).
- `elf`: exact `dataBase64`, `length`, full `sha256`. Entire raw ELF including any
  intrinsic trailing zeros is compared byte-for-byte with the buffer prefix.
  `bufferPadding: "zero"`, `bufferPaddingBytes`: exact extra padding after raw ELF;
  nonzero or unexplained extra bytes rejected. ELF magic checked; executable/build
  correctness and pinned inventory comparison remain external review duties.
- `payer`: public `address` and decimal-string `lamports`; `spill`: public address;
  `approvedSignerOrder`: exact payer then upgrade authority. This conservative v1
  requires distinct payer/authority/spill/buffer/program/ProgramData and no reserved
  account aliases; equal-role signer deduplication is deliberately unsupported.
- `rent`: decimal-string `programDataMinimumLamports`, `bufferMinimumLamports`,
  exact `programDataLength`, `bufferLength`, `additionalPayerDebitLamports: "0"`.
  Buffer must be rent funded; combined ProgramData/buffer funds must cover exported
  post-upgrade rent. Minima are owner-approved exports, not locally RPC-calculated.
- `fees`: integer `computeUnitLimit`, `maxComputeUnitLimit` (at most 1400000);
  decimal-string `microLamportsPerUnit`, `maxMicroLamportsPerUnit`,
  `lamportsPerSignature`, `maxTotalLamports`. Fee is two signatures plus rounded-up
  CU-limit priority fee. Require current fee-rate verification externally.
- `blockhash`: `mode: "recent"`, `approved: true`, exact public `value`,
  `observedBlockHeight`, `currentBlockHeight`, `lastValidBlockHeight`,
  `observedAtMs`, `expiresAtMs`. Height and time must both remain valid within the
  freshness window; never silently refresh. Durable nonce is explicitly rejected
  in v1 rather than implying safe nonce serialization/simulation support.
- `sequencePolicy: "one-upgrade-stop-and-reexport-before-next"`.

Instruction sequence is only ComputeBudget limit, ComputeBudget price, then one
UpgradeableLoader Upgrade (tag 3): ProgramData(w), Program(w), Buffer(w), Spill(w),
Rent, Clock, authority(signer). No lookup tables or arbitrary instruction input.
Tests parse wire bytes independently, including signer/writable flags and ordering.

## Unmet current inputs and external gates

No current release envelope was supplied or generated in this task. Local source,
feature and reproduced ELF inventories exist in the contract checkout's
`docs/selected-hook-release-preparation.md`; owner adoption is still required.
The real nongate browser/validator lifecycle passed 7/7 and separate exact-message
and stale-review refusal acceptance passed 2/2. See
`scripts/e2e/hooks-native/SELECTED-ACCEPTANCE.md`; these are loopback-only results,
not current production evidence or support for arbitrary fee hooks. Still needed:
approved source/features/full ELF inventory; current finalized
cluster/genesis/provider/slot-stamped Program/ProgramData exports; existing approved
buffer identity, exact payload/padding and authority; public payer/spill/authority
and signer order; current balances/rent/fee/CU decisions; fresh approved blockhash
and expiry; release acceptance and owner adoption. Then
independently decode/review the exact message hash, simulate against current state,
and recheck all inputs before custody. Signing/submission remain separately reviewed
future actions. The tool cannot remove these gates even if extra acceptance flags
are supplied. No real release message or authorization was produced by its tests.
