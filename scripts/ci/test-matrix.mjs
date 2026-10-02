// Environment each test file expects. Several integration suites assert an exact,
// dedicated disposable database URL (a guard against pointing them at production), so a
// single `node --test tests/*.test.mjs` run cannot satisfy them all. The CI runner groups
// files by the environment below; every file not listed runs in the default group.

export const RPC_URL = 'http://127.0.0.1:8909'

// One PostgreSQL server listens on PRIMARY_PORT; the runner exposes it on the other
// ports the tests pin (the ports themselves are part of the tests' safety assertions).
export const PRIMARY_PORT = 55432
export const ALIAS_PORTS = [55439, 55441, 55443, 55459]

// Roles some suites connect as. Created as disposable superusers on the throwaway server.
export const ROLES = ['discoverytest', 'dbc_test']

const launchtest = name => `postgres://postgres:launchtest@127.0.0.1:55432/${name}`
const trusted = (port, name, user = 'postgres') => `postgres://${user}@127.0.0.1:${port}/${name}`

// Databases that files in the default group fall back to when DATABASE_URL is unset.
// The runner recreates and migrates them before the default group runs.
export const DEFAULT_GROUP_DATABASES = [
  launchtest('gitfun_launch'), launchtest('gitfun_claim'), launchtest('gitfun_reconcile'),
  launchtest('gitfun_bind'), launchtest('gitfun_verify'), launchtest('gitfun_lookup'),
  launchtest('gitfun_external_fees'), trusted(55443, 'repoing_builders'),
  // Opt-in real-PostgreSQL suites (skipped when their URL variable is unset); see DEFAULT_ENV.
  launchtest('repoing_tips_test'), launchtest('repoing_trade_sessions_test'), launchtest('repoing_referrals_test'), launchtest('repoing_x_links_test'),
  launchtest('repoing_parts_test'), launchtest('repoing_backers_test'), launchtest('repoing_launch_alerts_test'),
  launchtest('repoing_trust_test'), launchtest('repoing_trending_test'), launchtest('repoing_market_quality_test'),
  launchtest('repoing_graduation_race_test'), launchtest('repoing_milestone_alerts_test'), launchtest('repoing_server_speed_test'),
  launchtest('repoing_opt_outs_test'),
  // Required (not opt-in) by replica-state, which is listed in needs-services.txt.
  launchtest('repoing_launch_sessions_test'),
  launchtest('repoing_verification_bonus_test'),
  launchtest('repoing_payout_address_test'),
]

const scratchDb = trusted(55441, 'postgres')

export const DEFAULT_ENV = {
  SOLANA_RPC_URL: RPC_URL,
  CHART_TEST_DATABASE_URL: scratchDb,
  TEST_DATABASE_URL: scratchDb,
  TIP_TEST_DATABASE_URL: launchtest('repoing_tips_test'),
  PARTS_TEST_DATABASE_URL: launchtest('repoing_parts_test'),
  TRADE_SESSIONS_TEST_DATABASE_URL: launchtest('repoing_trade_sessions_test'),
  REFERRALS_TEST_DATABASE_URL: launchtest('repoing_referrals_test'),
  X_LINKS_TEST_DATABASE_URL: launchtest('repoing_x_links_test'),
  BACKERS_TEST_DATABASE_URL: launchtest('repoing_backers_test'),
  LAUNCH_ALERTS_TEST_DATABASE_URL: launchtest('repoing_launch_alerts_test'),
  TRUST_TEST_DATABASE_URL: launchtest('repoing_trust_test'),
  TRENDING_TEST_DATABASE_URL: launchtest('repoing_trending_test'),
  MARKET_QUALITY_TEST_DATABASE_URL: launchtest('repoing_market_quality_test'),
  GRADUATION_RACE_TEST_DATABASE_URL: launchtest('repoing_graduation_race_test'),
  MILESTONE_ALERTS_TEST_DATABASE_URL: launchtest('repoing_milestone_alerts_test'),
  SERVER_SPEED_TEST_DATABASE_URL: launchtest('repoing_server_speed_test'),
  MAINTAINER_OPT_OUTS_TEST_DATABASE_URL: launchtest('repoing_opt_outs_test'),
  LAUNCH_SESSIONS_TEST_DATABASE_URL: launchtest('repoing_launch_sessions_test'),
  VERIFICATION_BONUS_TEST_DATABASE_URL: launchtest('repoing_verification_bonus_test'),
  PAYOUT_ADDRESS_TEST_DATABASE_URL: launchtest('repoing_payout_address_test'),
  // Production default; graduation-guards asserts the ambient environment keeps P3 execution off.
  REPO_LIQUIDITY_EXECUTION_ENABLED: 'false',
}

export const PINNED_GROUPS = [
  { files: ['builder-allocation', 'graduated-fees'], databaseUrl: trusted(55443, 'repoing_graduation') },
  { files: ['builder-binding'], databaseUrl: trusted(55443, 'repoing_builders') },
  { files: ['builder-payouts'], databaseUrl: trusted(55443, 'repoing_builder_feed') },
  { files: ['builder-reinvest'], databaseUrl: launchtest('repoing_reinvest_test') },
  // selfManaged: the test creates, migrates and drops this database itself; the runner only drops leftovers.
  { files: ['graduation-migration'], databaseUrl: launchtest('repoing_p5_upgrade_test'), selfManaged: true },
  { files: ['graduation-readiness'], databaseUrl: launchtest('repoing_p5_test') },
  { files: ['liquidity-deployment'], databaseUrl: launchtest('repoing_liquidity_test') },
  { files: ['protocol-analytics'], databaseUrl: launchtest('repoing_analytics_test'), selfManaged: true },
  { files: ['reserve-alerts-integration'], databaseUrl: launchtest('repoing_reserve_alert_test'), selfManaged: true },
  { files: ['trend-integration'], databaseUrl: launchtest('repoing_p6_test'), selfManaged: true },
  { files: ['config-rotation'], databaseUrl: launchtest('repoing_config_rotation_test') },
  { files: ['launch-fee-chain'], databaseUrl: launchtest('repoing_launch_fee_test') },
  { files: ['discovery-claims'], databaseUrl: trusted(55439, 'discovery_test', 'discoverytest') },
  { files: ['platform-dbc-fees'], databaseUrl: trusted(55459, 'repoing_dbc_collection_test', 'dbc_test') },
]
