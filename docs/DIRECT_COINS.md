# Direct coins: compatibility and architecture decision

Decision recorded 2026-10-15, before transaction implementation. repo.ing is the
product surface. **Hook Lab DEX** is the programmable venue; this is not a claim
that repo.ing created or owns a new DEX. Existing repository/model markets are
unchanged. Programmable Coin means launching and trading the creator's own
Bordrless-style native coin through Hook Lab programs inside repo.ing, **not a
Hook Lab platform token**. `/coins/new` currently implements planning and reads
only; native launch and trading execution are future, separately gated work.

## Primary-source compatibility matrix

| Venue | Token standard / hooks | Quote and curve | LP and fees | This increment |
| --- | --- | --- | --- | --- |
| Raydium LaunchLab (Standard default) | SPL base via InitializeV2; dedicated InitializeWithToken2022 supports Token-2022 and optional transfer fees. No general Hook Lab callback support. Deprecated Initialize always fails. | GlobalConfig fixes quote, curve type and limits; PlatformConfig may narrow allowed configs/parameters. New launches graduate to CPMM. | PlatformConfig sets LP disposal, not a per-launch switch. Current CPMM migration combines creator/platform locked shares under platform Fee Key ownership and burns remainder; do not promise creator ownership. Read protocol/platform/creator/migration fees live. | SPL, wrapped SOL, config-controlled curve and LP policy planning only. Official SDK pinned to 0.2.74-alpha; no approved GlobalConfig/PlatformConfig supplied. |
| Meteora DBC → DAMM v2 (advanced) | SPL and dedicated Token-2022 metadata flow. DBC has a separate TransferHook config/pool/swap path, but revokes hook program AND authority at completion. This is not Hook Lab's native standard. | Supported quote mint and curve belong to approved DBC config. Token-2022 quote fees must be zero, including scheduled fees; extensions may require a badge. | Config controls fees, vesting, partner/creator position allocations and locks. Never equate a DAMM position NFT with an SPL LP burn. | Existing official DBC SDK 1.5.13 retained; no direct-coin config approved. |
| Meteora DAMM v2 (advanced direct liquidity) | SPL; permissionless Token-2022 allowlist: transfer fees, metadata pointer, token metadata, TransferHook only with program AND authority unset. Badges admit other mints but **do not provide general active-hook account forwarding**. | Requires two supported mints, actual deposits, price/liquidity and approved fee configuration; no launch bonding curve. | Position ownership, fee claims, permanent/time locks need explicit review. No blanket burn/lock promise. | Official cp-amm SDK 1.4.10 retained. Read-only identity / planning, not pool creation. |
| Hook Lab DEX (Programmable) | Native Bordrless mint/holding standard, **neither SPL nor Token-2022**. Native token callbacks on transfer/mint/burn and pool callbacks on swaps/liquidity. One token hook: Kit OR Half-Life OR another supported hook. | Bridged SOL native mint; constant product with virtual offsets, not deposited SOL. Config sets supply/decimals/curve bounds. Default virtual quote 28.125 SOL is not a quote or a funding requirement. | Launch PDA holds LP permanently; not a user burn option. Creator fee applies both directions; hook cuts and burns compose with protocol fees. Historical setup sniper fee 80% for 30 seconds, first creator self-buy exception. | Experimental devnet beta. Plain, Kit max-wallet and fixed Half-Life intent validation; finalized deployment/config inspection. No arbitrary hooks, lottery, companion execution, bridge deposit or swaps. |

Official sources fetched 2026-10-15:
- [Raydium instructions](https://docs.raydium.io/products/launchlab/instructions),
  [SDK examples](https://docs.raydium.io/products/launchlab/code-demos),
  [program addresses](https://docs.raydium.io/reference/program-addresses).
  Documentation includes some inconsistent generic precondition prose (for example
  open_time beside an argument list without it). Builders and actual decoded
  configs, not prose alone, must govern future transactions.
- [Meteora DBC standards](https://docs.meteora.ag/core-products/dbc/token-2022-support),
  [hook lifecycle](https://docs.meteora.ag/core-products/dbc/transfer-hook-pools),
  [DAMM v2 standards](https://docs.meteora.ag/core-products/damm-v2/token-2022-support).
- Hook Lab origin/main at
  [ee7234c](https://github.com/New1Direction/hook-lab/commit/ee7234cb7a32781fecba5470f24f43233cf94167):
  `scripts/fork/ids.devnet.json`, `deployments/devnet.json`,
  `deployments/devnet-verification.json`, `docs/beta-runbook.md`, `docs/hooks-v2.md`,
  `programs/bordrless_launch/src/{state.rs,instructions/launch.rs,instructions/graduate.rs}`,
  `programs/bordrless_swap/src/instructions/swap.rs`,
  `sdk/packages/launcher/src/{plan.ts,chain.ts}` and SDK instruction builders inspected.
  The fork SDK is private workspace version 0.8.0. The public npm package currently
  has a different version: **do not substitute it for this fork**. Hook Lab's
  adapter uses the subsequently approved integration artifact described below,
  not hand-written transaction encoding or public npm defaults.
  Before shipping, origin/main was rechecked at
  [64797b0](https://github.com/New1Direction/hook-lab/commit/64797b067c2c331a7b330ff1c3cccf2e96ed8705):
  only the release-review document changed; contracts, SDK, deployment records and
  beta runbook are unchanged. Its updated review still blocks real funds on
  single-key custody, dev-buy budgeting, recovery/keeper and supply-chain gates.

Hook Lab's repository is private; the source links above require access. repo.ing's
repository is public. Publishing these Hook Lab-derived details requires owner
approval of that disclosure, separate from any chain-action authorization.

## Decision and custody boundary

Use separate adapters with one contract: capabilities, preview, devnet inspection,
and an explicitly refusing transaction builder. No API accepts serialized
transactions, keys, seed phrases, RPC URLs or arbitrary program IDs. The new
surface never calls a signing, send, faucet, deployment or pool-creation method.
There is no environment toggle that enables execution. Network confirmation is
required even for public devnet reads; mainnet is refused server-side.

Preview means intent and disclosures, **not** a price quote or RPC transaction
simulation. Report unknown amounts as unknown, not zero. Standard adapters check
genesis, slot, owner, ProgramData and upgrade authority only; executable account
detection proves neither binary identity nor safety. Hook Lab additionally checks
the approved deployment hashes, raw IDLs, config identities, quote wrapper/mint and
exact lookup-table order at one finalized slot. Neither inspection approves economics.
Hook Lab's pinned manifest records a single upgrade/admin/treasury key
`HUZSwDaS7u7bfqrrhDUjCVoi6xCVDDXZhM6snvJ3YQdG`. Its bridge holds underlying assets
in program custody; holders receive native claims. Program upgrades remain a
custody risk even when mint/hook authority is revoked and LP is PDA-locked.
repo.ing holds no user assets or signing keys in this path. GitHub sign-in identifies
draft ownership only; it proves neither wallet authority nor project endorsement.

Future transaction work must pin approved SDK and config identities; decode all
economic/authority fields; reject stale/mismatched state; show every instruction,
signer, account, asset debit, fee recipient, slippage bound and non-atomic step;
simulate the exact message; then ask the connected wallet to sign client-side.
No server signer and no seed entry. Wallet/network changes invalidate review.
Signed bytes must not enter drafts, analytics or logs. Approval to ship this preview
does not authorize any such chain action.

## Approved Hook Lab integration v1 adoption

The Node-only package `@repo-ing/hooklab-readonly` is vendored from the approved
[delivery revision](https://github.com/New1Direction/hook-lab/commit/9b3473e001a9abc73bf644d4206e47abc95a815b).
Its manifest SHA-256 is
`3e904e1030f581d8b79879aaf43a5f3c9d20f63979008c2e4b0799581e14e403`.
The manifest's `sourceCommit` still denotes the
[beta.2 ABI/deployment baseline](https://github.com/New1Direction/hook-lab/commit/ee7234cb7a32781fecba5470f24f43233cf94167),
not this delivery revision. No other upstream app, CLI or transaction changes are adopted.

Six exports only: `integrationManifest`, `integrationCompatibility`,
`integrationIdlRefusals`, `inspectDevnetIntegration`, `integrationCapabilities`,
`previewHookLabIntegration`. Even the upstream refusing builder is not exported.
`@solana/web3.js` stays external at exactly 1.98.4. Next externalizes this package
and traces its manifest and all 11 byte-preserved IDLs. It must not run in a browser
or Edge runtime. `.npmrc` installs file dependencies as copied packages, not
symlinks: Turbopack would otherwise rewrite asset-relative URLs. The vendored
`dist` is explicitly retained in Git and Railway uploads. No private repository
credentials are needed by `npm ci` or CI.

Rebuild from a clean checkout at the delivery revision, using Node 22.14.0 and
pnpm 10.20.0:

```sh
pnpm -C /path/to/hook-lab/sdk install --frozen-lockfile
pnpm -C /path/to/hook-lab/sdk build
node scripts/vendor-hooklab-readonly.mjs /path/to/hook-lab
npm ci
node --test tests/hooklab-readonly.test.mjs tests/direct-coins.test.mjs
```

The script pins esbuild 0.25.12, verifies source revision/manifest, records file
and SDK lockfile hashes in `provenance.json`, and includes upstream LICENSE,
NOTICE, FORK, generated legal comments and full notices for every bundled
third-party package. Some npm tarballs omit license text: pinned source notices
and their provenance are retained in `scripts/licenses` and the generated notices.
Repeated local builds matched; cross-machine reproducibility is not asserted.

The consumer entry wraps `integrationManifest` with a raw-file checksum check
inside the external package; all other exports are upstream implementations. The SDK
checks raw IDL hashes before RPC, then validates eight deployed programs and four
intentionally absent ones, plus six decoded accounts. **Matched absence is not
execution support**: lottery and companion remain deferred despite deployment.
Wrong genesis, IDL/config/binary/authority/lookup-table drift and unavailable RPC
return refusals; there is no cached readiness verdict. The RPC remains a trust
boundary. Inspect again after state changes; a past slot is not a guarantee.

Plans preserve an explicitly entered creator fee (basis points). Plain, Kit
max-wallet and fixed Half-Life intent previews use the upstream parser and observed
launch limits. A missing fee or Kit limit produces no native intent; it does not
silently become zero or a plain coin. Old v1 drafts default these new nullable
fields to unknown. Kit rewards/locks are not configured by this form. Invalid
metadata or live fee/rule limits refuse the intent independently of deployment
matching. UI disclosures retain unknown total debit, rent, network fee, minimum
output and expiry; intent steps contain `messageBase64: null`.

There is **no approved deployed Hook Lab UI URL**. Do not use an orb portal as a
production handoff, import query-string plans, or forward credentials, RPC URLs,
program IDs or signing material across origins. repo.ing owns its lane/draft/API
surface; Hook Lab owns native protocol contracts, deployment records and its builder.

## Wallet-first UX audit and next safe increment

The existing production repository flow (`app/components/launch-form.jsx`) calls
`useWallet().connect()` before `prepare`, displays the returned costs in its inline
review, invalidates review on wallet change/expiry, signs client-side through the
shared provider, then submits to `/api/launch` for message/session checks and chain
verification. GitHub repository lookup is not GitHub login. `WalletProvider` and
`WalletButton` already provide discovery, reconnect, rejected connection, account
change and disconnect behavior. Reuse those components; do not invent a second
wallet account or use GitHub as launch authority.

The existing transaction review is inline, not a generic transaction-review
component. Its server-prepared launch session includes sealed mint-signing
material (`src/launch-sessions.mjs`); copying that custody design into Hook Lab
would violate its client-only mint/config custody gate. Its Wallet Standard
signer currently pins `solana:mainnet`. This increment only connects an address
through the shared provider; it never invokes that signer, checks a balance, or
claims the wallet is on devnet. Shared connection labels now distinguish an
address connection from network authorization. A future devnet signer needs
explicit supported-chain validation, not a label change.

Production `/coins/new` was reachable, but the link was buried below repository
launch content, the explainer opened the Standard default, and inspection demanded
GitHub. `/launch` now exposes explicit Standard and Programmable draft entries;
the explainer links to `/coins/new?lane=programmable`. Only the lane enum is read
from the URL, never recipe/RPC/program/credential data. Each lane retains its own
device draft, including migration of the previous single draft. Bare links resume
the last lane. Invalid/newer drafts are refused without automatic overwriting.
Reset is explicit and remains in the current lane. Account drafts are optional.

The UI presents Connect Wallet → Configure → Simulate → Review → Sign → Verify.
Only connection, configuration and public read-only inspection work. Wallet or
plan changes clear consent/observations, and late results cannot restore an old
observation. Simulation, executable review, signing and verification remain blocked
by **all six engineering gates**: client key custody/recovery; enforceable exact
debit/fee caps; immutable reviewed simulation bytes; blockhash/quote expiry;
durable per-step recovery/finality journal; and fresh hook-aware quotes/minimum
output. Signed beta acceptance and separate final approval still follow those
gates. A matching inspection is not simulation, authentication or launch readiness.

The Programmable lane now uses `repo-ing/hook-lab-recipe/1` around complete
`hook-lab/1` `{coin, blocks}` recipes. Six templates author this same contract;
template metadata never regenerates blocks on resume. Device/account storage,
import/export and SDK inspection retain order, unknown fields and null versus zero.
Legacy v1 plans remain untouched and convert only through an explicit action.
Unknown versions, duplicate JSON members and secret-bearing fields refuse.

Review found that the pinned SDK silently ignores some unknown coin/block fields.
The consumer therefore preserves them in storage but adds preflight refusals and
removes intent steps for unsupported fields. Never confuse lossless storage with
protocol capability. SDK semantic/live-limit checks still govern supported fields.

Adoption provenance: exact isolated recipe commit
`14e89b02897c2387f38ca5c410f337ebce8a17f4`, custody commit
`430644b6d3ed13fbf424217e2ee88bf2329822f4`, quote commit
`c5c3d0a7adc7c06cd1b46e5f244993c7b45307fa` were transferred from their author
threads (these were local, unpushed commits). The template prototype was recovered
from archived thread `T-01a13d99-5abb-7161-8cd1-ab0933dc0bb7`, Changes capture
`cap_01a13da04b5476ba92f61a072815107f`, not an invented upstream commit.
Consumer changes register the recipe SQL as migration 0077, test the installed
read-only SDK instead of a private checkout, and reject reserved secret fields.

Client-only custody creates/unlocks encrypted mint/config identities after a fresh
matching inspection, bound to wallet, serialized-envelope digest, devnet genesis,
manifest and observed program/config hashes. It creates no on-chain accounts.
Wallet/recipe changes permanently invalidate the opened journal. Keys, passphrases,
ciphertext, reviews and signatures never enter recipe storage or server requests.
Local retention is not backup: eviction, lost passphrase/device, XSS and rollback
remain risks. There is no signing API or executable review. Recovery observations
remain conservative: missing status is ambiguous, and finalized transaction success
does not prove account postconditions.

The quote model is adopted for offline regression/reference only. It covers swaps,
not creation. `/api/hook-lab` returns an explicit unavailable launch quote (422),
never hypothetical swap debit relabeled as launch economics. Trading is deferred.

### Minimum guarded launch and owner approval package

The next executable scope is devnet plain/Kit launch creation only, no initial buy,
wrap, swap or arbitrary hook. Native guarded V2 is owned on Hook Lab's separate
`feat/native-guarded-v2` branch. No V2 artifact or consumer pin is approved here.
Creation caps must cover launch AND nested pool fees, rent and instruction debit,
with canonical config-economics commitment and inclusive slot deadline. Network
and priority fees require a separate immutable-message budget. Do not fall back
to legacy instructions if a guard or capability is missing.

The producer's local, unpushed source commit is
`4734a6abbda338de857287662e4c4625d13575a9`, based on Hook Lab origin/main
`481d082f80fd1a379cb432c882c6fc4467b6b873`. The exact review archive was transferred
from [the V2 delivery thread](https://ampcode.com/threads/T-01a13f66-e19d-73c3-93e1-a72d374905aa),
not installed as a consumer dependency. Archive SHA256 is
`68a6fa454e668bbfe6e241c30db6fe1dfe4fd1d10426a3f34abf115a14da0ae3`;
all included checksums and the incremental Git bundle were independently verified.
It includes source, explicit candidate IDLs/builders, canonical vectors, ELFs,
test logs and `guarded-v2-acceptance.md`. These are undeployed review artifacts.

| Existing devnet program (proposed upgrade order) | ELF bytes | File SHA256 |
| --- | ---: | --- |
| Swap `3yJKNHzDC7JA979RJNqxKSyo1jt6kLcJNk9bjUuebLN2` | 460640 | `a75f886720a602703fa6a25065f703f53c0bb6ef0ad47723de907b46248ad2b9` |
| Launch `4CxedXkUfo6JLXSnzuxr2XA9xeXPsxQeR1xeTedhKMyd` | 588696 | `8fdc9b52a81cfe70310198fc273a756ce7a69c82cad38e399880b44138d77b04` |

The producer reports post-fix unsigned LiteSVM 8/8 and Rust libraries 49/49.
Consumer review independently reproduced the Python vectors and passed SDK
245/245 in an isolated exact-commit checkout. The bounded independent ABI review
also closed launch/swap error-origin collisions; that is not a full security
audit or signed acceptance. The packaged unsigned all-kit fixture used 327,683 CU
with a synthetic ALT; do not reuse the earlier 320k routed-kit ceiling or treat
fixture sizes as live message budgets. Current consumer program/SDK/manifest pins stay unchanged.
Upgrading either live program will intentionally make the old inspection refuse.

Before requesting owner deployment/signed acceptance, fill every missing item:

| Approval artifact | Current evidence / blocker |
| --- | --- |
| Native revision, ELF hashes, program IDs, IDLs and canonical hash vectors | Exact review package above; not deployed or approved for execution; current readonly pin unchanged |
| Exact payer/mint/config addresses and retained recovery identities | Client local identities supported; dedicated unfunded/devnet acceptance wallet must be selected by owner; backup flow not yet provided |
| Instruction fees, nested charges, all rent, network/priority fee, total capped budget | Unknown; offline swap model cannot supply launch costs |
| Exact message bytes, signers, blockhash/last-valid-height, config commitment/deadline | Not constructed; requires approved deterministic V2 builder and fresh state |
| Simulation/postconditions and tamper/expiry/rollback tests | Producer's unsigned SBF evidence in package; no consumer RPC transaction simulation or signed acceptance |
| Recovery/export and ambiguous-submit journal test evidence | Local encrypted CAS journal tested; no sender/retry/postcondition adapter or backup UX |
| Deployment and signed acceptance commands | Package acceptance document specifies swap-before-launch existing-ID upgrades and separate acceptance; payer, buffers, extension bytes and maximum spend remain owner decisions |

Ship source through required checks first. Production web/migration deployment and
any devnet program deployment/signing/spending remain separate owner gates. Recheck
encrypted recoverable backup and pending journal before applying 0077. Never use a
funded production wallet or faucet as an implicit part of acceptance.

## Operator runbook

- `0077_hook_lab_recipes.sql` adds separate text-backed recipe drafts and atomic save
  events, not a reinterpretation of `direct_coin_drafts`. Ten account recipes,
  64 KiB each, 30-day retention. Client UUID/revision retries deduplicate without
  extending expiry; stale/different-owner writes fail 409. `/api/hook-lab` exposes
  optional authenticated `GET`/`save`, anonymous consented `inspect`, and refusing
  `quote`; all other actions fail. No wallet identity is accepted as account auth.
  The nested JSON string transport preserves duplicate-member detection. Inspection
  shares the existing per-client limiter; telemetry logs action/outcome/latency only.
  Unavailable account storage must not block device drafts or public inspection.
- Additive migration `0076_direct_coins.sql` adds private versioned drafts and audit
  events. Apply only to disposable local data during verification. Shared DB
  migration/deployment needs separate approval.
- `GET /api/direct-coins` lists the signed-in user's drafts and their latest 50 audit
  entries. `POST` accepts only `save` or `inspect`, a strict plan, and (on save)
  draft ID/revision. Stale revisions return 409. Draft + audit writes are atomic.
  Account saves require same-origin, encrypted existing GitHub session, account
  quota and bounded bodies. Public inspection requires same-origin, explicit devnet
  confirmation and the existing per-client request limiter (burst 4, refill 2/minute
  per web process). Like other public launch reads, this limiter is not authentication
  or a distributed RPC budget. Inspection needs neither GitHub nor a database.
  Signed-in inspection attempts optional account auditing; `audit` is `recorded`,
  `unavailable` or `not-requested`. Storage outages do not block public reads; account
  saves still fail closed. No existing market or launch session is touched.
- Browser autosave is device-local and untrusted; server save is explicit, requires
  sign-in and revalidation. Avoid entering confidential content. Clear browser
  draft with Reset. Server drafts/events expire after 30 days; prune on each write
  and schedule the SQL below in the normal operator retention job if idle.
- `DIRECT_COINS_DEVNET_RPC_URL` is a server-only read endpoint, defaulting to public
  devnet. It must return devnet genesis; existing `SOLANA_RPC_URL` is never reused.
  Bounded RPC timeouts, no automatic 429 retries, no user-selected endpoint.
- Privacy-bounded telemetry: structured `directCoin` events carry action, adapter,
  outcome, optional audit status and latency only. Private audit records contain validated plan snapshots
  and SHA-256 digest, never sessions, keys, wallet addresses or signed payloads.
  Aggregate audit outcomes for operational counts; do not export draft contents.
- Hook Lab inspection returns a nested `native` receipt with delivery/hash,
  capabilities, upstream inspection and intent/refusals. Existing audit outcome
  `programs-present` means a fully matching native deployment snapshot including
  expected absences, **not launch readiness**. `refused`/`unavailable` remain distinct.
  Audit stores plan/outcome, not the large RPC account snapshot. No new migration
  is required beyond 0076 for this adoption.

Deployment gate (not performed by shipping source): authorize pending migrations
0076 and 0077 on the target shared database and a separate preview-only application deployment.
Before authorizing, back up the target, verify its migration journal and review
pending migrations; do not run all unapplied migrations blindly. On an approved
deployment, check `/coins/new`, anonymous API behavior, signed-in save/resume,
owner-isolated audit, devnet confirmation, a matching native snapshot and a
refused invalid intent. Verify mainnet/send/sign requests remain disabled. Check
the deployed Node artifact contains the manifest/11 IDLs, not only `dist/index.mjs`.
Smoke tests must never connect a funded wallet or submit a chain transaction.
After owner backup/target/credential approval, use the existing pinned deployment
script (replace `MERGED_SHA7` with the reviewed seven-character main commit):

```sh
git fetch -q origin && git show origin/main:scripts/ops/deploy.sh | bash -s -- MERGED_SHA7 web
```

This needs authenticated Railway CLI access to the production project. Web's
pre-deploy runs `npm run db:migrate` with its provider-held `DATABASE_URL`; inspect
all pending migrations first. The backup service needs its scoped R2 credentials
and a confirmed recoverable encrypted backup (see [BACKUPS.md](BACKUPS.md)).
This increment does not change worker behavior and does not require a worker
restart or any financial activation flag. Pushing/merging source is not deployment.

```sql
DELETE FROM direct_coin_drafts WHERE updated_at < now() - interval '30 days';
DELETE FROM direct_coin_events WHERE created_at < now() - interval '30 days';
DELETE FROM hook_lab_recipe_drafts WHERE updated_at <= now() - interval '30 days';
DELETE FROM hook_lab_recipe_events WHERE created_at <= now() - interval '30 days';
SELECT action, adapter, outcome, count(*) FROM direct_coin_events
WHERE created_at > now() - interval '7 days' GROUP BY action, adapter, outcome;
```

## Exact owner gates before any live launch

1. Approve network, dedicated wallet, bounded spend/rent/fee reserve and final
   token name/symbol/metadata/supply/decimals; no auto dev-buy budget.
2. Standard: approve Raydium GlobalConfig + PlatformConfig or Meteora config,
   quote mint, curve/graduation, all fee recipients and rates, LP ownership/lock/
   burn policy and mint/freeze/metadata authority treatment. No arbitrary sliders
   that override config-enforced terms.
3. Programmable: approve exact Hook Lab commit/binaries/IDs, fork SDK artifact,
   recipe, bridged-SOL custody, hook fees and net-output bounds. Complete the new
   CLI's signed plain/Kit/Half-Life acceptance separately; old smoke launches are
   not new CLI acceptance. Companion is non-atomic and deferred; lottery disabled.
4. Production additionally requires independent audit/remediation, multisig/
   timelock and treasury policy, monitoring/keeper owners, durable transaction
   recovery, spend caps, dependency advisory review and a separate mainnet
   deployment/identity approval. Hook Lab beta.2 is not production approval.
5. Present final transaction parameters and risks for explicit owner authorization
   before signing/sending, using a faucet, creating a pool or spending any funds.
