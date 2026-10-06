# Bundle launches

**Status: dark (v1 program, client and the site's raise flow).** Nothing on the site offers, builds or indexes a Bundle launch
while it is dark: its pages are not found and its routes answer 404 (see "The site" below). The program
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
| Operations wallet | The bundle launch signer itself: the 5% funds its launches and cranks. |
| Treasury | Buyback custody FgzeY…: repo.ing's 20% arrives there as wrapped SOL, for $REPOING buys. |
| Builder allocation | Yes, as on standard markets: the bundle config is added to `BUILDER_ALLOCATION_CONFIGS`. |
| Vault agent | Trades from the first day a vault may trade (after the launch fee): `BUNDLE_AGENTS_LIVE=true` with an operator key. |
| Site raises | 1–10 SOL (default 5), from the simulation (docs/BUNDLE_SIMULATION.md). |

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
node --test tests/bundle-config.test.mjs       # quick suite: the setup kit's config, checker, lookup addresses, platform terms
node --test tests/bundle-vault-chain.test.mjs  # full suite: starts scripts/ci/start-bundle-validator.sh (port 8939)
node --test tests/bundle-setup-chain.test.mjs  # full suite: the mainnet setup kit, then a launch on it (same validator)
scripts/build-bundle-vault.sh                  # after any change to programs/bundle-vault (the fixture hash test fails otherwise)
```

The chain test runs on DBC, DAMM v2 and Metaplex as deployed on mainnet: platform setup and its refusals; four raises (one
launched, one missing its target, one cancelled, one full but stale) with exact refunds and repeated refunds refused; the
one-transaction launch, its refusals and replays; the cooldown and every vault limit; routing with the rebate measured
exactly on the pool's counter, concurrent routings paying once; backer claims pro rata, concurrent and replayed claims paying
once, rounding bounds; graduation, the router's LP position, DAMM v2 vault trades, rebates within one lamport and claims.

The setup chain test runs the setup scripts' code in their order: the bundle config built, simulated, created and checked
(equal to a launch-fee config in every field but the fee claimer, and to the live one in `tests/fixtures/launch-fee-config-mainnet.json`;
look-alikes with another fee claimer or leftover receiver refused); the platform refused for another config (`BadSettings`)
and another signer (`NotUpgradeAuthority`), then created with both wrapped SOL accounts (after lamports were sent to the
platform and treasury addresses), equal to the reviewed terms, once only, and changed by the admin only (`NotAdmin`); the 14-key lookup table; then a 5 SOL raise launched in one v0 transaction
through that table (1,140 bytes), the vault holding exactly the quoted tokens. Every step's payer loses exactly the network
fee plus the rent of the accounts it creates.

## Costs

The program is 555,576 bytes: 2.824 SOL of rent at mainnet's rent of 2026-10-06 (more during the upload, see below). A
bundle account and a backer account cost their rent (returned to backers on refund).

## Mainnet setup (the owner runs it)

Nothing here switches Bundle launches on: `BUNDLE_LAUNCHES_READY` stays false and no code reads the config or the table yet.
Run every command from the main checkout (its git-ignored `secrets/` holds the program keypair, and the config keypair is
written there), with `SOLANA_RPC_URL` set to an https mainnet RPC. The scripts check mainnet by genesis hash and read no other
setting (unlike the early access scripts, they do not fall back to reading the RPC from Railway). Each script is a dry run
unless `--execute`: it builds the transaction, checks it, simulates it unsigned against mainnet and prints every value, the
instruction or address hash and the exact debit (the network fee plus the rent of the accounts it creates, nothing else).
`--execute` sends only when those printed values are approved in the environment, simulates again signed, then checks the
result on chain. Costs below are at mainnet's rent on 2026-10-06 (5,080 lamports per byte plus 650,240 per account); the dry
run prints the exact figure.

**1. Deploy the program** (`5feqSRaVwGcAdR6Fzf73K8sxunV8cTC9pjEBhfbRxHCw`). Deploy the committed build as it is (the copy
the tests ran; do not rebuild first, step 3 refuses a program whose bytes differ from it):

```sh
solana-keygen pubkey secrets/bundle-vault-program-keypair.json   # must print 5feqSRaVwGcAdR6Fzf73K8sxunV8cTC9pjEBhfbRxHCw
solana program deploy tests/fixtures/validator/bundle_vault.so --program-id secrets/bundle-vault-program-keypair.json \
  --upgrade-authority <upgrade-authority.json> --keypair <payer.json> --url "$SOLANA_RPC_URL" [--with-compute-unit-price <micro-lamports>]
solana program show 5feqSRaVwGcAdR6Fzf73K8sxunV8cTC9pjEBhfbRxHCw --url "$SOLANA_RPC_URL"   # authority and data length 555576
```

Cost: the program data account 2.823205 SOL and the program account 0.000833 SOL, kept while the program exists (returned
if it is closed); during the upload a buffer account holds another 2.823164 SOL, returned when the deploy completes; about
560 write transactions at 5,000 lamports (about 0.003 SOL) plus any priority fee. Keep about 5.7 SOL in the payer. The
upgrade authority is the only key init_platform accepts and it can change the program: keep it offline; a multisig or freezing
upgrades is a decision for after the audit. A later, larger build needs `solana program extend` first.

**2. Create the bundle config** (the program must be deployed; the script checks it):

```sh
node scripts/create-bundle-config.mjs     # first run writes secrets/bundle-config-keypair.json (the config's address, mode 0600)
APPROVED_BUNDLE_CONFIG=<config> APPROVED_BUNDLE_CONFIG_INSTRUCTION_SHA256=<instructionSha256> \
  APPROVED_BUNDLE_CONFIG_DEBIT_LAMPORTS=<totalDebitLamports> node scripts/create-bundle-config.mjs --execute
```

Check in the dry run: `feeClaimer` is the router `A4HN8dLeZt46HhnYssYvHvQXxVrGQDZep6VyMPAfzTuQ`; `differsFromReferenceOnlyIn`
is `["feeClaimer"]` (the reference is the live SOL launch-fee config `8TXNGgx6…`, so the curve, launch fee, split, leftover
and migration are today's); `leftoverReceiver` is the creator signer FeZX…; `payer` is the partner wallet H7TK… (signed from the
Keychain, as the other config scripts); `dammConfig` is `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` (FixedBps100);
`totalDebitLamports` about 5,984,080 (0.005974 SOL rent, two signatures). A check that fails stops the script with its reason.

**3. Init the platform** (signed by the upgrade authority from step 1). With the owner's choices: the admin is the creator signer, the
launch signer and the operator are the keys in the main checkout's git-ignored `secrets/bundle-launch-signer-keypair.json` and
`secrets/bundle-operator-keypair.json`, the operations wallet is the launch signer, the treasury owner is the buyback custody:

```sh
node scripts/init-bundle-platform.mjs --config <config> --admin FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1 \
  --launch-signer 9h6uMSfKZNNXdCAHZsxR3nvxHmQXAGqTvBdJwGn3PReN --operator 9uoqHv5jkC5vCk7hexsZ9dM7fQzYqDtAQskh4EUX8Eq8 \
  --ops-wallet 9h6uMSfKZNNXdCAHZsxR3nvxHmQXAGqTvBdJwGn3PReN --treasury-owner FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy
APPROVED_BUNDLE_PLATFORM_INSTRUCTION_SHA256=<instructionSha256> APPROVED_BUNDLE_PLATFORM_DEBIT_LAMPORTS=<totalDebitLamports> \
  node scripts/init-bundle-platform.mjs <the same flags> --upgrade-authority <upgrade-authority.json> --execute
```

The wallets are flags, never defaults: the admin (co-signs every bundle, tightens or pauses vaults, cancels raises, changes
these terms), the launch signer (runs each launch transaction), one to four operators (the vault agents' keys), the operations
wallet (5% of each raise; it is in the lookup table) and the treasury owner (its wrapped SOL account receives repo.ing's 20% of
the routed fees). The DAMM v2 config comes from the bundle config; the shares, cooldown, grace period and loosest vault policy
from `BUNDLE_DEFAULTS`. Check in the dry run: `deployedProgramIsReviewedBuild: true`; `signer` is your upgrade authority; each
wallet in `terms`; `treasury` and `routerSol` (`C6gTwTLcMWfkHzRv6ozGLzSBvwLKbcxqf166deaFyUZ8`) are the wrapped SOL accounts;
`curveConfig` is step 2's config; `backerBps` 8000, `opsBps` 500, `launchCooldownSecs` 180, `launchGraceSecs` 86400 and `limits`;
`createsTokenAccounts` lists the router's and the treasury's wrapped SOL accounts when they are missing (created in the same
transaction, before init_platform); `totalDebitLamports` about 5,913,040 (two token accounts at 0.001488 SOL, the platform
account at 0.002931 SOL). It refuses a deployed program that differs from the fixture, a config that fails a check or differs
from the live launch-fee config in any field but the fee claimer (the lookup table script checks the same), and an existing
platform (it prints it instead; exit 0 when it already holds these terms). Lamports someone sent to the platform or treasury
addresses beforehand do not block it: the accounts are still created there and the payer tops up the rest. Do not close the treasury's wrapped SOL
account (move wrapped SOL out with a token transfer): routing fails while it does not exist.

Later changes: the same flags with `--set` (and `--admin-keypair <admin.json>` to execute); it prints each change, signed by the
current admin, and applies to bundles created afterwards. A new operations wallet also needs a new lookup table.

**4. Create the lookup table**:

```sh
node scripts/create-bundle-lookup-table.mjs --config <config>
APPROVED_BUNDLE_LOOKUP_TABLE_ADDRESSES_SHA256=<addressesSha256> APPROVED_BUNDLE_LOOKUP_TABLE_DEBIT_LAMPORTS=<totalDebitLamports> \
  node scripts/create-bundle-lookup-table.mjs --config <config> --execute
```

Check in the dry run: 14 `addresses` (`bundleLookupAddresses`): DBC pool authority, DBC event authority, DBC, SPL Token, System,
instructions sysvar, wrapped SOL, the bundle program, the config, Associated Token, Metaplex, Compute Budget, the platform
account `3k6oDeconrAagqSCKNbQj4WP6MBRsRGAjRRNcKTRcJfR` and `opsWallet` (read from the platform); `totalDebitLamports` about
3,215,560 (0.003211 SOL rent). The partner wallet pays and is the table's authority. `--execute` prints the table's address.

| Step | Signer | Cost |
| --- | --- | --- |
| Deploy | payer (and the upgrade authority) | 2.824 SOL kept, 2.823 SOL more during the upload, ~0.003 SOL fees |
| Bundle config | partner (Keychain) + the config keypair | 0.005984 SOL |
| Platform | upgrade authority | 0.005913 SOL |
| Lookup table | partner (Keychain) | 0.003216 SOL |

**Settings the site reads** (names only; the launch path and worker are in the Bundle site PRs): `BUNDLE_LAUNCHES_ENABLED`
(exactly "true", with the code gate), `BUNDLE_DBC_CONFIG` (step 2's address), `BUNDLE_LOOKUP_TABLE` (step 4's address),
`BUNDLE_LAUNCH_SIGNER_SECRET_KEY` (the launch signer, worker), `BUNDLE_OPERATOR_SECRET_KEY` (one vault operator, worker) and
`BUNDLE_AGENTS_LIVE` (the vault agent trades only when "true"). The platform's admin is the existing creator signer
(`PLATFORM_CREATOR_SECRET_KEY`): it co-signs new bundles and the pool creation, and signs `record_graduation`. So step 3 runs with
`--admin` set to that signer's address (FeZX…).

## The site (dark)

Every route and page below answers 404 (not found) unless `bundleLaunchable()`; the launch form, the token page and `/wallet`
show nothing of Bundles until then.

| Where | What |
| --- | --- |
| `/launch/[repo]` | "Bundle (community-funded)" beside the standard launch: a target of 1–10 SOL (5 by default), a deadline of 1, 3 or 7 days (3), the token's name, symbol and image (`BUNDLE_RAISE`, `src/bundle-launch.mjs`). A repository with a live bundle shows its raise instead, and `/api/launch` refuses a standard launch beside it. |
| `POST /api/bundles` | `prepare`: the standard launch review's repository checks (opt-out, fork guard, no market or launch in progress) plus no live bundle; an id from `bundle_id_seq`; `create_bundle` with a compute budget, simulated; the row inserted as `opening`. `submit`: the wallet signed first; the transaction must be exactly the one the row describes (only the wallet's Lighthouse assertions may follow), within 2 minutes of the prepare on the database clock; then repo.ing's admin (`creatorSigner()`) co-signs, it is sent and confirmed, the account is read back, and the row becomes `raising`. |
| `GET /api/bundles/[id]` | The row, the chain's Bundle (the truth for the raise, deadline, status and routed fees), the backer count and, with `?wallet=`, that wallet's shares, share and claimable fees. |
| `POST /api/bundles/[id]` | `deposit`, `refund`, `claim`: checked against the chain, simulated, returned unsigned for the wallet. A claim creates the wallet's wrapped SOL account (idempotent), claims into it and closes it to unwrap to SOL; an account that existed (the referral payout account) is created again after the close. `send`: relays only one of those exact transactions, signed by the wallet. |
| `/bundle/[id]` | The raise page: repository, token, progress, deadline, backers, deposit, the wallet's share, refund once failed, claim once launched, the market once live. |
| `/token/[mint]` | A bundle market's "Bundle vault" tab: vault tokens and SOL, vault volume, fees routed to backers, rebated to the vault and to repo.ing, and the wallet's claim. |
| `/wallet` | The bundles the wallet backs (its Backer accounts), with refund or claim. |

The worker moves rows on from `raising` (and activates or expires an `opening` row by the chain); these routes only insert
`opening` and set `raising` on a confirmed create.

## Not built yet

The bundle tables' separate ledgers (as for stock pairs), indexing of raises, vault trades and routings, Bundle + early
access/fair ramp, and an external audit. The mainnet setup (above) is ready for the owner to run; none of it has run on mainnet.
