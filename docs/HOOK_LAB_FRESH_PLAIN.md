# Fresh guarded devnet plain-launch acceptance

The planner now adopts **fresh guarded devnet pins for read-only observation**, not an enabled
wallet flow. The public recipe planner still refuses executable quotes/signing/submission.
No module or operator command below loads a key, requests a faucet, signs or sends.
Mainnet, legacy execution, Kit, templates, trading, bridge execution and initial buys are disabled.

## Finalized one-off acceptance · 2026-10-15

The separately owner-approved disposable-wallet client signed and submitted **once** on devnet.
Signature: `42naDDDP4QcKK4ZkHyjGut9XrhDBKmDmjgZT5eHagF4mQx7T4GvQzjRb4rF6xcVsVroxsFZSG8xYZ9pYJsEHobkq`.
Finalized slot: **511377021**. Reviewed message SHA-256:
`b37e469ab2114c3623d78eca1334a2ee8a07f2d1d11d893d03185eb10ce8e1c0`.
Only the expired recent blockhash changed from the producer's package; all other message bytes and
deadline **511377611** remained unchanged. Fresh code/config inspection, exact fee/rent checks and
unsigned simulation preceded signing. Retained creator/mint custody had passed encrypted off-host
backup and process-reload restoration checks. No custody secret or signer is included in this release.

The finalized receipt and native accounts verified **32,870,000 lamports** payer debit: 10,000,000
treasury credit, 22,860,000 account rent, 10,000 network fee. Curve/reserve holdings are respectively
750,000,000 and 250,000,000 HLTEST; quote, LP supply and swaps are zero. All four mint authorities
are absent. This is not browser-wallet launch acceptance or general launch activation.

`src/hooklab-hltest-acceptance.json` retains the exact public preview/signature for recovery, never
resubmission. `/coins/hltest` shows the same mint after reload and explicitly confirms devnet before
`GET /api/hook-lab/acceptance?confirmedNetwork=devnet` re-verifies receipt and current native accounts.
The API accepts no alternative message, signature, mint or RPC. An unavailable/mutated/traded state
refuses acceptance; it never creates a replacement mint. The planner and direct adapter also inspect
the fresh deployment. No active consumer path falls back to legacy swap/launch IDs.

`src/hooklab-fresh-deployment.json` pins finalized slot 511377577 and the post-acceptance config
hashes with counters exactly one. Observation-only inspection can match these existing accounts;
it always returns `readyForUnsignedSimulation:false`. The original acceptance inspector still
requires unused configs/accounts and refuses a second launch. Changed counters, config bytes,
economics, ELF, authorities or dependencies fail closed until separately reviewed.

Producer final evidence archive SHA-256:
`ee879433422907d17b79d0956c6cbaa92560c344df496ea62c6945945d66c76d`.
Exact full ELF hashes are swap `bd1d72271d7c2ef7636ad7f6917262e3003b0cc171f68ebf0658e2de55422482`
and launch `c63e41d531b957a36148ede41952fbab0c5a42b29e06d0e8da5346555110d3d4`.

## Exact candidate and identities

The producer's frozen source revision is `f3c57ccc15f327a65f447f51b6f4b61833de78b7`
(a transferred local commit, not a claim of publication). Archive SHA-256:
`9334958c3920cd8bfd7ad2c57519e9aec33071715fb5e6d8cb520d4b357f3e26`.
The immutable candidate manifest SHA-256 is
`1a0ee482d83587f80af790729733e662ce39096e078b5a18c4e5c7514d7682d4`.
Its historical `NOT-DEPLOYED-NOT-ACCEPTED` label is preserved, not overwritten by observations.

| Role | Devnet identity |
| --- | --- |
| Swap | `8tWHu3srJXpZPi3eP7CQk7intQTMzGKUxk3kU2Eedk1U` |
| Launch | `54mcNnfUgrnw7ZjuLqY547Rkf5nSqMLHqYTrBK3GVyea` |
| Upgrade/config authority, treasury, fee collector | `FFZMVjia7xD43EiWNBSKBiujL65hLbBJPdRg1GtE8He6` |
| Disposable creator, distinct from treasury | `DBr3Qxa5LgkJCRZb7uwXwmBau36kzgFrnXgu5vNhux7B` |
| Retained acceptance mint | `89oRwzQmrYCL3r6eCwo6Rk6h52S5ajxjan9gRgx6MbWR` |
| Genesis | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |

`@repo-ing/hooklab-guarded-candidate` has fifteen exports, including only the guarded
plain creation builder, account decoders, address/rent/budget/hash helpers and integrity-checked
manifest reader. It deliberately omits the producer's admin-init helper and all send/sign,
legacy builders, trading and Kit APIs. The original read-only package remains an archived artifact,
not an active inspection or execution fallback. The historical hypothetical swap model is not used
for fresh launch quotes.
Rebuild with `node scripts/vendor-hooklab-readonly.mjs <exact-source-checkout> fresh-candidate`.
The source's sibling `candidate/candidate-manifest.json` is required. Install the source SDK's
frozen lockfile and build it first. Provenance records every packaged IDL/file and dependency notice.
**Generic economics helpers default to legacy IDs: always pass fresh config AND program explicitly.**

## Operational sequence

1. Retain encrypted creator/mint custody and verify recovery from the project secret after process
   refresh. Keep secret material out of logs, Git, requests and this evidence package. Retire/delete
   disposable keys and their secret backup only after final verification; never reuse them.
2. Obtain producer-confirmed finalized ProgramData slots, exact ELF hashes, config bytes/hashes and
   deployment/config signatures. Do not infer success from a partially uploaded buffer.
3. Create a reviewed public `deployment.json` with schema `repoing/fresh-plain-deployment/1`,
   `sourceCommit`, `manifestSha256`, `finalizedSlot`, and `swap`/`launch` objects containing
   `deploySlot` and `configSha256`. No zero/example slots or hashes are accepted as live evidence.
4. Read the fresh candidate. One finalized bank contains all executable, config, quote, ALT, creator
   and creation-account checks. Owner, discriminator/version, authority, ELF, deploy slot, config
   hash, explicit economics commitment, unused counters, quote and ALT drift all fail closed.

   ```sh
   node scripts/inspect-hooklab-fresh.mjs inspect --confirm-devnet deployment.json
   ```

5. Obtain the producer's **refreshed** `acceptance-preview.json` in its original format. Reconstruct
   it independently and compare bytes, decoded accounts/instructions, two signers, fees and rent.
   The committed historical fixture is only for offline tests, never submission.

   ```sh
   node scripts/inspect-hooklab-fresh.mjs verify --confirm-devnet acceptance-preview.json
   node scripts/inspect-hooklab-fresh.mjs simulate --confirm-devnet acceptance-preview.json deployment.json
   ```

   Simulation rechecks finalized deployment, blockhash validity/height, deadline, exact message fee,
   every rent size, creator balance and maximum 32-slot observation age. It uses zero signatures,
   `sigVerify:false`, and **does not replace the blockhash**. Its result is not signed acceptance.
   RPC is trusted; code can upgrade after observation, and native creation guards do not pin ELFs.
6. Present the exact current package before the separately authorized signing step. A future
   wallet flow must retain reviewed bytes, verify returned signatures/message unchanged and persist
   an immutable submission journal before sending. There is no signer/submission implementation in
   this candidate. Do not treat `canSign:false` as an activation flag to change in a caller.
7. After an authorized send, recover using the retained mint and exact reviewed preview:

   ```sh
   node scripts/inspect-hooklab-fresh.mjs recover --confirm-devnet acceptance-preview.json SIGNATURE
   ```

   Missing finalized receipt means unresolved, not permission to relaunch. Recovery checks the exact
   message, payer debit, treasury credit, every creation rent delta and finalized custom-token
   mint/launch/pool/holding state. A changed/traded pool refuses this initial-acceptance contract.
   Record program/config re-verification after acceptance as well. Then test browser recovery/display;
   a CLI recovery result alone is not evidence of a completed wallet UI flow.

## Economics and custody disclosures

Exact recipe: name **Hook Lab Devnet Acceptance**, ticker **HLTEST**, empty URI, zero creator fee,
no rule blocks/template/custom hook. Virtual quote **1,000,000,000 raw** is curve math, **not deposited SOL**.
Bridged SOL quote is a custom Hook Lab token, not SPL WSOL; this flow never calls the bridge.
The frozen creation cap is 32,860,000 lamports (10,000,000 launch fee + 0 nested pool fee + 22,860,000 rent).
Network fee is separately 10,000; priority is zero; total is **0.032870000 devnet SOL**. Any drift refuses
and requires a revised approval, not automatic cap enlargement. This is not the deployment budget.

Supply is 1,000,000,000 tokens at six decimals: 75% goes to the curve vault, 25% to the launch reserve.
Initial real quote and LP supply are zero. The empty LP holding belongs to the launch PDA; do not claim
LP burned, a creator-owned position or an external LP lock. Metadata/mint/freeze/hook authorities are
absent after creation. The DEX programs remain upgradeable, config administration is broad, and legacy
entrypoints remain on-chain even though repo.ing does not expose them. Plain-only is a consumer limit,
not a global on-chain canary restriction. Launch-pool LP fees route to protocol, not external LPs.
The config also contains 30 bps LP fee and an 8,000 bps initial sniper fee over 30 seconds; trading is
not enabled by this acceptance. repo.ing is the interface; **Hook Lab DEX** supplies the native programs and ABI.

## Production rollout remains gated

Before Railway: finalize signed devnet acceptance, verify recovery/display, publish the exact fresh
source provenance, approve consumer adoption, merge the consumer PR with required CI, authenticate
Railway, and verify a recent encrypted database backup by decryption/listing and disposable restore.
Migration `0077` is already in recipe/custody; web pre-deploy runs migrations, so backup precedes web.
Run only the separately reviewed main revision using the existing deployment mechanism:

```sh
git fetch -q origin
git show origin/main:scripts/ops/deploy.sh | bash -s -- <reviewed-seven-character-main-sha> web
```

This consumer release changes web only; no worker restart is needed. If an independently reviewed
pending worker release is included, deploy web before worker. Inspect all pending migrations,
especially `0076` and `0077`, rather than assuming the production journal is current.

Do not substitute the candidate branch or claim pushing deploys Railway. See [PRODUCTION.md](PRODUCTION.md)
and [BACKUPS.md](BACKUPS.md). No mainnet identities, approvals, release budgets or mainnet activation are
supplied here. Security/governance review and network-specific dependencies are separate NO-GO gates.

## Mainnet-readiness delta · disabled, not an activation plan

- Separate immutable network manifests must pin the genesis, all dependency programs/ProgramData,
  reproducible ELF/IDL/source hashes, config commitments, quote mint and ALT. Never derive mainnet
  addresses or token support from this devnet candidate. No mainnet RPC is needed for this work.
- A public wallet flow still needs connected-wallet/network binding, explicit identity/economics and
  recipient review, full rent/network/priority cashflow caps, exact unsigned simulation, reviewed
  message/signature validation, expiry and a durable same-mint recovery journal. This release has no
  public signing/submission implementation; the one-off acceptance client is not such a flow.
- Enforce creator allowlist/quota/expiry and legacy-route refusal on chain, not merely in the UI.
  Separate creation/trading gates and pause-only guardian from delayed admin/unpause. Fresh devnet
  programs do not establish these controls. Independent security and governance approval is required.
- Establish production custody/restore ceremonies with independently controlled upgrade/admin,
  guardian and treasury identities. A public key or offline governance policy is not deployed control.
- Monitor program/config drift, quote/dependency changes, debit mismatches, unresolved submissions,
  finalized indexing lag, recovery failures and RPC availability. This release emits bounded recovery
  outcomes only; production alert routing, pause ownership and incident drills remain owner gates.
- Railway deployment is a separate approval from chain activation. Require exact reviewed source,
  required CI, authenticated access, current encrypted DB backup plus disposable restore, web-before-
  worker rollout and read-only smoke tests. Mainnet funding/signing/writes/deployment stay NO-GO until
  a separately reviewed dossier supplies exact messages, budget, approvers and activation scope.
