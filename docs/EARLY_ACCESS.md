# Contributor early access

An opt-in launch option. For a window the launcher picks (15 minutes to 24 hours), only wallets linked to the repository's
contributors can buy the token; anyone can sell to the curve at any time. It is enforced on chain by a Token-2022 transfer
hook, `programs/early-access-hook`, on its own Meteora DBC config. Launches without the option, and every existing market,
are unchanged.

Status: the hook program and its tests; the database, switches and the contributor wallet link (step 3); the early access
config, its scripts and the launch (step 4); all dark. The code gate `EARLY_ACCESS_LAUNCHES_READY` stays `false`, so no launch
offers or accepts early access; nothing is deployed.

## Decisions (owner, 2026-10-05)

| Question | Decision |
| --- | --- |
| What the hook does | Early access only. A "ship to unlock" lock, if built, is a separate lock vault for SPL tokens, because Meteora removes the hook at graduation. |
| Which launches | The launcher selects it on the launch form. |
| Window | The launcher selects it: 15 minutes to 24 hours (the program caps it at 24 hours). |
| Launcher | Gets the first buy in the launch transaction only, then is taken off the list unless a contributor. |
| Contributor | A GitHub account with at least 1 commit in the repository (GitHub's contributor list), bots excluded, with a wallet linked to that account on repo.ing. |
| Fee | Flat 1.75% (the `builders` curve), not the anti-sniper launch fee: during the window only contributors can buy. |

Two more rules in the same program (owner, 2026-10-06), each one the launcher selects; any mix of the three is possible, and
star unlocks needs the fair ramp:

| Rule | Decision |
| --- | --- |
| Fair ramp | One wallet can hold at most 2% of the supply at the start. The limit rises in a straight line to 10% while the curve sells, and there is no limit from 50% curve progress on (the 10% end point is the agent's choice; the owner set 2% and 50%). |
| Star unlocks | Every 100 GitHub stars the repository gains after the launch add 0.5% of the supply to the fair ramp's limit (the oracle reports the star count), up to a cap stored per mint (+5% suggested; stars never lift the limit away). |

## The program

Program id `Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep` (its keypair is in the main checkout's git-ignored `secrets/`).
Anchor 1.2. Client: `src/early-access-hook.mjs`.

**Accounts**

| Account | Address | Holds |
| --- | --- | --- |
| Platform | `["platform"]` | admin (repo.ing's launch co-signer) and oracle (keeps lists current) |
| Mint config | `["config", mint]` | repository id, rules, window end, rent receiver and its deposit, the list's bump, the curve's base vault, ramp and star settings, the last star count |
| Allow list | `["allow", mint]` | sorted wallet keys (at most 1,024), read by binary search and changed in place (never copied to the 32 KiB heap) |
| Extra account metas | `["extra-account-metas", mint]` | tells Token-2022 to pass the mint config, the allow list and the curve's base vault |

The config and the list are derived from the mint alone, and the vault is a fixed address stored at setup. Meteora's DBC SDK resolves a hook's accounts with the default key as
source, destination and owner, so an account seeded from the receiver (one "pass" per wallet) would break its swap and claim
builders. One list per mint also works for Phantom, Jupiter and any other client.

**The rules** (`transfer_hook`, run by Token-2022 on every transfer). A transfer of 0 tokens, and a transfer to a token
account owned by Meteora DBC's pool authority `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` (a sell), always pass. Otherwise:

- **Contributor early access** (`RULE_EARLY_ACCESS`): until `early_access_end`, only the associated token account of an owner
  on the allow list can receive (the hook derives the ATA and compares). Any other token account could change owner after
  receiving, which would let a contributor pass tokens on. After the window the hook no longer reads the list.
- **Fair ramp** (`RULE_FAIR_RAMP`): the receiving account may hold at most `start_bps` + (`end_cap_bps` − `start_bps`) × sold
  ÷ span of the supply. Sold is how far the curve's base vault has emptied from `vault_start` (the span ends at `vault_end`),
  *minus what the receiving account held before this transfer*: a wallet's own tokens are never progress for it, so neither
  one large buy nor many small ones can carry a wallet past its limit. A buy from the vault is measured against the vault as
  it was before the buy. Once others have sold the whole span there is no limit for that wallet; if sells refill the vault
  above the span's end, the limit comes back (holders can always sell). A large holder may need others to buy before it can
  buy more. Only the receiver's associated token account can receive while the limit applies (a second account per owner,
  even one with ImmutableOwner, would hold the limit again). The limit may rise at most one token per token sold
  (`init_mint` refuses a steeper ramp). The hook checks that the vault is a Token-2022 account of the mint owned by DBC's
  pool authority before reading it, and `init_mint` checks that it is the pool's own vault.
- **Star unlocks** (`RULE_STAR_UNLOCKS`, with the fair ramp only): every `star_step` stars gained since `stars_at_launch`, as
  the oracle last reported, add `star_bonus_bps` to the limit, at most `star_max_bonus_bps` whatever the oracle reports.
  Stars lost never lower the limit below the ramp's own. Set `stars_at_launch` from a fresh read at prepare, or the first
  report gives an instant bonus.

A transfer into a Token-2022 account owned by DBC's pool authority that is not the pool's vault (anyone can create one) skips
the rules, but only DBC can sign for that owner and it signs only for its pools' vaults: the tokens are locked for good, and
the sender gains nothing. The supply is read live, so a burn lowers every limit in proportion.

A wallet with many addresses can still hold more than the limit across them: the ramp makes that more expensive, not
impossible. `walletCapBps(config, vaultBalance)` in the client computes the limit exactly as the hook does, so a page can
show it and size a buy as the limit minus what the wallet holds.

**Instructions**

| Instruction | Who | What |
| --- | --- | --- |
| `init_platform` | the program's upgrade authority, once | sets admin and oracle (neither may be the default key) |
| `set_platform` | admin | changes admin and oracle |
| `init_mint` | admin authorizes, `payer` pays | the rules (a bit set, not empty), the pool and its base vault (accounts; the vault must be DBC's `["token_vault", mint, pool]`), the window end (with early access: now < end <= now + 24 h; without it: 0) and first wallets, the ramp settings (present with the fair ramp only); creates the three mint accounts. Nothing changes later except the star count. |
| `report_stars` | oracle only | the repository's star count now (star unlocks only; it may go down) |
| `add_wallets` | oracle only, during the window | up to 24 wallets per call; the oracle pays for the larger list |
| `remove_wallets` | oracle or admin | up to 24 wallets per call; the launch transaction uses it with the admin's signature |
| `close_allow_list` | anyone, after the window | the payer of `init_mint` gets its deposit back, the oracle the rest |

Errors (Anchor numbers from 6000): NotUpgradeAuthority, NotAdmin, NotOracle, BadWindow, TooManyWallets, WindowClosed,
WindowOpen, BadAllowList, BadDestination, NotAssociatedAccount (6009), NotContributor (6010), MathOverflow, BadKey, WalletLimit
(6013), BadVault, BadRules, BadRamp.
`hookErrorName` names them from the hook's own failure line only: DBC and Token-2022 report the same numbers.

**What people trust.** The oracle decides who is on a list and reports the star count, which can raise a fair ramp's limit
by at most the mint's star cap; it cannot change a window or the ramp. The admin sets a token's window once
and can take wallets off a list, but cannot add them (it signs every launch, so it is the hotter key). The upgrade authority
can replace the program, and the hook runs on every transfer of every early access token until its curve is full: a broken
upgrade (or closing the program) would stop every such token from trading, sells included, until fixed. It cannot move
anyone's tokens. Run `init_platform` first (it needs the upgrade authority as a signer), then hand the upgrade authority to
a multisig, or remove it once the program has run in production.

**Fee mode.** The early access config collects fees in SOL (quote). A config collecting fees in the token would send them
through the hook, and a fee claimer off the list could not claim during the window.

## Meteora DBC with a hook (SDK 1.5.13, checked on mainnet's programs)

- The config is made with `create_config_with_transfer_hook` and must be Token-2022. Every pool on it uses this hook.
- Pools are `initialize_virtual_pool_with_token2022_transfer_hook`; DBC creates the mint (the mint keypair signs) with the
  extensions MetadataPointer, TokenMetadata and TransferHook. The mint authority is none; the hook authority is DBC's pool
  authority.
- Swaps must be `swap2_with_transfer_hook` (`swap` and `swap2` refuse hook pools) and fee claims `claim_trading_fee2` /
  `claim_creator_trading_fee2`. A first buy bundled with the pool's creation names the hook accounts itself
  (`transferHookAccounts`), because the mint does not exist yet.
- The swap that fills the curve sets the hook program and its authority to the default key, after its own transfer has
  passed the hook: a wallet off the list cannot make that swap during the window. Migration to DAMM v2,
  `withdraw_leftover` (after the migration), DAMM v2 swaps and the locked positions' fee claims then work with token A on
  Token-2022.

## The launch transaction

Hook setup (launcher listed), the pool, the launcher's first buy and the launcher's removal in one transaction is 1,311 bytes
as a legacy transaction (the limit is 1,232). As a v0 transaction with one address lookup table (DBC's pool and event
authorities and program, both token programs, the system and associated token programs, the instructions sysvar, wrapped SOL,
the hook program, its platform account and the early access config) it is about 1,133 bytes and 220,000 compute units.
repo.ing's launches are legacy today, so early access launches need v0 transactions and a lookup table on mainnet.

A buy through the hook uses about 100,000 to 130,000 compute units, about 111,000 with 283 wallets on the list (the SPL
path's limits allow it).

## Costs (mainnet)

- Program account: about 2.6 SOL for 379,392 bytes (returned if the program is closed).
- Lookup table: about 0.004 SOL.
- Per launch: the three mint accounts, about 0.004 SOL, paid by the launcher; the list's share comes back when it is closed.

## Switches, database and the contributor wallet link (step 3)

**Switches** (`src/early-access.mjs`). `EARLY_ACCESS_ENABLED` (exactly "true") opens the contributor wallet link; anything
else answers 404 on its page, its API and its GitHub sign-in. Launches also need the code gate `EARLY_ACCESS_LAUNCHES_READY`,
which stays `false` until the launch, trades, claims and graduation for hook pools exist (`earlyAccessLaunchable`). Settings:
`EARLY_ACCESS_DBC_CONFIG` and `EARLY_ACCESS_LOOKUP_TABLE` (the launch, step 4), `EARLY_ACCESS_ORACLE_SECRET_KEY` (step 4 uses only
its public key, in `init_platform`); errors name the variable, never its value. The window is a whole number of seconds from 900 to 86,400 (`earlyAccessWindow`); the form offers
15 minutes, 1 hour, 6 hours and 24 hours (`EARLY_ACCESS_WINDOWS`).

**Database** (`drizzle/0059_early_access.sql`).

| Object | Rule |
| --- | --- |
| `markets.early_access_end`, `markets.transfer_hook_program` | Both or none; a base58 program key, not the default key; GitHub repository markets only; never with a stock pair's quote columns. Like the quote stamp: may change while the launch is unsent (reserved, prepared, failed), immutable once it was sent or indexed (trigger `protect_market_early_access`). |
| `github_wallet_links` | One wallet per GitHub user id (the key); a wallet belongs to one account (UNIQUE). Re-linking replaces the account's wallet; a wallet linked to another account is refused, never moved. |
| `github_wallet_link_challenges` | Nonce (48 hex), account, wallet; expires 5 minutes after it is made (database clock); used once (`consumed_at`). |
| `early_access_contributors` | Per repository and account: login, commits (at least 1), when captured. Step 4 fills it when a launch is prepared. |

**The link** (`src/github-wallet-links.mjs`, `/contributors/link`, `/api/contributor-wallet`). The contributor signs in with
GitHub in the identity-only `contributor` mode (as the builder dashboard does; no repository authority). Asking for a
challenge reads the account from GitHub again with the session's token (same user id, type `User`; bots refused), then the
wallet signs:

    repo.ing contributor wallet v1
    GitHub user: <login> (<id>)
    Wallet: <base58>
    Nonce: <48 hex>
    Expires: <ISO time>

The link is written in one transaction: the challenge row is locked, checked (this account, this wallet, unused, unexpired),
the signature verified, the nonce used up, then the link upserted. There is no paste-an-address path. Read helpers for step 4:
`linkForGithubUser`, `linksForGithubUsers`, `githubUserForWallet`.

## The config and the launch (step 4)

**Config** (`src/early-access-config.mjs`, curve `buildEarlyAccessCurve()` in `src/launch-curve.mjs`): exactly the `builders`
profile (flat 1.75%, 1% builder allocation, 85 SOL graduation) with a Token-2022 base, made with `create_config_with_transfer_hook`:
fee claimer the partner wallet (H7TK…), leftover receiver the creator signer (FeZX…, as on the builders configs), quote wrapped
SOL, hook `Ew1wqkFk…`. The built transaction is checked (one DBC instruction, every account, every parameter equal to the curve,
zero padding); the unsigned simulation's account is decoded as `ConfigWithTransferHook` and must hold our hook, wrapped SOL
through SPL Token, a Token-2022 base, the expected fee claimer and leftover receiver, a flat 1.75% fee without the first-swap rule
or a dynamic fee, every curve term of the curve, and equal the live SOL launch-fee config in every field but the launch fee and
the token type. After the send the account must be the simulated bytes. The launcher checks the same at every prepare,
fee claimer included (the partner wallet, `EARLY_ACCESS_FEE_CLAIMER`), so a setting that names a look-alike config is refused.

**Scripts** (the owner runs them; each is a dry run unless `--execute`, which needs the reviewed values approved in the
environment; mainnet checked by genesis hash):

| Script | Does | Approve with |
| --- | --- | --- |
| `scripts/init-early-access-platform.mjs --oracle <key> [--upgrade-authority <keypair.json>]` | `init_platform`: admin = the creator signer (`PLATFORM_CREATOR_SECRET_KEY`'s public key, FeZX…), oracle = `EARLY_ACCESS_ORACLE_SECRET_KEY`'s public key; signed by the program's upgrade authority | `APPROVED_EARLY_ACCESS_PLATFORM=<admin>:<oracle>` |
| `scripts/create-early-access-config.mjs` | the config above; its keypair is `secrets/early-access-config-keypair.json` (git-ignored, made on the first dry run); paid by the partner (Keychain) | `APPROVED_EARLY_ACCESS_CONFIG`, `..._INSTRUCTION_SHA256`, `..._DEBIT_LAMPORTS` |
| `scripts/create-early-access-lookup-table.mjs --config <config>` | one lookup table with the 12 shared keys (`earlyAccessLookupAddresses`): DBC pool authority, DBC event authority, DBC, Token-2022, SPL Token, System, Associated Token, instructions sysvar, wrapped SOL, the hook, its platform account, the config; partner pays and is its authority (it can add entries or close the table, never change one). Prints the address. | `APPROVED_LOOKUP_TABLE_ADDRESSES_SHA256`, `APPROVED_LOOKUP_TABLE_DEBIT_LAMPORTS` |

Order: deploy the program, init the platform, create the config, create the table; set `EARLY_ACCESS_DBC_CONFIG` and
`EARLY_ACCESS_LOOKUP_TABLE` on web and worker (the worker's launch indexer verifies early access markets on that config).

**The launch** (`src/early-access-launch.mjs`, the same interface as the legacy launcher):

1. Prepare (`/api/launch`, `app/lib/early-access-launch.mjs`). `earlyAccessSeconds` in the body asks for it. Refused, with a
   message the page shows: while early access cannot launch, for a Hugging Face model, a trend or agent-draft (MCP, CLI) launch,
   a stock pair, a window outside 15 minutes to 24 hours, or without both settings. Under the repository lock the coordinator
   takes the contributor snapshot (`src/github-contributors.mjs`): `GET /repos/{owner}/{repo}/contributors?per_page=100`, up to
   5 pages, users only (bots, `[bot]` logins, organizations and anonymous entries skipped), stored in `early_access_contributors`
   (replaced in one transaction). GitHub lists accounts by commit author email, links at most 500 emails to accounts and may serve
   a cached list for a while after new commits. A GitHub failure, a rate limit under the reserve (800 requests, as Dev Pulse) or
   an empty list fails the prepare with a clear message; a launch never goes ahead on an empty snapshot.
2. The window end is wall time plus the window, but never closer than 5 minutes to the program's 24-hour cap by the chain's
   clock (read from the Clock sysvar), and refused if the chain's clock would leave under a minute. The market is stamped
   (`early_access_end`, `transfer_hook_program`) with status `prepared`; a reused reservation clears both first.
3. The transaction is v0 with `EARLY_ACCESS_LOOKUP_TABLE`: unit limit, unit price (simulated units +20%, at least +40k, priced
   and capped as every launch), `init_mint` (payer: the launcher; admin: the creator signer; the launcher listed only with a first
   buy), DBC `createPoolWithFirstBuyWithTransferHook` (`TransferHookBase` slice of 5, `transferHookAccounts(mint, vault)`) or
   `createPoolWithTransferHook` without a buy (the SDK's own compute budget instructions dropped), then `remove_wallets` for the
   launcher unless its wallet is linked to a contributor in the snapshot. Measured on mainnet's programs, with the production
   metadata link: 1,190 bytes with a first buy and a short name, 1,223 with the longest ASCII name and ticker (32 and 10) — about 4 bytes more since the fair ramp change (the rules byte, the ramp's empty option, the pool and vault as account indexes), so about 1,194 and 1,227 — 878
   without a buy; about 205,000–216,000 compute units with a first buy (limit about 245,000–260,000). A name of multi-byte
   characters can still pass the length check and not fit: that prepare is refused with a message ("use a shorter token name or
   ticker, or launch without an initial buy"). The review response also carries the window end, the contributor count and how
   many have a linked wallet.
4. Sign: the page decodes the review as v0 (`app/lib/launch-transaction.mjs`); wallet-standard wallets must declare version 0.
   The server accepts the reviewed message, or it with 1–4 trailing Lighthouse assertions (`matchesReviewedVersionedLaunch`,
   both read through the lookup table) as long as it stays within 1,232 bytes, verifies the launcher's signature, co-signs
   (creator, mint), sends it once and confirms it as before (`sendLaunch`). Room for assertions (measured): the first adds 48
   bytes (Lighthouse's key and the instruction), each next 16, so none fits with a first buy and 20 without one. A wallet that
   insists on adding one to a first-buy launch cannot sign it; whether Phantom then signs without them is not known yet (check
   before switching on). A body that is not a v0 transaction is refused with a message the page shows.
5. Verify (`src/launch-evidence.mjs`, chosen by the stamp): DBC `initializeVirtualPoolWithToken2022TransferHook` on the early
   access config by the recorded creator, mint, pool, hook (account 8) and launcher (payer, account 9), accounts read through the
   lookup table; a Token-2022 mint whose transfer hook is ours (or the default key once the curve is full, as DBC sets it); the
   hook's mint config holding this repository and exactly the stamped end. The SPL path is unchanged. The first buy's trade and
   fees are not recorded yet (step 5).

**Not SOL markets.** Early access markets have `quote_asset_id IS NULL` like SOL markets. In step 4:

| Path | Now |
| --- | --- |
| `createMarketConfigResolver` (every SOL path) | refuses a market with the stamp, by name; the pool is not on an approved config anyway |
| Trades: `/api/trade`, the trade panel and Blinks | the curve trades from steps 5d and 5e and the graduated pool's trades from step 7b (below) once `EARLY_ACCESS_DBC_CONFIG` is set; without it: refused, "Contributor early access markets are not tradable on the site yet." |
| Builder allocation (`allocationRecord`) | claimable after graduation where `EARLY_ACCESS_DBC_CONFIG` is set and the config is in `BUILDER_ALLOCATION_CONFIGS` (step 7e); without the setting not enrolled; a config later removed from the list reads as unavailable, as for SOL markets |
| Graduated platform fees (`platformFeeRecord`, the sweep's DAMM phase) | collected where `EARLY_ACCESS_DBC_CONFIG` is set (step 7d); not enrolled otherwise |
| Platform fee listing, sweep and DBC partner fee collection | listed and collected where `EARLY_ACCESS_DBC_CONFIG` is set (step 6f); skipped otherwise |
| Builder reminders | included where `EARLY_ACCESS_DBC_CONFIG` is set (step 6d); skipped otherwise |
| Graduation monitor and its operator view (`graduationOperatorView`) | monitored where `EARLY_ACCESS_DBC_CONFIG` is set (`earlyAccessMarketSQL`, step 7a) |
| Builder dashboard (`app/lib/builders.mjs`) | listed, with their fee check, where `EARLY_ACCESS_DBC_CONFIG` is set (step 6d); not listed otherwise |
| Verification bonus accrual (`src/verification-bonus-accrual.mjs`, candidates and market facts) | decided like any other where `EARLY_ACCESS_DBC_CONFIG` is set (their trades are in `trade_events` there; step 6h); otherwise left undecided, as a decided bonus is never re-evaluated |
| `scripts/recover-expired-launch.mjs` | refused with a message (manual recovery of an early access launch is a later step; the worker still releases a proven expired attempt) |
| Launch first-buy indexing in `/api/launch` | indexed where `EARLY_ACCESS_DBC_CONFIG` is set (step 5b) |
| Launch alerts (`src/launch-alerts-message.mjs`) | while the window is open, the post says only the repository's contributors can buy until its end (step 6h) |

Left for the next steps (each fails closed or is harmless until then):

- Step 5, done: the resolver opt-in (5a), their trades and fees indexed (5b), the holder count and the window note (5c), curve
  trades on the site (5d) and through Blinks (5e), and the oracle's upkeep of the lists (5f), below. Market lists show these
  markets as the SOL markets they are; the token page's note and the launch alert show the window.
- Step 6 (owner decisions, 2026-10-07: gated by `EARLY_ACCESS_DBC_CONFIG` alone, like trades; the builder allocation moves to step
  7): 6a the fee ledgers reconciled and watched (below); 6b a builder and check for `claim_creator_trading_fee2` /
  `claim_trading_fee2`; 6c builder claims; 6d the builder dashboard and reminders; 6e discovery; 6f the platform's DBC partner
  fee collection; 6h the verification bonus and the launch alert. Done. Early access markets are stamped with the discovery version, the builder
  allocation (when `BUILDER_ALLOCATION_CONFIGS` lists the early access config) and the verification bonus like SOL markets; the
  bonus is paid in SOL and needs no change.
- Step 7: graduation (the monitor and its operator view skip them), DAMM v2 with a Token-2022 token A (`tokenAProgram`), reconcile
  and graduated fees, and the builder allocation (`withdraw_leftover` of a Token-2022 base, then its transfer to the builder).
- Later: manual recovery of an expired early access launch (`scripts/recover-expired-launch.mjs` refuses one).

## Curve trades on the site and through Blinks (steps 5d and 5e)

- `/api/trade` (the trade panel) trades an early access market's curve once `EARLY_ACCESS_DBC_CONFIG` is set; without it the
  market is refused by name. The router reads the curve with that config, so the market goes to the curve trader
  (`src/canonical-trade.mjs`); once the curve has migrated, to the graduated trader (step 7b).
- The trader builds `swap2_with_transfer_hook` with the SDK (exact input; no referral, which needs a second hook slice) and
  checks it before the wallet signs (`assertPreparedDbcHookSwap`, `src/early-access-trade.mjs`): the amounts and the swap
  mode; one `TransferHookBase` slice with the hook's five accounts (config, allow list, base vault, hook program, its account
  list), read-only; the wallet's Token-2022 account for the token, its WSOL account and the pool's vaults; around the swap only
  the wallet's own account setup, the wrap of exactly the input (a buy), one WSOL close and the kept WSOL account's re-create.
  The receipt check reads the same accounts, the hook swap's discriminator and the wallet's Token-2022 account.
- During the window a buy from a wallet that is not on the mint's allow list is refused before anything is built: "Contributor
  early access: only this repository's linked contributors can buy until <end> UTC." (In the window's last 30 seconds the
  server's clock may differ from the chain's, so only the hook decides.) Sells go to the pool and are open to anyone. If the hook still refuses a trade in the simulation, the page shows the hook's reason (not on the list, the fair
  ramp's wallet limit, or the launch rules) instead of the generic message.
- Costs: the wallet's Token-2022 account for the token is sized by the mint's extensions (the hook adds one), like a stock's.
- A malformed `EARLY_ACCESS_DBC_CONFIG` is logged by name and refuses early access markets only; other trades go on.
- Blinks (step 5e, `app/lib/solana-actions.mjs`): offered for these markets only where the trader takes them (the setting is set
  and well formed); otherwise "not tradable". While the window is open the Blink card leads with it ("Contributor early access
  until <end> UTC: only this repository's linked contributors can buy. Anyone can sell."). Buys and sells go through the same
  trader and checks; a sell is a share of the wallet's Token-2022 account; the trader's early access refusals are shown and
  never retried without the referral.

## Fee ledgers (step 6a)

- The reconciler (`src/reconcile.mjs`) and the graduated fee reads (`src/graduated-fees.mjs`) take an early access market when a
  path that handles them passes `EARLY_ACCESS_DBC_CONFIG`: its builder fee ledger is compared with its pool's creator fee on the
  curve, and after its graduation (`earlyAccessGraduated`, step 7a) with its DAMM v2 position fees too. Every other caller still
  refuses a graduated one by name (`EARLY_ACCESS_GRADUATION_PENDING`) until the step that handles it.
- A malformed `EARLY_ACCESS_DBC_CONFIG` refuses early access markets only in the indexers as well (fee accrual, trade recorder,
  external fee indexer, live trades); before, it stopped those modules from starting.
- Step 6a's own reconcile watch (`src/early-access-reconcile.mjs`) was retired in step 7a: the graduation monitor watches these
  markets, with its fee ledger alerts.

## Graduation (step 7a)

- Where `EARLY_ACCESS_DBC_CONFIG` is set, the graduation monitor (`src/graduation-readiness.mjs`, `earlyAccessMarketSQL`) and its
  operator view take early access markets, before and after their graduation: their curve progress (read from the transfer-hook
  pool and config), the migration proof (the same `migration_damm_v2`, with the Token-2022 program for the base), their DAMM v2
  pool (token A is the Token-2022 market token, `tokenAFlag` 1; the hook was revoked by the filling swap) and positions, and the
  fee ledger alerts. Meteora's keeper migrates them as it does every other curve (owner decision, 2026-10-07; step 8 checks on
  mainnet that it does for Token-2022 pools).
- They are never eligible for liquidity deployment or builder reinvest (owner decision, 2026-10-07): the monitor shows them as not
  eligible, and `src/liquidity-deployment.mjs` and `src/builder-reinvest.mjs` refuse them by name from their stamp
  (`EARLY_ACCESS_NO_P3`, `EARLY_ACCESS_NO_REINVEST`). Their graduated partner fees are collected from step 7d on.
- The monitor checks their fee ledgers only after it read their graduation state. A market whose state read keeps failing shows
  as a graduation review and a market pass alert, not as a fee ledger alert (the same as for SOL markets); claims check their own
  amounts either way.
- Milestone posts (`src/milestone-alerts.mjs`) hold an early access market while its window is open (a post would invite buys
  the hook refuses), unless it graduated.
- The external fee indexer records their DAMM v2 position fees (builder and platform ledgers) and live trades watch their DAMM v2
  pool. The indexer also reads their curves for graduated fees before they graduate; the SDK reads each hook pool account twice
  (the plain kind first), a small RPC cost.

## The builder allocation (step 7e)

- Early access markets are stamped for the 1% builder allocation like any market (`builder_allocation_version` 1). Where
  `EARLY_ACCESS_DBC_CONFIG` is set, the allocation (`src/builder-allocation.mjs`: the claim page, the dashboard and their routes)
  enrolls them; the early access config must be listed in `BUILDER_ALLOCATION_CONFIGS` like any approved config.
- After graduation the grant is the same as for SOL markets: `withdraw_leftover` pays the curve's leftover tokens to the
  protected creator (the SDK picks Token-2022 from the config's `tokenType`), which transfers exactly 1% of the supply with
  `transferChecked` under Token-2022 to the bound wallet's Token-2022 account, with a memo just before it (so an account whose
  owner requires memos on incoming transfers still receives it). Before building it, the token must be as the
  trader requires (`assertRevokedHookMint`: hook program and authority revoked, no mint or freeze authority, only DBC's
  extensions), so the transfer needs no hook accounts. The reserve check takes `tokenType` 1 for these markets and 0 for every
  other.
- The settlement (`settleAllocation`, every market) finds the one grant transfer under SPL Token or Token-2022, to the
  recipient's account under that same program, and reads the balance under it.

## The platform's graduated fees (step 7d)

- Where `EARLY_ACCESS_DBC_CONFIG` is set, the operator's DAMM v2 fee collection (`src/platform-fees.mjs`: the operator panel, the
  per-repository route and the sweep's DAMM phase) enrolls a graduated early access market, and the monitor offers its claim
  (`platformClaimAvailable`). Without the setting it is not enrolled.
- The claim is `claim_position_fee` on the partner position with token A on Token-2022, built like the builder's
  (`graduatedClaimInstructions`, through a one-time WSOL account) and checked exactly by `assertGraduatedClaimInstructions` before
  signing and again after the network fee is added. SOL markets still use the SDK's `claimPositionFee2`, unchanged.
- The first claim opens the partner's Token-2022 account for the token (about 0.002 SOL of rent, once per market). The settlement
  (`settlePlatformClaim`, every market) now records the claim event's amount (CP-AMM's one `EvtClaimPositionFee`, for this pool
  and the partner, with no token A fee), so it equals the position's checkpoint exactly. Balance changes only bound it: the
  partner's change, its network fee and what it put into accounts left holding more (a new token account, pre-funded by anyone
  or not) must cover the claim. Before, the amount came from the partner's balance change, so a new market's first claim on an
  active pool, a pre-funded token account address or lamports sent to the partner's WSOL account could record the wrong amount
  and block the market's later claims.

## Graduated trades on the site and through Blinks (step 7b)

- Once the curve has migrated, the router sends an early access market to the graduated trader (`src/canonical-damm-trade.mjs`)
  where `EARLY_ACCESS_DBC_CONFIG` is set; without it the market is refused by name, before any read. The pool is the one the
  finalized migration names (`createGraduatedFees` with `earlyAccessGraduated`), as for every graduated market.
- The pool must have its token A on Token-2022 (`tokenAFlag` 1) and wrapped SOL on SPL Token (`assertTradablePool` with
  `token2022`), and the token must be a Token-2022 mint with only DBC's extensions (metadata pointer, metadata, transfer hook),
  no mint or freeze authority, and its hook program and hook authority revoked by the filling swap (`assertRevokedHookMint`,
  checked once per process: nothing can change it after that). The trader builds the SDK's `swap2` with token A on Token-2022.
  The check before the wallet signs (`assertPreparedSwap` with `tokenProgram`) now also checks, for every market, both token
  programs of the swap and of each account setup (the wallet's Token-2022 account for the token, its SPL WSOL account), the
  swap's pool authority, event authority and program, and its account count (14, or 15 with the instructions sysvar the SDK adds
  while a rate limiter applies). The swap needs no hook accounts. The receipt check is unchanged; it reads the Token-2022
  balances the same way.
- Anyone can buy and sell the graduated pool, also when the curve filled inside the window. The token page and the Blink card
  no longer show the window note once the market's migration is recorded (`earlyAccessNotice`: `migrated`, from
  `graduation_events`, or the page's fresh `graduated`). A referral is paid in SOL as on any graduated market; Blinks pass it
  once the migration is recorded (the curve trader leaves it out). The trade costs count the wallet's new Token-2022 account at
  its size (`estimateTradeCosts`, from step 5d).
- Known limit: if the curve fills inside the window, the oracle keeps the allow list up to date until the window ends (only
  network fees; the list's growth rent comes back when it closes).

## Builder claims (steps 6b and 6c)

- DBC pays a hook pool's fees only through `claim_creator_trading_fee2` / `claim_trading_fee2`. The SDK's builders for them send
  the SOL through the signer's permanent WSOL account, which anyone can create and fund, so `src/dbc-hook-claims.mjs` builds the
  same instruction from the SDK's parts with a one-time WSOL authority, as every other repo.ing claim does: the receiver's
  Token-2022 account for the token (the instruction names it; no token moves), the one-time WSOL account, the claim, and that
  account's close to the receiver.
- `assertHookClaimInstructions` checks exactly those four instructions before signing and again after the network fee is added:
  the discriminator, base 0, the quoted maximum, one `TransferHookBase` slice of the hook's five accounts read-only (or none once
  the curve's last swap revoked the hook), and every account in its IDL place with its signer and writable flags.
- The builder claim (`src/claim.mjs`) uses it for an early access market where `EARLY_ACCESS_DBC_CONFIG` is set; without it the
  claim is refused by name. The receipt check is unchanged (the claim emits the same event). Measured on mainnet's programs: 967
  bytes, about 51,000 to 54,000 compute units.
- Step 6d: the fee status the token page, the claim page and its preview, the builder dashboard, the reminders, the operator's
  invites and the MCP earnings tool read (`feeStatus` in `app/lib/server.mjs`, the worker's reminder reconciler) takes these
  markets where `EARLY_ACCESS_DBC_CONFIG` is set, so their earnings and claim show like any other's; the dashboard and the
  reminders list them only then. Without the setting they read as unavailable and are left out, as before.

## Builder claims after graduation (step 7c)

- Where `EARLY_ACCESS_DBC_CONFIG` is set, the builder claim, the fee status (the token page, the claim page and its preview, the
  dashboard), the worker's reminder reconciler and `scripts/reconcile-repo.mjs` read a graduated early access market's DAMM v2
  position fees too (`earlyAccessGraduated`).
- Its DAMM v2 fees are claimed with `claim_position_fee`, token A on Token-2022, through a one-time WSOL account as for every
  graduated market. For an early access market `assertGraduatedClaimInstructions` (`src/claim.mjs`) checks exactly its four
  instructions before signing and again after the network fee is added: the receiver's Token-2022 account for the token, the
  one-time WSOL account, the claim with every account in its IDL place and its flags, and the WSOL account's close.
- The curve claim and the DAMM v2 claim do not fit one transaction together (1,270 bytes, measured; the limit is 1,232). So an
  early access payout claims one of them (`earlyAccessClaimAmounts`): when both are owed, the curve part first; the DAMM v2 fees
  stay in the ledger for the next claim. The builder's first claim after graduation therefore takes two claims. The receipt
  check is unchanged.
- The claim page, the builder dashboard and the claim preview offer (and seal in the review) what the next claim pays
  (`nextClaimAmount`; the fee status of an early access market also gives `graduatedCreatorFee`), and the claim page says how much
  follows in the second claim. A review for the curve part cannot pay again: the paid total changes when it settles.
- The claim page offers no Reinvest for these markets (builder reinvest refuses them, owner decision).
- Known limits: the reminders read every market of a builder in one pass, so a graduated early access market whose read keeps
  failing delays that builder's reminder, as a SOL market's does. The curve part always goes first, so if its claim ever failed
  after the migration (a DBC change), the DAMM v2 part would wait behind it; the chain test claims both on mainnet's programs.

## Discovery rewards (step 6e)

- Where `EARLY_ACCESS_DBC_CONFIG` is set, an early access market is enrolled in discovery rewards like any other
  (`discoverySummary` with `{ earlyAccess }`, the discovery API and the worker's recovery pass it). Without it, it is not
  enrolled, as before.
- The payout is `claim_trading_fee2` from the hook pool to the claim's one-time authority (`hookClaimInstructions`, checked by
  `assertHookClaimInstructions` before signing), then exactly the reward to the launcher, the WSOL deposit back to the partner and
  the one-time authority's Token-2022 account closed to the partner. The partner spends only the network fee; the receipt check
  is unchanged (the claim emits the same event). Measured on mainnet's programs: 1,176 bytes (the longest repository ID and
  amount add about 15 bytes; the limit is 1,232), about 90,000 compute units.

## The platform's partner fees (step 6f)

- Where `EARLY_ACCESS_DBC_CONFIG` is set, the operator's DBC partner fee collection (`src/platform-dbc-fees.mjs`, behind
  `PLATFORM_DBC_COLLECTION_ENABLED` and an exact review; the operator panel, `scripts/platform-sweep.mjs` and
  `scripts/collect-dbc-platform-fees.mjs`) lists and collects an early access market's share: the pool and config are read as
  the transfer-hook accounts (`TransferHookPool`, `ConfigWithTransferHook` with this hook program, Token-2022), and the claim is
  `claim_trading_fee2` to a one-time authority (`hookClaimInstructions`, checked before signing), then exactly the amount to the
  treasury, the WSOL deposit back to the partner and the authority's Token-2022 account closed to the partner. The settlement is
  unchanged: the treasury's exact delta, the partner's network fee only, every temporary account at zero before and after, the
  quote vault's debit and the claim's event. Measured on mainnet's programs: 1,041 bytes, about 52,000 compute units.
- Without the setting these markets are not listed and are refused, as before.

## The oracle's upkeep of the lists (step 5f)

The launch puts only the launcher on the list (for its first buy) and takes it off again unless it is a linked contributor. The
worker's oracle job (`src/early-access-oracle.mjs`, once a minute while `EARLY_ACCESS_ENABLED` is "true" and
`EARLY_ACCESS_ORACLE_SECRET_KEY` is set) does the rest (owner decision, 2026-10-07):

- While a window is open, the mint's list is kept equal to the linked wallets of the repository's contributors: the snapshot taken
  when the launch was prepared (`early_access_contributors`, so nobody becomes a contributor during the window) joined with
  `github_wallet_links`. A contributor who links a wallet during the window is added at the next run (about a minute; the token
  page's note links to `/contributors/link`). Linking in the window's last two minutes may come too late.
- A wallet that is no longer linked (its account unlinked it or linked another) is removed when two runs in a row find it unlinked,
  so a bad read of the links never empties a list at once. A run that would remove more than half of a list of more than four
  wallets removes nothing and logs `held`. A market without a snapshot never loses its list.
- Adds go first, then removals; at most 24 wallets per transaction; nothing is added in the window's last 30 seconds; a list stops
  at 1,024 wallets (the rest is logged as `overflow`).
- After the window (and one more minute) the list is closed: the launch's payer gets its deposit back, the oracle what it paid for
  the list to grow.
- Each change is simulated first, sent only if it passes, and confirmed against the blockhash it was built with. Nothing is sent
  when the platform names another oracle. One run at a time (advisory lock), and a run stops sending after 45 seconds (the next
  run goes on). The oracle signs and pays: keep its key funded (fees, and about 0.00022 SOL per wallet of list growth, returned
  when the list is closed). Below 0.005 SOL it adds nothing and logs `ORACLE_LOW_BALANCE`; removals and closes go on.
- Star counts (`report_stars`) wait for the star unlock launch option.

## Build and test

    scripts/build-early-access-hook.sh                 # writes tests/fixtures/validator/early_access_hook.so
    node --test tests/early-access-hook.test.mjs       # the client (quick suite)
    node --test tests/early-access-hook-chain.test.mjs # mainnet's programs on a local validator (full suite)
    node --test tests/early-access.test.mjs            # switches, window, link message and refusals (quick suite)
    node scripts/ci/run-tests.mjs early-access-links-db # migration 0059, the link flow and its routes (PostgreSQL)
    node --test tests/early-access-launch.test.mjs     # guard, window end, contributors, v0 review, config transaction, form (quick)
    node --test tests/early-access-trade.test.mjs      # the hook swap check, the window's allow list, the hook's refusals (quick)
    node --test tests/early-access-blinks.test.mjs     # Blinks: offered where the trader takes them, the window, Token-2022 sells (quick)
    node --test tests/early-access-oracle.test.mjs     # the oracle's plan, batches, refusals and the close after the window (quick)
    node --test tests/early-access-graduation.test.mjs # graduated reads with and without the setting; the monitor's lists (quick)
    node --test tests/early-access-graduated-trade.test.mjs # the graduated pool's Token-2022 checks and the trader's gate (quick)
    node --test tests/dbc-hook-claims.test.mjs         # the hook claim check, creator and partner (quick)
    node --test tests/early-access-graduated-claims.test.mjs # the DAMM v2 claim check; one claim per payout (quick)
    node --test tests/early-access-allocation.test.mjs # the allocation settlement under Token-2022 (quick)
    node scripts/ci/run-tests.mjs early-access-launch-chain # config, platform, table, launches, trades through /api/trade and Blinks, the oracle's upkeep, the fee ledgers reconciled, the builder claim, the fee status the pages read, the discovery reward, the platform's partner fees, the graduation, trades on the graduated pool, the builder's claims after it, the platform's graduated fees, the builder allocation, sizes and the launch API (PostgreSQL + validator)

The build uses `cargo build-sbf` when present, otherwise the platform-tools toolchain it installs (v1.53). Rebuild the fixture
after any change to `programs/early-access-hook`. The chain tests start `scripts/ci/start-early-access-validator.sh` on port
8929 when nothing answers there (it also loads Metaplex, for the SPL launch the launch test compares with), and stop it after.

## Plan

1. Spike on mainnet's programs. Done.
2. The hook program and its tests. Done.
3. Database, switches and the GitHub-to-wallet link for contributors. Done.
4. The early access config and the launch (v0 transaction, lookup table, window on the form, contributor list at prepare). Done
   (dark; see above).
4b. Fair ramp and star unlocks in the program (this change). Left for the launch: the form's two options, the ramp settings
   at prepare (`vault_start` = the supply, `vault_end` = the vault's balance at 50% curve progress, from the curve), sizing
   the launcher's first buy under 2%; for the oracle: reporting stars; for trades: showing the limit and refusing a buy past
   it with its own message.
5. Curve trades, charts, lists and indexers for hook pools.
6. Claims: builder fees, builder allocation, discovery and platform fees.
7. Graduation and DAMM v2 trades with a Token-2022 market token.
8. A readiness check and a runbook; the owner deploys the program, creates the config and the lookup table, and switches it on.
