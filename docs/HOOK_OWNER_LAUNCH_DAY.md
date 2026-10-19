# Hook Lab owner launch day

Owner-run steps from the paused deploy to public trading. Every signing step is
`plan` (read-only, prints the exact message and its sha256) then `execute` with
that sha256. Keys are opened one at a time by the frozen signer
(`hooks-local-state/keyserve`); macOS asks once per key (login password, then
**Allow**, never Always Allow). Nothing here prints or stores a secret.

Stop at any step whose plan differs from what is written here. If an execute
fails, do not rerun blindly: keep the run directory and share only the error and
public addresses.

## Shell setup (each new terminal)

```sh
cd ~/Documents/ChatGPT/repoing-hooks-release
K=~/Documents/ChatGPT/hooks-local-state/keyserve/with-custody-keys.sh
C="$HOME/Library/Application Support/Hook Lab Custody"
PAYER="payer=$C/mainnet-canary-v1/material/primary:operational-payer"
ADMIN="admin=$C/custody-da8970c2-1b18-4dc7-a4bc-9f096e42d5cc/primary:owner-admin"
UPGRADE="upgrade=$C/production-upgrade-authority-v1/material/primary:production-upgrade-authority"
CREATOR="creator=$C/controlled-test-identities-v1/material/primary:dedicated-creator"
MINT="mint=$C/controlled-test-identities-v1/material/primary:separate-mint"
H="node scripts/hooklab-owner.mjs"
CFG="$HOME/.hooklab-owner/mainnet.config.json"   # your private copy with your approvals (never committed)
```

Reads use two public providers by default (api.mainnet-beta.solana.com and
solana.publicnode.com) and verify the mainnet genesis on both.

Pattern for every signing stage (example: `launch-config`):

```sh
$H plan launch-config                       # read; note "message sha256"
$K "$PAYER" "$ADMIN" -- $H execute launch-config --message-sha256 <SHA> --key payer={payer} --key admin={admin}
```

Stages marked **approval flag** also need `--approved <stage>:<SHA>`.
Before a stage, set `"approved": true` on each decision it lists in
`hooklab-owner.config.json` (the plan names any that are still unapproved).

## 1. Deploy (paused, code only)

```sh
cd ~/Documents/ChatGPT/hooks-local-state/keyserve
shasum -a 256 REVIEW-MANIFEST.sha256   # 442576543a2c632683c41467594fa56475f618a2a07fabac41c7a9dcff910951
shasum -a 256 -c REVIEW-MANIFEST.sha256
./hooklab-deploy.sh --reviewed 442576543a2c632683c41467594fa56475f618a2a07fabac41c7a9dcff910951
```

Type DEPLOY, then three Keychain prompts (payer, upgrade authority, gate program
key). Peak 4.148 SOL, worst-case spend 1.440 SOL, payer keeps at least 2.81 SOL.

## 2. Verify (read-only)

`$H status` must show launch, swap and gate code equal to the reviewed hashes
and both configs still paused at revision 0.

## 3. Owner configuration

| Stage | Signers | Cost | Effect |
|---|---|---|---|
| `launch-config` | payer, admin | 0.00001 SOL | creator fee ceilings 100 -> 200 bps (menu 0.5/1/2%) |
| `swap-config` | payer, admin | 0.00001 SOL | launch protocol share 2500 (repo.ing gets floor(fee/4)), protocol fee 0 |
| `grant` | payer, admin | 0.00102 SOL rent + fee | one launch for canary creator DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9 |
| `gate-finalize` **approval flag, irreversible** | payer, upgrade | 0.00001 SOL | gate BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb becomes immutable |
| `fund` **approval flag** | payer | transfers | creator 0.05, admin 0.05, treasury 0.001 SOL |

The admin's 0.05 SOL pays for per-launch lookup tables (0.0097 SOL rent each,
returned by the agent's `reclaim`); the treasury's 0.001 keeps it rent-exempt so
fee sweeps land.

## 4. Canary (private, controlled creator)

1. Selected-config key (owner, single use, encrypted in custody):
   `~/Documents/ChatGPT/hooks-local-state/owner-tools/hooklab-oneshot-key canary-selected-config-v1 selected-config`
   generates the key in memory, stores only its AES-GCM envelope in custody and the wrapping key in
   your login Keychain, and prints the public address. Put that address into
   `decisions.selectedConfig.value`. It signs only `canary-prepare` and controls nothing afterwards.
2. `canary-prepare`: creator, mint, selectedConfig, opened together:
   `$K "$CREATOR" "$MINT" "selected=$C/canary-selected-config-v1/primary:selected-config" -- $H execute canary-prepare --config "$CFG" --message-sha256 <SHA> --key creator={creator} --key mint={mint} --key selectedConfig={selected}`
3. `alt` twice: payer (creates the canary table, 0.0097 SOL rent).
4. `canary-gates-open-creation` **approval flag**: payer, admin.
5. `canary-launch`: creator, mint, admin.
6. `canary-gates-close-creation`: payer, admin.
7. `canary-holdings`: creator.
8. `canary-buy` then `canary-sell` **approval flag**: creator, admin (each atomically opens trading, trades, closes trading).
9. `collect`: creator (permissionless SOL sweep: creator share to the creator, floor(gross/4) to treasury FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i).

Local validator runs of steps 3-4 pass at fee/cap 0.5%/1%, 1%/2% and 2%/5%,
using only the 0.05 SOL funded to the creator.

## 5. Shared trade table

`trade-table` **approval flag** twice: payer. First run creates the table of the
16 addresses every trade shares; second run freezes it (irreversible, 0.00484 SOL
rent locked). The final plan prints the table address for the bundle.

## 6. Production bundle (read-only)

```sh
export HOOKLAB_PRODUCTION_RPC_PRIMARY_URL=...   # the Helius URL Railway uses (from your password manager)
export HOOKLAB_PRODUCTION_RPC_SECONDARY_URL=https://api.mainnet-beta.solana.com
node scripts/hooklab-production-bundle.mjs --trade-table <TABLE> --approval-reference "launch-day-2026-10-18" --out config/hooklab-production-bundle.json
```

It refuses unless the gate is finalized and both configs carry the approved
economics. Commit the file; it prints the two Railway variables for it.

## 7. Server configuration (Railway)

Project `repo-ing` (507c3e92-c0a7-4c83-8622-172e88509b68), service `web`, environment `production`.
Hooks run only in `web`. The Postgres service has no public endpoint, so database work runs inside the
`web` container through `railway ssh`.

```sh
R="-p 507c3e92-c0a7-4c83-8622-172e88509b68 -s web -e production"
```

**Schema** (checked 2026-10-18: 0 of the 14 tables exist; only the planner's two
`hook_lab_recipe_*` tables). `check` is read-only; `apply` runs all 14 files in one transaction,
refuses if any table exists, and only for the reviewed SQL hash:

```sh
node scripts/hooklab-production-schema.mjs show           # files, tables, sha256
node scripts/hooklab-production-schema.mjs check | railway ssh $R -- node
node scripts/hooklab-production-schema.mjs apply --sha256 2e4968864c9deaf3c8a03f8732cc0bd353c86e195835907c348398fd029f55b0 | railway ssh $R -- node
```

**Settings** (`--skip-deploys`: nothing restarts until the app deploy). The Helius URL is reused by
reference (`SOLANA_RPC_URL` is the existing Helius variable), never copied:

```sh
railway variable set $R --skip-deploys HOOK_WALLET_IDENTITY_ENABLED=true HOOK_WALLET_IDENTITY_ORIGIN=https://repo.ing \
  'HOOK_WALLET_IDENTITY_DATABASE_URL=${{ Postgres.DATABASE_URL }}' HOOK_NATIVE_LAUNCH_ENABLED=true HOOK_OWNER_APPROVED_LAUNCHES=true \
  HOOK_LAUNCH_ADMIN_ADDRESS=DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5 HOOK_NATIVE_ACTIVE_KEY_ID=k-2026-10 \
  'HOOKLAB_PRODUCTION_RPC_PRIMARY_URL=${{ SOLANA_RPC_URL }}' HOOKLAB_PRODUCTION_RPC_SECONDARY_URL=https://api.mainnet-beta.solana.com \
  HOOKLAB_PRIORITY_MICROLAMPORTS=10000
```

After step 6: `HOOKLAB_PRODUCTION_BUNDLE_FILE=config/hooklab-production-bundle.json`,
`HOOKLAB_PRODUCTION_BUNDLE_SHA256=<printed>`, then `HOOK_PRODUCTION_BOOTSTRAP=true`.
At public activation only: `HOOK_INCLUSIVE_TRADING_ENABLED=true`.

**Credentials** (values never shown, written to disk or put in arguments; every Keychain read asks
you first). `T=~/Documents/ChatGPT/hooks-local-state/owner-tools` (hashes in `REVIEW-MANIFEST.sha256`):

```sh
$T/hooklab-server-secrets token        # agent token -> Keychain; prints HOOK_OWNER_APPROVAL_TOKEN_SHA256=...
$T/hooklab-server-secrets keyring      # server key ring -> Keychain
railway variable set $R --skip-deploys HOOK_OWNER_APPROVAL_TOKEN_SHA256=<printed hash>
security find-generic-password -s repoing-hook-keyring -w | tr -d '\n' | railway variable set $R --skip-deploys HOOK_NATIVE_KEYRING_JSON --stdin
```

The key ring travels Keychain -> pipe -> Railway only. The admin key never goes to the server. On
start-up the server logs either nothing or `Hook Lab production bootstrap refused: <reason>`.

## 8. Owner agent (while launches are open)

```sh
export HOOK_OWNER_APPROVAL_TOKEN="$(security find-generic-password -s repoing-owner-agent -w)"
$K "$ADMIN" -- node scripts/hooklab-owner-agent.mjs --admin-key '{admin}' --rpc https://api.mainnet-beta.solana.com --rpc2 https://solana-rpc.publicnode.com
```

For each customer: `customer-grant --creator <wallet>` (payer, admin), then
`invite N` in the agent. The agent creates that launch's lookup table, then
signs the launch only if it decodes to exactly the invited coin. Run `reclaim`
after launches to return table rent.

## 9. Public activation (separate approval)

`open-launches` and `open-trading` **approval flag**: payer, admin. Customer
launches and trades need both. Emergency stop: `close-trading`, `close-launches`.

## 10. $5k USD launch pricing (separate approval)

Every launch then opens at about a $5,000 market cap and graduates at about $45,000.
repo.ing fixes the SOL price (median of CoinGecko, Jupiter and Coinbase, within 2%) and the
virtual quote when you `invite`. A source more than 2% from the median of all answers is ignored
(and shown as ignored); at least two must remain, within 2% of each other. The agent re-reads SOL from your Mac, records the
invite only if the server's price is within 3% of its own read, and then signs only that quote.

Both the agent and the server read the live launch config before an invite is recorded and refuse
an opening the chain would reject, for example `On-chain limits are 1–1 SOL, but this launch would
open at 53.25 SOL. Sign the launch-usd-bounds change first.` The server reads it through
`HOOKLAB_PRODUCTION_RPC_PRIMARY_URL` and `HOOKLAB_PRODUCTION_RPC_SECONDARY_URL` (step 7).

**Rollout order**, with no launch in flight:

1. Apply the migration: `migration-check launch-pricing`, then `migrate launch-pricing --sha256 <printed>`
   (step 7 commands; one new insert-only table).
2. Sign `launch-usd-bounds` (**approval flag**: payer, admin). It sets the launch config's min/max
   virtual quote to 5.625 and 112.5 SOL (SOL at $1,000 down to $50); the preview lists exactly those
   two fields and the new governance commitment.
3. Refresh the bundle pins: re-collect the production bundle (step 6); the launch-config and
   creation-control pins change.
4. Upgrade the owner agent to this release (an older agent never checks the opening price).
5. Deploy with `HOOK_LAUNCH_USD_PRICING=true` and the new bundle variables.

Keep the bounds change (2) and the flag deploy (5) together: between them every launch fails on
chain (1 SOL is below the new minimum) and invites are refused, so nothing launches at the old
price. In the agent, `list` and `invite` then print the fixed price, for example
`Opens at ≈$5,000 (53.25 SOL virtual), graduates at ≈$45,000 / 106.5 SOL raised · SOL $105.63 (…)`.
