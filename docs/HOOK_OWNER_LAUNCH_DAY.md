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

1. Selected-config key (owner, single use):
   `solana-keygen new --no-bip39-passphrase --silent --outfile "$C/selected-config-canary.json"`;
   put `solana-keygen pubkey "$C/selected-config-canary.json"` into
   `decisions.selectedConfig.value`. It signs only `canary-prepare`; delete the
   file once that stage is finalized (the account it created needs no key).
2. `canary-prepare`: creator, mint, `selectedConfig="$C/selected-config-canary.json"` (plain path, no wrapper name).
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
export HOOKLAB_PRODUCTION_RPC_SECONDARY_URL=https://solana-rpc.publicnode.com
node scripts/hooklab-production-bundle.mjs --trade-table <TABLE> --approval-reference "launch-day-2026-10-18" --out config/hooklab-production-bundle.json
```

It refuses unless the gate is finalized and both configs carry the approved
economics. Commit the file; it prints the two Railway variables for it.

## 7. Server configuration (Railway)

Apply missing schema files to the production database in this order (check
first: `select table_name from information_schema.tables where table_name like 'hook_lab_%'`):
the eleven files in `HOOK_NATIVE_LAUNCH_RUNBOOK.md`, then
`hooklab-wallet-identity-quota-schema.sql`, `hooklab-native-signing-expiry-schema.sql`,
`hooklab-owner-approval-schema.sql`.

Variables (values never go in chat or Git):

| Variable | Value |
|---|---|
| `HOOK_PRODUCTION_BOOTSTRAP` | `true` |
| `HOOK_OWNER_APPROVED_LAUNCHES`, `HOOK_NATIVE_LAUNCH_ENABLED`, `HOOK_WALLET_IDENTITY_ENABLED` | `true` |
| `HOOK_WALLET_IDENTITY_ORIGIN` / `_DATABASE_URL` | existing wallet identity settings |
| `HOOK_LAUNCH_ADMIN_ADDRESS` | `DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5` |
| `HOOK_OWNER_APPROVAL_TOKEN_SHA256` | `security find-generic-password -s repoing-owner-agent -w \| tr -d '\n' \| shasum -a 256` |
| `HOOK_NATIVE_KEYRING_JSON` / `HOOK_NATIVE_ACTIVE_KEY_ID` | `{"k-2026-10":"<openssl rand -base64 32>"}` / `k-2026-10` |
| `HOOKLAB_PRODUCTION_BUNDLE_FILE` / `_SHA256` | printed by step 6 |
| `HOOKLAB_PRODUCTION_RPC_PRIMARY_URL` / `_SECONDARY_URL` | same two URLs as step 6, same order |
| `HOOKLAB_PRIORITY_MICROLAMPORTS` | `10000` recommended (about 0.000014 SOL per customer transaction) |
| `HOOK_INCLUSIVE_TRADING_ENABLED` | `true` only at public activation |

The owner-agent token: `openssl rand -hex 32 | pbcopy`, then
`security add-generic-password -s repoing-owner-agent -a "$USER" -w` and paste
at its prompt. On start-up the server logs either nothing or
`Hook Lab production bootstrap refused: <reason>`.

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
