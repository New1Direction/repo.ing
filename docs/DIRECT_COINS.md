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
| Hook Lab DEX (Programmable) | Native Bordrless mint/holding standard, **neither SPL nor Token-2022**. Native token callbacks on transfer/mint/burn and pool callbacks on swaps/liquidity. One token hook: Kit OR Half-Life OR another supported hook. | Bridged SOL native mint; constant product with virtual offsets, not deposited SOL. Config sets supply/decimals/curve bounds. Default virtual quote 28.125 SOL is not a quote or a funding requirement. | Launch PDA holds LP permanently; not a user burn option. Creator fee applies both directions; hook cuts and burns compose with protocol fees. Historical setup sniper fee 80% for 30 seconds, first creator self-buy exception. | Experimental devnet beta. Plain, Kit and Half-Life educational plans. No arbitrary hooks, lottery, companion execution, bridge deposit or swaps. |

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
  adapter intentionally stops at deployment identity reads until a pinned fork
  SDK artifact is approved. No hand-written transaction encoding substitutes for it.
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

Preview means validated intent and disclosures, **not** a price quote or RPC
transaction simulation. Report unknown amounts as unknown, not zero. Executable
account detection proves neither binary identity nor safety. Read actual genesis,
slot, program owner, ProgramData and current upgrade authority; display failures.
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

## Operator runbook

- Additive migration `0076_direct_coins.sql` adds private versioned drafts and audit
  events. Apply only to disposable local data during verification. Shared DB
  migration/deployment needs separate approval.
- `GET /api/direct-coins` lists the signed-in user's drafts and their latest 50 audit
  entries. `POST` accepts only `save` or `inspect`, a strict plan, and (on save)
  draft ID/revision. Stale revisions return 409. Draft + audit writes are atomic.
  Same-origin, encrypted existing GitHub session, account quota and bounded bodies
  protect writes and RPC usage. No existing market or launch session is touched.
- Browser autosave is device-local and untrusted; server save is explicit, requires
  sign-in and revalidation. Avoid entering confidential content. Clear browser
  draft with Reset. Server drafts/events expire after 30 days; prune on each write
  and schedule the SQL below in the normal operator retention job if idle.
- `DIRECT_COINS_DEVNET_RPC_URL` is a server-only read endpoint, defaulting to public
  devnet. It must return devnet genesis; existing `SOLANA_RPC_URL` is never reused.
  Bounded RPC timeouts, no automatic 429 retries, no user-selected endpoint.
- Privacy-bounded telemetry: structured `directCoin` events carry action, adapter,
  outcome and latency only. Private audit records contain validated plan snapshots
  and SHA-256 digest, never sessions, keys, wallet addresses or signed payloads.
  Aggregate audit outcomes for operational counts; do not export draft contents.

```sql
DELETE FROM direct_coin_drafts WHERE updated_at < now() - interval '30 days';
DELETE FROM direct_coin_events WHERE created_at < now() - interval '30 days';
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
