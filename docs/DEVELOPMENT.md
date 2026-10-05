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
| `APP_ORIGIN` | Web, worker | Canonical application origin, OAuth callback, metadata URLs; the worker uses it for alert and reminder links |
| `DATABASE_URL` | Web, worker, migrations | PostgreSQL connection |
| `SOLANA_RPC_URL` | Web, worker, chain tools | RPC endpoint for the intended network |
| `DBC_CONFIG` | Web, worker | Approved config for new launches |
| `DBC_LEGACY_CONFIGS` | Web, worker | Comma-separated approved configs for existing markets |
| `GITHUB_APP_CLIENT_ID` | Web, worker | GitHub App identity used by authorization and App API access (worker: Dev Pulse, the fork guard backfill and the verification bonus) |
| `GITHUB_APP_CLIENT_SECRET` | Web | OAuth exchange, session encryption, and signed application reviews |
| `GITHUB_APP_INSTALLATION_ID` | Web, worker | Installation used for authenticated repository metadata requests |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | Web, worker | Base64-encoded App PEM for installation authentication |
| `PLATFORM_CREATOR_SECRET_KEY` | Web | Creator fee authority; must match the configured pool creator |
| `PLATFORM_PARTNER_SECRET_KEY` | Web | Partner authority for discovery payout signing |
| `DISCOVERY_REWARDS_ENABLED` | Web | Enables enrollment for new launches when the partner signer is configured |
| `PLATFORM_OPERATOR_GITHUB_IDS` | Web | Immutable GitHub user IDs allowed to manage platform treasury actions; empty denies access |
| `REPO_LIQUIDITY_*` | Web, worker | Explicit execution gate and reviewed [protocol liquidity limits](PROTOCOL_LIQUIDITY.md); disabled by default and off in production (current liquidity is added manually). The worker reads the limits only to report readiness |
| `REPO_BUYBACK_*`, `REPO_TOKEN_MINT`, `REPO_TREASURY_TOKEN_ACCOUNT` | Web | Separate [buyback configuration](PLATFORM_REVENUE.md); execution remains disabled (current buybacks are manual; see `scripts/platform-sweep.mjs`) |
| `LAUNCH_ALERTS_ENABLED` | Worker | `true` turns on public [launch alerts](PRODUCTION.md#launch-alerts); also needs the cutoff and a configured channel |
| `LAUNCH_ALERTS_SINCE` | Worker | ISO timestamp; only markets indexed at/after it (and within 24 hours) are posted |
| `LAUNCH_ALERTS_MAX_PER_DAY` | Worker | Optional per-channel cap over 24 hours (default 15) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Worker | Telegram launch and milestone alerts: bot token and `@channel` or numeric chat id |
| `X_BOT_API_KEY`, `X_BOT_API_SECRET`, `X_BOT_ACCESS_TOKEN`, `X_BOT_ACCESS_SECRET` | Worker | X launch and milestone alerts (OAuth 1.0a user context, Read and Write); separate from `X_CLIENT_ID`/`X_CLIENT_SECRET` |
| `GRADUATION_ALERTS_ENABLED` | Worker | `true` turns on public [graduation milestone alerts](PRODUCTION.md#graduation-milestone-alerts) (25/50/75/90% and graduation) on the launch-alert channels; also needs the cutoff. Off by default |
| `GRADUATION_ALERTS_SINCE` | Worker | ISO timestamp; nothing runs before it, and the first sight of each market after it only records the milestone already reached (no backfill) |
| `GRADUATION_ALERTS_MAX_PER_DAY` | Worker | Optional per-channel cap on milestone posts over 24 hours (default 10), separate from the launch-alert cap |
| `STOCK_COLLECTIONS_EXECUTION_ENABLED`, `STOCK_LAUNCHER_PAYOUTS_ENABLED` | Worker, owner's machine | `true` lets `scripts/stock-execute.mjs --execute` collect stock-pair fees and pay launchers (keys from the macOS Keychain), and lets the worker finish what it left pending, without a key. Off by default; see [stock execution](STOCK_QUOTES.md#execution-off-by-default) |
| `HF_MARKETS_ENABLED` | Web, worker | `true` turns on Hugging Face model markets on web; on the worker it adds them to launch and milestone alerts. Keep the two the same ([alerts setup](ALERTS_SETUP.md)) |
| `PROMOTION_EXCLUDED_REPO_IDS` | Web, worker | [Do-not-promote list](PRODUCTION.md#do-not-promote-list): comma-separated GitHub repository IDs left out of `/waiting`, the graduation race, "Repo markets to watch" and milestone alerts |
| `SERVER_TIMING_SLOW_MS` | Web | Optional: log `slowLoader` lines for data loaders slower than this many milliseconds (default 150; see [response speed](PRODUCTION.md#response-speed-indexes-caches-edge-caching-and-real-user-vitals)) |

Secrets are server-only. The worker needs database/RPC/config access and signed-intent records, not either signer secret. Stock-pair collections and launcher payouts are signed only on the owner's machine (`scripts/stock-execute.mjs --execute`, keys from the macOS Keychain); the worker only finishes them. Turning off discovery enrollment does not cancel existing reward obligations. The backup service has separate credentials described in [Backups](BACKUPS.md).

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
| Graduation race and milestone alerts | `tests/graduation-race-db.test.mjs` and `tests/milestone-alerts-db.test.mjs` with `GRADUATION_RACE_TEST_DATABASE_URL` / `MILESTONE_ALERTS_TEST_DATABASE_URL` pointing at local databases named `repoing_graduation_race_test` / `repoing_milestone_alerts_test`; their pure logic runs in the quick suite (`node scripts/ci/run-quick-tests.mjs`) |
| Read indexes, chart block positions, trend view and web vitals | `tests/server-speed-db.test.mjs` with `SERVER_SPEED_TEST_DATABASE_URL` pointing at a local database named `repoing_server_speed_test` (migrates it, seeds, checks EXPLAIN plans); the pure helpers run in the quick suite |
| Model markets in launch and milestone alerts, and the read-only alerts preview | `tests/alerts-models-db.test.mjs` with `ALERTS_MODELS_TEST_DATABASE_URL` pointing at a local database named `repoing_alerts_models_test`; the copy, `scripts/alerts-check.mjs` and `scripts/alerts-preview.mjs` run in the quick suite (`tests/model-alerts.test.mjs`, `tests/alerts-check.test.mjs`, `tests/alerts-preview.test.mjs`) |
| Maintainer opt-outs | `tests/maintainer-opt-outs-db.test.mjs` with `MAINTAINER_OPT_OUTS_TEST_DATABASE_URL` pointing at a local database named `repoing_opt_outs_test` (create/withdraw authorization, one active decision, constraints); the exclusion union and launch blocks run in the quick suite (`tests/maintainer-opt-outs.test.mjs`) |

Review a suite's prerequisites before running its npm command. `scripts/mvp-acceptance-local.mjs` is a historical, operator-specific live-GitHub rehearsal; it is not a generic setup script.

## Build and deploy

```sh
npm run build
npm run start
```

For deployment, follow [Production](PRODUCTION.md): apply required additive migrations, deploy a compatible worker, then web, and verify finalized indexing and reconciliation. Keep previous configs approved while their markets exist. Config creation and other mainnet actions need the separately reviewed transaction and signer authorization.

CI (`.github/workflows/test.yml`) runs on every pull request and every push to `main`: the quick tests and `next build` are required before a merge, and the full PostgreSQL and validator suite reports afterwards. CI does not deploy. A Git push saves source; production rollout is a separate operation.

## Recovery

Git excludes `.env` files, PEMs, private keys, local databases, and generated output. To restore a production environment, use the protected secret store and [encrypted database backups](BACKUPS.md) in addition to this checkout.
