# Contributor early access

An opt-in launch option. For a window the launcher picks (15 minutes to 24 hours), only wallets linked to the repository's
contributors can buy the token; anyone can sell to the curve at any time. It is enforced on chain by a Token-2022 transfer
hook, `programs/early-access-hook`, on its own Meteora DBC config. Launches without the option, and every existing market,
are unchanged.

Status: the hook program and its tests; the database, switches and the contributor wallet link (step 3), all dark. No launch
uses the hook yet; nothing is deployed.

## Decisions (owner, 2026-10-05)

| Question | Decision |
| --- | --- |
| What the hook does | Early access only. A "ship to unlock" lock, if built, is a separate lock vault for SPL tokens, because Meteora removes the hook at graduation. |
| Which launches | The launcher selects it on the launch form. |
| Window | The launcher selects it: 15 minutes to 24 hours (the program caps it at 24 hours). |
| Launcher | Gets the first buy in the launch transaction only, then is taken off the list unless a contributor. |
| Contributor | A GitHub account with at least 1 commit in the repository (GitHub's contributor list), bots excluded, with a wallet linked to that account on repo.ing. |
| Fee | Flat 1.75% (the `builders` curve), not the anti-sniper launch fee: during the window only contributors can buy. |

## The program

Program id `Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep` (its keypair is in the main checkout's git-ignored `secrets/`).
Anchor 1.2. Client: `src/early-access-hook.mjs`.

**Accounts**

| Account | Address | Holds |
| --- | --- | --- |
| Platform | `["platform"]` | admin (repo.ing's launch co-signer) and oracle (keeps lists current) |
| Mint config | `["config", mint]` | repository id, window end, rent receiver and its deposit, the list's bump |
| Allow list | `["allow", mint]` | sorted wallet keys (at most 1,024), read by binary search and changed in place (never copied to the 32 KiB heap) |
| Extra account metas | `["extra-account-metas", mint]` | tells Token-2022 to pass the mint config and the allow list |

Both extra accounts are derived from the mint alone. Meteora's DBC SDK resolves a hook's accounts with the default key as
source, destination and owner, so an account seeded from the receiver (one "pass" per wallet) would break its swap and claim
builders. One list per mint also works for Phantom, Jupiter and any other client.

**The rule** (`transfer_hook`, run by Token-2022 on every transfer). Until `early_access_end`, a transfer of more than 0
tokens goes through only to
- a token account owned by Meteora DBC's pool authority `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` (a sell), or
- an associated token account (ImmutableOwner) whose owner is on the allow list. Any other token account could change owner
  after receiving, which would let a contributor pass tokens on.

After the window every transfer goes through, and the hook no longer reads the list.

**Instructions**

| Instruction | Who | What |
| --- | --- | --- |
| `init_platform` | the program's upgrade authority, once | sets admin and oracle (neither may be the default key) |
| `set_platform` | admin | changes admin and oracle |
| `init_mint` | admin authorizes, `payer` pays | window end (now < end <= now + 24 h; there is no "off"), first wallets; creates the three mint accounts. No instruction changes the window later. |
| `add_wallets` | oracle only, during the window | up to 24 wallets per call; the oracle pays for the larger list |
| `remove_wallets` | oracle or admin | up to 24 wallets per call; the launch transaction uses it with the admin's signature |
| `close_allow_list` | anyone, after the window | the payer of `init_mint` gets its deposit back, the oracle the rest |

Errors (Anchor numbers from 6000): NotUpgradeAuthority, NotAdmin, NotOracle, BadWindow, TooManyWallets, WindowClosed,
WindowOpen, BadAllowList, BadDestination, NotAssociatedAccount (6009), NotContributor (6010), MathOverflow, BadKey.
`hookErrorName` names them from the hook's own failure line only: DBC and Token-2022 report the same numbers.

**What people trust.** The oracle decides who is on a list; it cannot change a window. The admin sets a token's window once
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

- Program account: about 2.4 SOL for 345,696 bytes (returned if the program is closed).
- Lookup table: about 0.004 SOL.
- Per launch: the three mint accounts, about 0.004 SOL, paid by the launcher; the list's share comes back when it is closed.

## Switches, database and the contributor wallet link (step 3)

**Switches** (`src/early-access.mjs`). `EARLY_ACCESS_ENABLED` (exactly "true") opens the contributor wallet link; anything
else answers 404 on its page, its API and its GitHub sign-in. Launches also need the code gate `EARLY_ACCESS_LAUNCHES_READY`,
which stays `false` until the launch, trades, claims and graduation for hook pools exist (`earlyAccessLaunchable`). Settings,
names only for now: `EARLY_ACCESS_DBC_CONFIG`, `EARLY_ACCESS_LOOKUP_TABLE`, `EARLY_ACCESS_ORACLE_SECRET_KEY` (errors name the
variable, never its value). The window is a whole number of seconds from 900 to 86,400 (`earlyAccessWindow`); the form offers
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

## Build and test

    scripts/build-early-access-hook.sh                 # writes tests/fixtures/validator/early_access_hook.so
    node --test tests/early-access-hook.test.mjs       # the client (quick suite)
    node --test tests/early-access-hook-chain.test.mjs # mainnet's programs on a local validator (full suite)
    node --test tests/early-access.test.mjs            # switches, window, link message and refusals (quick suite)
    node scripts/ci/run-tests.mjs early-access-links-db # migration 0059, the link flow and its routes (PostgreSQL)

The build uses `cargo build-sbf` when present, otherwise the platform-tools toolchain it installs (v1.53). Rebuild the fixture
after any change to `programs/early-access-hook`. The chain test starts `scripts/ci/start-early-access-validator.sh` on port
8929 when nothing answers there, and stops it after.

## Plan

1. Spike on mainnet's programs. Done.
2. The hook program and its tests. Done.
3. Database, switches and the GitHub-to-wallet link for contributors. This change.
4. The early access config and the launch (v0 transaction, lookup table, window on the form, contributor list at prepare).
5. Curve trades, charts, lists and indexers for hook pools.
6. Claims: builder fees, builder allocation, discovery and platform fees.
7. Graduation and DAMM v2 trades with a Token-2022 market token.
8. A readiness check and a runbook; the owner deploys the program, creates the config and the lookup table, and switches it on.
