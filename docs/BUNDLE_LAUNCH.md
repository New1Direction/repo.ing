# Bundle launches

**Status: dark (v1 program and client only).** Nothing on the site offers, builds or indexes a Bundle launch. The program
(`programs/bundle-vault`, id `5feqSRaVwGcAdR6Fzf73K8sxunV8cTC9pjEBhfbRxHCw`) is **not deployed on mainnet**, no platform
account or bundle config exists there, and `BUNDLE_LAUNCHES_ENABLED` plus the code gate `BUNDLE_LAUNCHES_READY`
(`src/bundle-launch.mjs`) keep it off. The program key is in the main checkout's git-ignored `secrets/`.

A Bundle launch is a second launch mode beside the standard one, which does not change. Backers fund a raise for a
repository's market. At launch the raise (less 5% for operations) buys the market's first tokens into a permanent vault.
Operator agents trade the vault within on-chain limits. The partner share of the market's trading fees is routed by the
program: what the vault's own trades generated goes back to the vault, then 80% to the backers and 20% to repo.ing.
Builders keep their 0.994%.

## Owner decisions (2026-10-06)

| Decision | Choice |
| --- | --- |
| Allocation | The vault buys at launch, in the launch transaction (the curve stays the 85 SOL launch-fee curve). |
| Raise | All or nothing: a deadline, refunds when it fails. |
| Vault SOL | No withdraw instruction (only pause). The program's upgrade authority can still change the program. |
| After graduation | Backers keep 80% of the partner LP position's fees (after the vault's rebate). |
| Backer receipt | A program account (`Backer`), not a token. |
| Fees | 5% of a raise to operations; of the partner fees, the vault's own back to it, then 80% backers / 20% repo.ing. No discovery reward on bundle markets. |

## The flow

1. **Raise.** The launcher opens a bundle (`create_bundle`; repo.ing's admin co-signs, the vault policy must be at least as
   tight as the platform's limits). The bundle copies the platform's terms (bundle config, backer and operations shares,
   cooldown, grace period): a later platform change never touches an existing bundle. Backers `deposit` SOL into the bundle account until the target; one lamport is one share.
   The last deposit may be below the minimum so a raise can always be filled exactly.
2. **Failure.** `fail_raise` (anyone) fails a raise that missed its target by the deadline, or a full raise not launched
   within `launch_grace_secs` after it; the admin can `cancel_bundle` while it raises. Then each backer's `refund` returns
   exactly its deposit and closes its backer account (rent back to it).
3. **Launch, one transaction** (`bundleLaunchInstructions`):
   `release` → DBC `initialize_virtual_pool` → the launch signer's first swap at top level with the vault as receiver →
   `settle`. `release` pays `ops_bps` to the operations wallet and the rest to the launch signer, and only when this
   program's `settle` for the same bundle comes later in the transaction (instructions sysvar). `settle` checks that the pool
   is on the bundle's config, that its SOL reserve holds at least 98% of the released SOL (the first swap pays 1.75%) and its
   partner fees are at most 1% of it (a new pool), that every token outside the curve (mint supply minus the curve's base
   vault) is in the vault's associated token account, and that this is at least the quoted amount. Then it books the vault's cost basis and opens trading `launch_cooldown_secs` (≥ 180) later.
   DBC charges the first swap its minimum fee (1.75%) only at top level; by CPI it would pay the 50.44% launch fee
   (`validate_contain_initialize_pool_ix_and_no_cpi`, measured in [the spike](../spikes/bundle-launch/README.md)). That is why
   the launch signer swaps and the vault only receives.
4. **Vault.** `open_vault` (anyone) creates the vault's wrapped SOL account and the backers' pot. Operators trade with
   `vault_swap_curve` (DBC) and, after graduation, `vault_swap_pool` (DAMM v2). The program builds those swaps itself, on the
   bundle's own pool and the vault's own accounts.
5. **Graduation.** The curve migrates to DAMM v2 as usual. The admin's `record_graduation` binds the bundle to the canonical
   DAMM v2 pool (the PDA of the bundle's DAMM config, fees in SOL only) and to the router's partner LP position: permanently
   locked liquidity and the canonical position NFT account. It is the admin's because anyone can open a position owned by the
   router (and could lock one and hand its NFT over), so the program alone cannot tell the migration's position apart; the
   admin reads it from the migration transaction.
6. **Fees.** `route_curve_fees` / `route_pool_fees` (anyone) claim the pool's partner fees into the router and route them.
   Backers `claim_backer_fees` as wrapped SOL.

## Vault controls (on chain)

Checked before every vault trade, on the vault's balances before and after it:

| Control | Rule |
| --- | --- |
| Who | A platform operator key (up to 4); the vault PDA signs the swap, agents never hold funds. |
| Alone | Top level only, and no other DBC or DAMM v2 instruction in the transaction (no same-transaction sandwich). |
| When | Not before `trading_opens_at` (the launch fee), not while paused. |
| Size | One trade at most `max_trade_bps` of the vault's SOL (buy) or tokens (sell). |
| Daily | Per UTC day, buys at most `max_daily_buy_bps` of the SOL before them, sells at most `max_daily_sell_bps` of the tokens before them. |
| Price | A sell must get at least `floor_bps` of the vault's average cost (10,000 = cost), on what it actually received. |
| Churn | `gap_secs` between a buy and a sell, in either order. |
| Changes | The admin can only tighten a policy (`set_policy`) or pause it (`set_paused`); never loosen. |

`BUNDLE_DEFAULTS` (`src/bundle-launch.mjs`): limits 5% per trade, 20% SOL / 3% tokens per day, floor at half the cost, 5
minutes; a new bundle 2% per trade, 10% SOL / 1% tokens per day, floor at cost, 10 minutes. These are starting points, not
decisions.

## Fee routing

The bundle config's fee claimer is the program's router PDA, so its fees never reach the H7TK partner wallet, the sweep or
discovery rewards. A routed claim of `claimed` lamports:

1. **Rebate.** `min(claimed, vault_fee_owed)` goes to the vault's wrapped SOL. `vault_fee_owed` is what the vault's own trades
   generated: the launch buy's partner fee (the pool's whole `partner_quote_fee` at `settle`), plus, for each vault trade, the
   growth of DBC's `partner_quote_fee` across it, or after graduation the router position's share of DAMM v2's
   `fee_b_per_liquidity` growth (liquidity × Δ >> 128, rounded down). These fees never become backer income.
2. **Split.** Of the rest, `backer_bps` (80%) to the bundle's pot and the remainder, rounding included, to repo.ing's treasury.
3. **Backers.** `acc_per_share += to_backers × 1e18 / raised`; a backer can claim `shares × acc_per_share / 1e18 − paid`.
   Rounding never pays out more than the pot received: each routing leaves less than raised / 1e18 lamports, each claim less
   than one lamport, in the pot.

Example: a 20 SOL bundle, 1 SOL of public curve volume: 0.994% builders, 0.3248% backers, 0.0812% repo.ing, 0.35% Meteora.

## What people trust

- **Launch signer** (repo.ing's key): receives a full raise for one transaction; `settle` must follow in that transaction and
  checks that the SOL went into the bundle's pool and every bought token into the vault. It cannot keep the SOL or the
  tokens; it chooses the quoted minimum.
- **Admin**: co-signs bundles, sets the platform (operators, wallets, limits, terms for new bundles), tightens policies,
  pauses vaults, cancels raises. Cannot move vault or pot funds or change an existing bundle's shares.
- **Operators** (agent keys): trade vaults within the policy only. An operator that also trades from another wallet in
  separate transactions could still trade around the vault's buys; the per-trade and daily limits bound that, and a price
  band against the pool's own price is a follow-up.
- **Upgrade authority**: can change the program (including adding a withdraw). An audit and a decision on freezing upgrades
  belong before go-live.

The platform's bundle config is checked when it is set: its fee claimer is the router, its quote is SOL, it collects fees in
SOL only and its mints are SPL Token. So every fee the router claims arrives as SOL and is routed.

## Accounts and instructions

`Platform` (PDA `platform`), `Bundle` (PDA `bundle` + id), `Backer` (PDA `backer` + bundle + wallet); the vault (`vault` +
bundle) and the router (`router`) own token accounts only. The client (`src/bundle-vault.mjs`) builds every instruction,
decodes the accounts, mirrors the routing and claim math, and names errors (`bundleErrorName` counts only failures that
start in this program, since a failed CPI ends with the inner program's number).

## Tests

```sh
node --test tests/bundle-vault.test.mjs        # quick suite: client/program agreement, fixture hash, math, flags
node --test tests/bundle-vault-chain.test.mjs  # full suite: starts scripts/ci/start-bundle-validator.sh (port 8939)
scripts/build-bundle-vault.sh                  # after any change to programs/bundle-vault (the fixture hash test fails otherwise)
```

The chain test runs on DBC, DAMM v2 and Metaplex as deployed on mainnet: platform setup and its refusals; four raises (one
launched, one missing its target, one cancelled, one full but stale) with exact refunds and repeated refunds refused; the
one-transaction launch, its refusals and replays; the cooldown and every vault limit; routing with the rebate measured
exactly on the pool's counter, concurrent routings paying once; backer claims pro rata, concurrent and replayed claims paying
once, rounding bounds; graduation, the router's LP position, DAMM v2 vault trades, rebates within one lamport and claims.

## Costs

The program is ~537 KB: about 3.7 SOL of rent to deploy (more during the upload). A bundle account and a backer account
cost their rent (returned to backers on refund).

## Not built yet

The site's raise and claim pages and routes, the bundle tables (separate ledgers, as for stock pairs), indexing of raises,
vault trades and routings, the vault agents and the routing crank, Bundle + early access/fair ramp, an external audit, and the
mainnet setup (deploy, bundle config with the router as fee claimer, platform account, lookup table) — each a step the owner
runs.
