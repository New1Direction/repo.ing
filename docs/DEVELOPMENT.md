# Development

[Documentation](README.md) / Development

## Requirements

- Node.js 22; recorded verification used **22.22.3**.
- npm and the committed `package-lock.json`.
- A disposable local PostgreSQL database for persistence and database tests.
- A local Solana validator with the Meteora fixtures for chain integration tests.
- A development GitHub App for real OAuth verification, with Metadata read permission and the matching callback URL.

The installed Next.js version includes framework documentation under `node_modules/next/dist/docs/`. Read the relevant guide before changing framework behavior; APIs and conventions can differ from earlier releases.

## Install and open the app

```sh
npm ci
npm run dev
```

Open `http://localhost:3001`. Without database and chain configuration, financial functionality is unavailable. The commands above do not provision those services.

Copy the variable names from [.env.example](../.env.example) into an ignored `.env.local` file, preserving any existing local configuration. Set `APP_ORIGIN=http://localhost:3001` and use local database, validator, and disposable signer values for development. Register `http://localhost:3001/api/github/callback` on the development GitHub App.

Next.js loads `.env.local` for the web application. Standalone Node scripts and Drizzle need the variables in their process environment. With Node 22, load that same file explicitly:

```sh
# Apply migrations to the disposable database selected by .env.local.
node --env-file=.env.local ./node_modules/drizzle-kit/bin.cjs migrate --config drizzle.config.mjs

# Run one worker cycle after configuring the local chain and DBC config.
node --env-file=.env.local scripts/run-worker.mjs --once

# Or run the persistent local worker in another terminal.
node --env-file=.env.local scripts/run-worker.mjs
```

Set `DATABASE_URL` explicitly. Drizzle's fallback database is an older test default and should not be used accidentally. A mainnet config address has no corresponding account on a fresh local validator: create the local fixture config and use its returned address. The existing [Meteora fixture instructions](METEORA_SPIKE.md#reproduce) describe the programs and migration config required for local chain tests.

## Environment reference

| Variable | Used by | Purpose |
| --- | --- | --- |
| `APP_ORIGIN` | Web | Canonical application origin, OAuth callback, metadata URLs |
| `DATABASE_URL` | Web, worker, migrations | PostgreSQL connection |
| `SOLANA_RPC_URL` | Web, worker, chain tools | RPC endpoint for the intended network |
| `DBC_CONFIG` | Web, worker | Approved config for new launches |
| `DBC_LEGACY_CONFIGS` | Web, worker | Comma-separated approved configs for existing markets |
| `GITHUB_APP_CLIENT_ID` | Web | GitHub App identity used by authorization and App API access |
| `GITHUB_APP_CLIENT_SECRET` | Web | OAuth exchange, session encryption, and signed application reviews |
| `GITHUB_APP_INSTALLATION_ID` | Web | Installation used for authenticated repository metadata requests |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | Web | Base64-encoded App PEM for installation authentication |
| `PLATFORM_CREATOR_SECRET_KEY` | Web | Creator fee authority; must match the configured pool creator |
| `PLATFORM_PARTNER_SECRET_KEY` | Web | Partner authority for discovery payout signing |
| `DISCOVERY_REWARDS_ENABLED` | Web | Enables enrollment for new launches when the partner signer is configured |
| `PLATFORM_OPERATOR_GITHUB_IDS` | Web | Immutable GitHub user IDs allowed to manage platform treasury actions; empty denies access |
| `REPO_LIQUIDITY_*` | Web | Explicit execution gate and reviewed [protocol liquidity limits](PROTOCOL_LIQUIDITY.md); disabled by default and off in production (current liquidity is added manually) |
| `REPO_BUYBACK_*`, `REPO_TOKEN_MINT`, `REPO_TREASURY_TOKEN_ACCOUNT` | Web | Separate [buyback configuration](PLATFORM_REVENUE.md); execution remains disabled (current buybacks are manual; see `scripts/platform-sweep.mjs`) |
| `LAUNCH_ALERTS_ENABLED` | Worker | `true` turns on public [launch alerts](PRODUCTION.md#launch-alerts); also needs the cutoff and a configured channel |
| `LAUNCH_ALERTS_SINCE` | Worker | ISO timestamp; only markets indexed at/after it (and within 24 hours) are posted |
| `LAUNCH_ALERTS_MAX_PER_DAY` | Worker | Optional per-channel cap over 24 hours (default 15) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Worker | Telegram launch alerts: bot token and `@channel` or numeric chat id |
| `X_BOT_API_KEY`, `X_BOT_API_SECRET`, `X_BOT_ACCESS_TOKEN`, `X_BOT_ACCESS_SECRET` | Worker | X launch alerts (OAuth 1.0a user context, Read and Write); separate from `X_CLIENT_ID`/`X_CLIENT_SECRET` |

Secrets are server-only. The worker needs database/RPC/config access and signed-intent records, not either signer secret. Turning off discovery enrollment does not cancel existing reward obligations. The backup service has separate credentials described in [Backups](BACKUPS.md).

## Checks you can run without services

These commands perform no chain writes and need no live wallet:

```sh
node scripts/compare-launch-curves.mjs
node --test tests/market-config.test.mjs tests/discovery-rules.test.mjs
git diff --check
```

The curve comparison uses the pinned SDK's integer quotes. The selected tests check approved config selection and discovery reward policy. They are a small starting point, not the complete integration suite.

## Database and chain tests

Many integration tests truncate tables, seed canonical markets, or create local transactions. Run them only against their documented disposable local database and validator. Some suites enforce a particular database name or port; keep those guards in place.

| Path | Setup and evidence |
| --- | --- |
| Canonical launches and indexing | [Launch coordinator](LAUNCH_COORDINATOR.md), [indexer](LAUNCH_INDEXER.md) |
| Trades and DBC fees | [Trading](TRADE.md), [fee accrual](FEE_ACCRUAL.md), [external swaps](EXTERNAL_FEE_INDEXER.md) |
| GitHub authority and wallet binding | [GitHub verification](GITHUB_VERIFICATION.md), [wallet binding](WALLET_BINDING.md) |
| Builder claims | [Claim tests](CLAIM.md), [dashboard verification](BUILDERS.md) |
| Config rotation and graduation | [Liquidity review](LIQUIDITY_REVIEW.md), [graduated fees](GRADUATED_FEES.md) |
| Discovery | [Dedicated database and chain setup](DISCOVERY_REWARDS.md#local-verification) |
| Platform revenue and LP deployment | [Revenue controls](PLATFORM_REVENUE.md), [liquidity settlement and recovery](PROTOCOL_LIQUIDITY.md) |

Review a suite's prerequisites before running its npm command. `scripts/mvp-acceptance-local.mjs` is a historical, operator-specific live-GitHub rehearsal; it is not a generic setup script.

## Build and deploy

```sh
npm run build
npm run start
```

For deployment, follow [Production](PRODUCTION.md): apply required additive migrations, deploy a compatible worker, then web, and verify finalized indexing and reconciliation. Keep previous configs approved while their markets exist. Config creation and other mainnet actions need the separately reviewed transaction and signer authorization.

This documentation update does not establish a GitHub Actions pipeline or change Railway's deployment source. A Git push saves source; production rollout is a separate operation.

## Recovery

Git excludes `.env` files, PEMs, private keys, local databases, and generated output. To restore a production environment, use the protected secret store and [encrypted database backups](BACKUPS.md) in addition to this checkout.
