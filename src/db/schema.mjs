import { bigint, bigserial, boolean, char, check, doublePrecision, index, integer, jsonb, numeric, pgSequence, pgTable, primaryKey, serial, smallint, text, timestamp, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// Migration 0049: tables of GitHub-only features refuse Hugging Face market ids (src/market-identity.mjs).
const githubOnly = (table, t) => check(`${table}_github_only`, sql`${t.githubRepoId} < 4503599627370496`)

export const agentRequestLimits = pgTable('agent_request_limits', {
  scope: text('scope').primaryKey(), hits: integer('hits').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, table => [check('agent_request_limits_hits_check', sql`${table.hits} > 0`), index('agent_request_limits_expiry').on(table.expiresAt)])

export const builderReminders = pgTable('builder_reminders', {
  githubUserId: bigint('github_user_id', {mode:'bigint'}).primaryKey(),
  email: text('email').notNull(), revision: varchar('revision',{length:32}).notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
  verifiedAt: timestamp('verified_at',{withTimezone:true}), lastSentAt: timestamp('last_sent_at',{withTimezone:true}),
  nextCheckAt: timestamp('next_check_at',{withTimezone:true}).defaultNow().notNull(),
  baseline: text('baseline').notNull().default('{}'), delivery: text('delivery'),
})
export const builderReminderRequests = pgTable('builder_reminder_requests', {
  key: varchar('key',{length:64}).primaryKey(),
  requestedAt: timestamp('requested_at',{withTimezone:true}).notNull(),
})

// Finalized block order, agreed by two RPCs. Derived chart evidence, not a fee ledger.
export const finalizedChartBlocks = pgTable('finalized_chart_blocks', {
  slot: bigint('slot', { mode: 'bigint' }).primaryKey(),
  blockhash: varchar('blockhash', { length: 44 }).notNull(),
  previousBlockhash: varchar('previous_blockhash', { length: 44 }).notNull(),
  parentSlot: bigint('parent_slot', { mode: 'bigint' }).notNull(),
  signatures: text('signatures').array().notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
})
// Each indexed trade's position in its recorded block (derived from finalized_chart_blocks, so immutable): chart reads
// order trades without de-TOASTing the full signature list.
export const finalizedChartPositions = pgTable('finalized_chart_positions', {
  slot: bigint('slot', { mode: 'bigint' }).notNull().references(() => finalizedChartBlocks.slot),
  signature: varchar('signature', { length: 88 }).notNull(),
  transactionIndex: integer('transaction_index').notNull(),
}, t => [primaryKey({ name: 'finalized_chart_positions_pkey', columns: [t.slot, t.signature] }),
  check('finalized_chart_positions_transaction_index_check', sql`${t.transactionIndex} > 0`)])

// P5 observations are derived read models. Migration evidence and alerts are durable;
// none of these tables credits revenue or authorizes spending.
export const graduationObservations = pgTable('graduation_observations', {
  githubRepoId: bigint('github_repo_id', {mode:'bigint'}).primaryKey().references(()=>markets.githubRepoId),
  checkedAt: timestamp('checked_at',{withTimezone:true}).notNull(),
  status: varchar('status',{length:32}).notNull(),
  observation: text('observation'),
  reconciliation: text('reconciliation'),
  errorCode: text('error_code'),
})
export const graduationEvents = pgTable('graduation_events', {
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).primaryKey().references(()=>markets.githubRepoId),
  signature: varchar('signature',{length:88}).notNull(),
  pool: varchar('pool',{length:44}).notNull(),
  slot: bigint('slot',{mode:'bigint'}).notNull(),
  evidenceHash: varchar('evidence_hash',{length:64}).notNull(),
  evidence: text('evidence').notNull(),
  previousObservation: text('previous_observation'),
  reconciliation: text('reconciliation').notNull(),
  recordedAt: timestamp('recorded_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[uniqueIndex('graduation_signature_unique').on(t.signature,t.githubRepoId),uniqueIndex('graduation_pool_unique').on(t.pool)])
// Verified once from finalized history; every read reloads the signature and must reproduce the row.
export const graduatedMigrationProofs = pgTable('graduated_migration_proofs', {
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).primaryKey().references(()=>markets.githubRepoId),
  curve: varchar('curve',{length:44}).notNull(), config: varchar('config',{length:44}).notNull(),
  mint: varchar('mint',{length:44}).notNull(), pool: varchar('pool',{length:44}).notNull(),
  signature: varchar('signature',{length:88}).notNull(), slot: bigint('slot',{mode:'bigint'}).notNull(),
  creatorPosition: varchar('creator_position',{length:44}).notNull(), creatorNftAccount: varchar('creator_nft_account',{length:44}).notNull(),
  creatorNftMint: varchar('creator_nft_mint',{length:44}).notNull(), partnerPosition: varchar('partner_position',{length:44}).notNull(),
  partnerNftAccount: varchar('partner_nft_account',{length:44}).notNull(), partnerNftMint: varchar('partner_nft_mint',{length:44}).notNull(),
  recordedAt: timestamp('recorded_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[uniqueIndex('graduated_migration_proof_pool_unique').on(t.pool),uniqueIndex('graduated_migration_proof_signature_unique').on(t.signature)])
// Public $REPOING buyback disclosures detected from finalized wallet history (disclosure only).
export const buybackReceipts = pgTable('buyback_receipts', {
  signature: varchar('signature',{length:88}).primaryKey(), source: varchar('source',{length:16}).notNull(),
  wallet: varchar('wallet',{length:44}).notNull(), mint: varchar('mint',{length:44}).notNull(),
  spentLamports: numeric('spent_lamports',{precision:20,scale:0}).notNull(), tokenBaseUnits: numeric('token_base_units',{precision:30,scale:0}).notNull(),
  blockTime: timestamp('block_time',{withTimezone:true}).notNull(), slot: bigint('slot',{mode:'bigint'}).notNull(),
  detectedAt: timestamp('detected_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[check('buyback_receipts_source_check',sql`${t.source} in ('custody','team')`),
  check('buyback_receipts_spent_lamports_check',sql`${t.spentLamports} > 0`),check('buyback_receipts_token_base_units_check',sql`${t.tokenBaseUnits} > 0`)])
export const buybackReceiptCursors = pgTable('buyback_receipt_cursors', {
  wallet: varchar('wallet',{length:44}).primaryKey(), lastSignature: varchar('last_signature',{length:88}).notNull(),
  lastSlot: bigint('last_slot',{mode:'bigint'}).notNull(), updatedAt: timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
})
export const graduationAlerts = pgTable('graduation_alerts', {
  id: serial('id').primaryKey(),
  eventKey: text('event_key').notNull(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).references(()=>markets.githubRepoId),
  kind: varchar('kind',{length:48}).notNull(),
  detail: text('detail').notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
  acknowledgedAt: timestamp('acknowledged_at',{withTimezone:true}),
  acknowledgedBy: text('acknowledged_by'),
},t=>[uniqueIndex('graduation_alert_event_unique').on(t.eventKey),
  index('graduation_alerts_open_repo_kind').on(t.githubRepoId,t.kind,t.id).where(sql`${t.acknowledgedAt} is null`),
  index('graduation_alerts_kind').on(t.kind,t.id)])
export const dammTradeEvents = pgTable('damm_trade_events', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(()=>markets.githubRepoId),
  pool: varchar('pool',{length:44}).notNull(),
  signature: varchar('signature',{length:88}).notNull(),
  eventIndex: integer('event_index').notNull(),
  slot: bigint('slot',{mode:'bigint'}).notNull(),
  tradedAt: timestamp('traded_at',{withTimezone:true}).notNull(),
  quoteAmount: bigint('quote_amount',{mode:'bigint'}).notNull(),
  nextSqrtPrice: text('next_sqrt_price'),
  direction: varchar('direction',{length:4}).notNull(),
  evidence: text('evidence').notNull(),
  trader: varchar('trader',{length:44}),
  baseAmount: bigint('base_amount',{mode:'bigint'}),
},t=>[uniqueIndex('damm_trade_chain_event_unique').on(t.signature,t.eventIndex),
  index('damm_trade_trader_repo').on(t.trader,t.githubRepoId).where(sql`${t.trader} is not null`),
  // INCLUDE (quote_amount) in migration 0038: per-repository volume sums read the index only.
  index('damm_trade_events_repo_slot').on(t.githubRepoId,t.slot.desc(),t.eventIndex.desc()),
  check('damm_trade_amount_check',sql`${t.quoteAmount}>0`),check('damm_trade_direction_check',sql`${t.direction} in ('buy','sell')`),
  check('damm_trade_base_amount_check',sql`${t.baseAmount} is null or ${t.baseAmount}>=0`)])

export const trendCandidates = pgTable('trend_candidates', {
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).primaryKey(),
  fullName: text('full_name').notNull(),
  description: text('description'),
  state: varchar('state',{length:16}).notNull().default('detected'),
  revision: integer('revision').notNull().default(0),
  observedAt: timestamp('observed_at',{withTimezone:true}).notNull(),
  attemptedAt: timestamp('attempted_at',{withTimezone:true}).defaultNow().notNull(),
  detectedAt: timestamp('detected_at',{withTimezone:true}).defaultNow().notNull(),
  error: text('error'),
  approvedConfig: varchar('approved_config',{length:44}),
  approvedDiscoveryVersion: integer('approved_discovery_version'),
  approvedWindowMs: bigint('approved_window_ms',{mode:'bigint'}),
  approvedAt: timestamp('approved_at',{withTimezone:true}),
},t=>[check('trend_state_check',sql`${t.state} in ('detected','reviewed','approved','launched','active','rejected','duplicate')`),githubOnly('trend_candidates',t)])
export const trendObservations = pgTable('trend_observations', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(()=>trendCandidates.githubRepoId),
  observedAt: timestamp('observed_at',{withTimezone:true}).notNull(),
  evidence: text('evidence').notNull(),
  evidenceHash: varchar('evidence_hash',{length:64}).notNull(),
},t=>[uniqueIndex('trend_observation_unique').on(t.githubRepoId,t.observedAt),githubOnly('trend_observations',t)])
export const trendSignals = pgTable('trend_signals', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(()=>trendCandidates.githubRepoId),
  source: varchar('source',{length:32}).notNull(),
  url: text('url').notNull(),
  note: text('note').notNull(),
  occurredAt: timestamp('occurred_at',{withTimezone:true}).notNull(),
  expiresAt: timestamp('expires_at',{withTimezone:true}).notNull(),
  detectedAt: timestamp('detected_at',{withTimezone:true}).defaultNow().notNull(),
  operator: text('operator'),
},t=>[uniqueIndex('trend_signal_unique').on(t.githubRepoId,t.source,t.url),githubOnly('trend_signals',t)])
export const trendReviews = pgTable('trend_reviews', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(()=>trendCandidates.githubRepoId),
  fromState: varchar('from_state',{length:16}).notNull(),
  toState: varchar('to_state',{length:16}).notNull(),
  operator: text('operator').notNull(),
  evidence: text('evidence').notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[githubOnly('trend_reviews',t)])
export const trendLaunches = pgTable('trend_launches', {
  mint: varchar('mint',{length:44}).primaryKey(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(()=>trendCandidates.githubRepoId),
  wallet: varchar('wallet',{length:44}).notNull(),
  config: varchar('config',{length:44}).notNull(),
  candidateRevision: integer('candidate_revision').notNull(),
  evidence: text('evidence').notNull(),
  preparedAt: timestamp('prepared_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[githubOnly('trend_launches',t)])
export const trendSourceHealth = pgTable('trend_source_health', {
  source: text('source').primaryKey(),
  status: text('status').notNull(),
  checkedAt: timestamp('checked_at',{withTimezone:true}).defaultNow().notNull(),
  detail: text('detail').notNull(),
})

// Hugging Face model registry (0049): one market id (market_ref, from hf_market_ref_seq) per model _id; both are frozen.
export const hfMarketRefSeq = pgSequence('hf_market_ref_seq', { startWith: '4503599627370497', minValue: '4503599627370497', maxValue: '7000000000000000', cycle: false })
export const hfModels = pgTable('hf_models', {
  marketRef: bigint('market_ref', { mode: 'bigint' }).primaryKey().default(sql`nextval('hf_market_ref_seq')`),
  hfId: char('hf_id', { length: 24 }).notNull(), repoPath: text('repo_path').notNull(), ownerHandle: text('owner_handle').notNull(),
  ownerKind: varchar('owner_kind', { length: 8 }).notNull(), ownerSubject: char('owner_subject', { length: 24 }),
  private: boolean('private').default(false).notNull(), disabled: boolean('disabled').default(false).notNull(), gated: boolean('gated').default(false).notNull(),
  baseModels: jsonb('base_models').default(sql`'[]'::jsonb`).notNull(),
  pathConfirmedAt: timestamp('path_confirmed_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [unique('hf_models_hf_id_unique').on(t.hfId),
  check('hf_models_market_ref_check', sql`${t.marketRef} between 4503599627370497 and 7000000000000000`),
  check('hf_models_hf_id_check', sql`${t.hfId} ~ '^[0-9a-f]{24}$'`),
  check('hf_models_repo_path_check', sql`char_length(${t.repoPath}) between 1 and 200`),
  check('hf_models_owner_handle_check', sql`char_length(${t.ownerHandle}) between 1 and 100`),
  check('hf_models_owner_kind_check', sql`${t.ownerKind} in ('user', 'org')`),
  check('hf_models_owner_subject_check', sql`${t.ownerSubject} is null or ${t.ownerSubject} ~ '^[0-9a-f]{24}$'`),
  check('hf_models_base_models_check', sql`jsonb_typeof(${t.baseModels}) = 'array'`)])

export const repositories = pgTable('repositories', {
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).primaryKey(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  fullName: text('full_name').notNull(),
  description: text('description'),
  avatarUrl: text('avatar_url'),
  stars: integer('stars').notNull(),
  forks: integer('forks').notNull(),
  archived: boolean('archived').notNull(),
  githubUpdatedAt: timestamp('github_updated_at', { withTimezone: true }).notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
  // Migration 0045; null until GitHub is next read (app/lib/repo-quality.mjs then judges by stars alone).
  githubCreatedAt: timestamp('github_created_at', { withTimezone: true }),
  // Migration 0049: the id range decides the source; a Hugging Face row's id is its own hf_models.market_ref.
  source: varchar('source', { length: 16 }).default('github').notNull(),
  hfModelRef: bigint('hf_model_ref', { mode: 'bigint' }).references(() => hfModels.marketRef),
}, t => [check('repositories_source_range', sql`(${t.source} = 'github' and ${t.githubRepoId} < 4503599627370496 and ${t.hfModelRef} is null) or (${t.source} = 'huggingface' and ${t.githubRepoId} between 4503599627370497 and 7000000000000000 and ${t.hfModelRef} is not distinct from ${t.githubRepoId})`)])

export const markets = pgTable('markets', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  status: varchar('status', { length: 16 }).notNull(),
  mint: varchar('mint', { length: 44 }),
  pool: varchar('pool', { length: 44 }),
  launcherWallet: varchar('launcher_wallet', { length: 44 }).notNull(),
  creatorWallet: varchar('creator_wallet', { length: 44 }).notNull(),
  tokenName: text('token_name').notNull(),
  tokenSymbol: varchar('token_symbol', { length: 16 }).notNull(),
  tokenImage: text('token_image'),
  launchSignature: varchar('launch_signature', { length: 88 }),
  blockhash: varchar('blockhash', { length: 44 }),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }),
  launchSlot: bigint('launch_slot', { mode: 'bigint' }),
  launchFinality: varchar('launch_finality', { length: 16 }),
  indexedAt: timestamp('indexed_at', { withTimezone: true }),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  discoveryVersion: integer('discovery_version'),
  builderAllocationVersion: integer('builder_allocation_version'),
  launchBlockTime: timestamp('launch_block_time', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // One-time maintainer-verification bonus stamped on NEW launches (0047); the stamp is this market's policy.
  verificationBonusLamports: bigint('verification_bonus_lamports', { mode: 'bigint' }),
  // Migration 0053: all null for SOL; a stock-paired market's registry asset, exact mint and registry version, stamped at
  // reservation and immutable once its launch was sent (src/quote-assets.mjs, trigger protect_market_quote).
  quoteAssetId: varchar('quote_asset_id', { length: 32 }),
  quoteMint: varchar('quote_mint', { length: 44 }),
  quoteRegistryVersion: integer('quote_registry_version'),
}, (table) => [
  uniqueIndex('markets_github_repo_id_unique').on(table.githubRepoId),
  uniqueIndex('markets_mint_unique').on(table.mint),
  uniqueIndex('markets_pool_unique').on(table.pool),
  uniqueIndex('markets_launch_signature_unique').on(table.launchSignature),
  check('markets_status_check', sql`${table.status} in ('reserved', 'prepared', 'submitted', 'confirmed', 'failed', 'ambiguous')`),
  check('markets_discovery_version_check', sql`${table.discoveryVersion} is null or ${table.discoveryVersion} in (1,2)`),
  check('markets_builder_allocation_version_check', sql`${table.builderAllocationVersion} is null or ${table.builderAllocationVersion} = 1`),
  check('markets_verification_bonus_lamports_check', sql`${table.verificationBonusLamports} is null or ${table.verificationBonusLamports} between 1000000 and 1000000000`),
  check('markets_confirmed_evidence_check', sql`${table.status} <> 'confirmed' or (${table.mint} is not null and ${table.pool} is not null and ${table.launchSignature} is not null)`),
  check('markets_indexed_evidence_check', sql`${table.indexedAt} is null or (${table.launchSlot} is not null and ${table.launchFinality} = 'finalized' and ${table.lastVerifiedAt} is not null)`),
  // A model market never carries the verification bonus (0049); it may carry the builder allocation (0052).
  check('markets_hf_no_bonus', sql`${table.githubRepoId} < 4503599627370496 or ${table.verificationBonusLamports} is null`),
  index('markets_quote_asset_idx').on(table.quoteAssetId).where(sql`${table.quoteAssetId} is not null`),
  check('markets_quote_asset_check', sql`(${table.quoteAssetId} is null and ${table.quoteMint} is null and ${table.quoteRegistryVersion} is null) or (${table.quoteAssetId} is not null and ${table.quoteMint} is not null and ${table.quoteRegistryVersion} is not null and ${table.quoteAssetId} ~ '^[a-z0-9][a-z0-9-]{1,31}$' and ${table.quoteAssetId} <> 'sol' and ${table.quoteMint} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' and ${table.quoteMint} <> 'So11111111111111111111111111111111111111112' and ${table.quoteRegistryVersion} >= 1 and ${table.githubRepoId} < 4503599627370496)`),
])

// All DBC partner fees share this evidence ledger; eligibility preserves the
// original discovery window. Builder earnings never include these rows.
export const discoveryFeeEvents = pgTable('discovery_fee_events', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => markets.githubRepoId),
  pool: varchar('pool', { length: 44 }).notNull(),
  signature: varchar('signature', { length: 88 }).notNull(),
  eventIndex: integer('event_index').notNull(),
  partnerAmount: bigint('partner_amount', { mode: 'bigint' }).notNull(),
  discoveryEligible: boolean('discovery_eligible').notNull().default(true),
  slot: bigint('slot', { mode: 'bigint' }).notNull(),
  tradedAt: timestamp('traded_at', { withTimezone: true }).notNull(),
}, table => [
  uniqueIndex('discovery_fee_events_chain_unique').on(table.signature, table.eventIndex),
  check('discovery_fee_events_positive_check', sql`${table.partnerAmount} > 0`),
])

export const discoveryClaims = pgTable('discovery_claims', {
  id: varchar('id', { length: 36 }).primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => markets.githubRepoId),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  // Null while a message-authorized claim is 'prepared'; the server-signed payout once 'pending' (0035).
  transaction: text('transaction'),
  signature: varchar('signature', { length: 88 }),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  resolutionReason: text('resolution_reason'),
  // The exact message the launcher wallet signs, its expiry, and the wallet's signature (null on legacy rows).
  authMessage: text('auth_message'),
  authExpiresAt: timestamp('auth_expires_at', { withTimezone: true }),
  authSignature: varchar('auth_signature', { length: 88 }),
}, table => [
  uniqueIndex('discovery_claims_signature_unique').on(table.signature),
  uniqueIndex('discovery_claims_one_active').on(table.githubRepoId).where(sql`${table.status} in ('prepared', 'pending')`),
  check('discovery_claims_amount_check', sql`${table.amount} > 0 and ${table.amount} <= 2500000000`),
  check('discovery_claims_status_check', sql`${table.status} in ('prepared', 'pending', 'settled', 'aborted')`),
  check('discovery_claims_evidence_check', sql`(${table.status} not in ('pending', 'settled') or ${table.signature} is not null) and (${table.status} <> 'settled' or ${table.settledAt} is not null)`),
  check('discovery_claims_authorization_check', sql`(${table.authMessage} is null and ${table.authExpiresAt} is null and ${table.authSignature} is null
    and ${table.transaction} is not null and ${table.lastValidBlockHeight} is not null) or
    (${table.authMessage} is not null and ${table.authExpiresAt} is not null and (
      (${table.status} in ('prepared', 'aborted') and ${table.transaction} is null and ${table.lastValidBlockHeight} is null and ${table.authSignature} is null) or
      (${table.status} in ('pending', 'settled', 'aborted') and ${table.transaction} is not null and ${table.lastValidBlockHeight} is not null and ${table.authSignature} is not null)))`),
])

// One maintainer-verification bonus per market (0047), accrued by the worker from the repository's first admin
// verification. 'ineligible' records failed rules; eligible rows wait in 'pending_review' for an operator.
export const verificationBonuses = pgTable('verification_bonuses', {
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).primaryKey().references(() => markets.githubRepoId),
  status: varchar('status', { length: 16 }).notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  launcherWallet: varchar('launcher_wallet', { length: 44 }).notNull(),
  verificationId: integer('verification_id').notNull().references(() => repoVerifications.id),
  verifierGithubUserId: bigint('verifier_github_user_id', { mode: 'bigint' }).notNull(),
  verifierLogin: text('verifier_login').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
  evidence: jsonb('evidence').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewerGithubUserId: bigint('reviewer_github_user_id', { mode: 'bigint' }),
  reviewerLogin: text('reviewer_login'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approverGithubUserId: bigint('approver_github_user_id', { mode: 'bigint' }),
  approverLogin: text('approver_login'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
}, table => [
  index('verification_bonuses_launcher').on(table.launcherWallet),
  check('verification_bonuses_status_check', sql`${table.status} in ('pending_review', 'ineligible', 'approved', 'rejected', 'paid')`),
  check('verification_bonuses_amount_check', sql`${table.amount} between 1000000 and 1000000000`),
  check('verification_bonuses_reason_check', sql`(${table.status} in ('ineligible', 'rejected')) = (${table.reason} is not null)`),
  check('verification_bonuses_review_check', sql`(${table.status} in ('approved', 'rejected', 'paid')) = (${table.reviewedAt} is not null and ${table.reviewerGithubUserId} is not null)`),
  check('verification_bonuses_paid_check', sql`(${table.status} = 'paid') = (${table.paidAt} is not null)`),
  check('verification_bonuses_approval_check', sql`(${table.status} not in ('approved', 'paid') or (${table.approvedAt} is not null and ${table.approverGithubUserId} is not null)) and (${table.status} not in ('pending_review', 'ineligible') or (${table.approvedAt} is null and ${table.approverGithubUserId} is null))`),
  githubOnly('verification_bonuses', table),
])

// Durable bonus payout intents: signed bytes saved as 'pending' before the first broadcast; one live or settled
// payout per bonus (partial unique index) and a unique idempotency key per attempt.
export const verificationBonusPayouts = pgTable('verification_bonus_payouts', {
  id: uuid('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => verificationBonuses.githubRepoId),
  attempt: integer('attempt').notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 80 }).notNull(),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  payer: varchar('payer', { length: 44 }).notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  memo: text('memo').notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  signature: varchar('signature', { length: 88 }).notNull(),
  signedTransaction: text('signed_transaction').notNull(),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }).notNull(),
  networkFee: bigint('network_fee', { mode: 'bigint' }),
  slot: bigint('slot', { mode: 'bigint' }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionReason: text('resolution_reason'),
}, table => [
  uniqueIndex('verification_bonus_payouts_signature_unique').on(table.signature),
  uniqueIndex('verification_bonus_payouts_idempotency_unique').on(table.idempotencyKey),
  uniqueIndex('verification_bonus_payouts_one_live').on(table.githubRepoId).where(sql`${table.status} in ('pending', 'settled')`),
  index('verification_bonus_payouts_status').on(table.status, table.createdAt),
  check('verification_bonus_payouts_status_check', sql`${table.status} in ('pending', 'settled', 'aborted')`),
  check('verification_bonus_payouts_amount_check', sql`${table.amount} between 1000000 and 1000000000`),
  check('verification_bonus_payouts_attempt_check', sql`${table.attempt} > 0`),
  check('verification_bonus_payouts_wallets_check', sql`${table.wallet} <> ${table.payer}`),
  check('verification_bonus_payouts_state_check', sql`(${table.status} = 'pending' and ${table.settledAt} is null and ${table.resolvedAt} is null and ${table.resolutionReason} is null and ${table.networkFee} is null) or (${table.status} = 'settled' and ${table.settledAt} is not null and ${table.networkFee} is not null and ${table.slot} is not null and ${table.resolvedAt} is null and ${table.resolutionReason} is null) or (${table.status} = 'aborted' and ${table.settledAt} is null and ${table.resolvedAt} is not null and ${table.resolutionReason} is not null)`),
  githubOnly('verification_bonus_payouts', table),
])

export const feeEvents = pgTable('fee_events', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  mint: varchar('mint', { length: 44 }).notNull(),
  pool: varchar('pool', { length: 44 }).notNull(),
  signature: varchar('signature', { length: 88 }).notNull(),
  eventIndex: integer('event_index').notNull(),
  amountBaseUnits: bigint('amount_base_units', { mode: 'bigint' }).notNull(),
  asset: varchar('asset', { length: 44 }).notNull(),
  kind: varchar('kind', { length: 32 }).notNull(),
  slot: bigint('slot', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('fee_events_chain_event_unique').on(table.signature, table.eventIndex, table.kind),
  // INCLUDE (amount_base_units) in migration 0038: builder_fee_credits sums read the index only.
  index('fee_events_repo_slot').on(table.githubRepoId, table.slot.desc(), table.eventIndex.desc()),
  index('fee_events_pool_signature').on(table.pool, table.signature),
  check('fee_events_positive_amount_check', sql`${table.amountBaseUnits} > 0`),
  check('fee_events_kind_check', sql`${table.kind} = 'dbc_creator_quote'`),
])

export const poolFeeCursors = pgTable('pool_fee_cursors', {
  pool: varchar('pool', { length: 44 }).primaryKey(),
  lastSignature: varchar('last_signature', { length: 88 }).notNull(),
  lastSlot: bigint('last_slot', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const tradeEvents = pgTable('trade_events', {
  id: serial('id').primaryKey(),
  pool: varchar('pool', { length: 44 }).notNull(),
  signature: varchar('signature', { length: 88 }).notNull(),
  eventIndex: integer('event_index').notNull(),
  slot: bigint('slot', { mode: 'bigint' }).notNull(),
  tradedAt: timestamp('traded_at', { withTimezone: true }).notNull(),
  direction: varchar('direction', { length: 4 }).notNull(),
  inputBaseUnits: varchar('input_base_units', { length: 20 }).notNull(),
  outputBaseUnits: varchar('output_base_units', { length: 20 }).notNull(),
  nextSqrtPrice: varchar('next_sqrt_price', { length: 40 }).notNull(),
  trader: varchar('trader', { length: 44 }),
}, (table) => [
  uniqueIndex('trade_events_chain_event_unique').on(table.signature, table.eventIndex),
  index('trade_events_trader_pool').on(table.trader, table.pool).where(sql`${table.trader} is not null`),
  index('trade_events_pool_slot').on(table.pool, table.slot.desc(), table.eventIndex.desc()),
  index('trade_events_pool_time').on(table.pool, table.tradedAt),
  check('trade_events_direction_check', sql`${table.direction} in ('buy', 'sell')`),
])

export const repoVerifications = pgTable('repo_verifications', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  githubUserId: bigint('github_user_id', { mode: 'bigint' }).notNull(),
  githubLogin: text('github_login').notNull(),
  permission: varchar('permission', { length: 16 }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('repo_verifications_admin_check', sql`${table.permission} = 'admin'`),
])

// Migrations 0050/0051: who is behind a binding, a pasted address or a maintainer decision. A GitHub row names a GitHub
// user id; a Hugging Face row names Hugging Face subjects (24-hex _ids: the signed-in user's OIDC sub and, for payouts, the
// model owner's _id at the time). Exactly one kind per row, matching the market id's source.
const sourceRange = (name, t) => check(name, sql`(${t.authoritySource} = 'github' and ${t.githubRepoId} < 4503599627370496) or (${t.authoritySource} = 'huggingface' and ${t.githubRepoId} between 4503599627370497 and 7000000000000000)`)
const bindingAuthority = (name, t) => check(name, sql`(${t.authoritySource} = 'github' and ${t.githubUserId} is not null and ${t.authoritySubject} is null and ${t.authorityOwnerSubject} is null) or (${t.authoritySource} = 'huggingface' and ${t.githubUserId} is null and ${t.authoritySubject} is not null and ${t.authoritySubject} ~ '^[0-9a-f]{24}$' and ${t.authorityOwnerSubject} is not null and ${t.authorityOwnerSubject} ~ '^[0-9a-f]{24}$')`)

// A fresh Hugging Face authority check (0051, src/hf-verification.mjs), the model-market counterpart of repo_verifications.
export const modelVerifications = pgTable('model_verifications', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  hfId: char('hf_id', { length: 24 }).notNull(), subject: char('subject', { length: 24 }).notNull(), username: text('username').notNull(),
  ownerKind: varchar('owner_kind', { length: 8 }).notNull(), ownerSubject: char('owner_subject', { length: 24 }).notNull(),
  role: varchar('role', { length: 16 }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('model_verifications_recent').on(t.githubRepoId, t.subject, t.verifiedAt),
  check('model_verifications_market_range', sql`${t.githubRepoId} between 4503599627370497 and 7000000000000000`),
  check('model_verifications_hf_id_check', sql`${t.hfId} ~ '^[0-9a-f]{24}$'`),
  check('model_verifications_subject_check', sql`${t.subject} ~ '^[0-9a-f]{24}$' and ${t.ownerSubject} ~ '^[0-9a-f]{24}$'`),
  check('model_verifications_username_check', sql`char_length(${t.username}) between 1 and 100`),
  check('model_verifications_role_check', sql`(${t.ownerKind} = 'user' and ${t.role} = 'owner' and ${t.ownerSubject} = ${t.subject}) or (${t.ownerKind} = 'org' and ${t.role} = 'admin' and ${t.ownerSubject} <> ${t.subject})`)])

export const walletBindingChallenges = pgTable('wallet_binding_challenges', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  // Null for a Hugging Face challenge (0051).
  githubUserId: bigint('github_user_id', { mode: 'bigint' }),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  nonce: varchar('nonce', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  authoritySource: varchar('authority_source', { length: 16 }).default('github').notNull(),
  authoritySubject: char('authority_subject', { length: 24 }),
  authorityOwnerSubject: char('authority_owner_subject', { length: 24 }),
}, (table) => [
  uniqueIndex('wallet_binding_challenges_nonce_unique').on(table.nonce),
  bindingAuthority('wallet_binding_challenges_authority_check', table),
  check('wallet_binding_challenges_hf_range', sql`${table.authoritySource} <> 'huggingface' or ${table.githubRepoId} between 4503599627370497 and 7000000000000000`),
])

// The repository's one active payout binding, read by every payout path. method (0048): 'signature' (the wallet signed
// a binding message; instant) or 'pasted' (a pasted address, written here only when its request activates after the
// hold; a database trigger rejects any other pasted row). A model market's binding (0051) names the Hugging Face user who
// made it and the model owner's _id at the time; claims refuse it once the model has another owner (src/claim.mjs).
export const repoBeneficiaries = pgTable('repo_beneficiaries', {
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).primaryKey().references(() => repositories.githubRepoId),
  // Null for a Hugging Face binding (0051).
  githubUserId: bigint('github_user_id', { mode: 'bigint' }),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  boundAt: timestamp('bound_at', { withTimezone: true }).defaultNow().notNull(),
  method: varchar('method', { length: 16 }).default('signature').notNull(),
  payoutRequestId: bigint('payout_request_id', { mode: 'bigint' }).references(() => payoutAddressRequests.id),
  authoritySource: varchar('authority_source', { length: 16 }).default('github').notNull(),
  authoritySubject: char('authority_subject', { length: 24 }),
  authorityOwnerSubject: char('authority_owner_subject', { length: 24 }),
}, table => [
  check('repo_beneficiaries_method_check', sql`(${table.method} = 'signature' and ${table.payoutRequestId} is null) or (${table.method} = 'pasted' and ${table.payoutRequestId} is not null)`),
  bindingAuthority('repo_beneficiaries_authority_check', table),
  sourceRange('repo_beneficiaries_source_range', table),
])

// Pasted payout addresses waiting out their hold (0048, src/payout-address.mjs). At most one pending request per
// repository; an insert always starts pending with the hold measured from that moment (trigger
// start_payout_address_request); resolved requests are kept as history and never change (guard_payout_address_request).
export const payoutAddressRequests = pgTable('payout_address_requests', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  // Null for a Hugging Face request (0051), which names requested_by_subject and requested_by_owner_subject instead.
  requestedByGithubUserId: bigint('requested_by_github_user_id', { mode: 'bigint' }),
  requestedByLogin: text('requested_by_login').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
  activeAt: timestamp('active_at', { withTimezone: true }).notNull(),
  // bound_at of the binding this request would replace when it was stored (trigger start_payout_address_request).
  replacesBoundAt: timestamp('replaces_bound_at', { withTimezone: true }),
  status: varchar('status', { length: 16 }).default('pending').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedByGithubUserId: bigint('resolved_by_github_user_id', { mode: 'bigint' }),
  resolutionReason: text('resolution_reason'),
  authoritySource: varchar('authority_source', { length: 16 }).default('github').notNull(),
  requestedBySubject: char('requested_by_subject', { length: 24 }),
  requestedByOwnerSubject: char('requested_by_owner_subject', { length: 24 }),
  resolvedBySubject: char('resolved_by_subject', { length: 24 }),
}, table => [
  check('payout_address_requests_authority_check', sql`(${table.authoritySource} = 'github' and ${table.requestedByGithubUserId} is not null and ${table.requestedBySubject} is null and ${table.requestedByOwnerSubject} is null and ${table.resolvedBySubject} is null) or (${table.authoritySource} = 'huggingface' and ${table.requestedByGithubUserId} is null and ${table.resolvedByGithubUserId} is null and ${table.requestedBySubject} is not null and ${table.requestedBySubject} ~ '^[0-9a-f]{24}$' and ${table.requestedByOwnerSubject} is not null and ${table.requestedByOwnerSubject} ~ '^[0-9a-f]{24}$' and (${table.resolvedBySubject} is null or ${table.resolvedBySubject} ~ '^[0-9a-f]{24}$'))`),
  sourceRange('payout_address_requests_source_range', table),
  uniqueIndex('payout_address_requests_one_pending').on(table.githubRepoId).where(sql`${table.status} = 'pending'`),
  index('payout_address_requests_due').on(table.activeAt).where(sql`${table.status} = 'pending'`),
  check('payout_address_requests_status_check', sql`${table.status} in ('pending', 'activated', 'cancelled', 'superseded')`),
  check('payout_address_requests_wallet_check', sql`${table.wallet} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`),
  check('payout_address_requests_user_check', sql`${table.requestedByGithubUserId} > 0`),
  check('payout_address_requests_hold_check', sql`${table.activeAt} >= ${table.requestedAt} + interval '48 hours'`),
  check('payout_address_requests_resolution_check', sql`(${table.status} = 'pending') = (${table.resolvedAt} is null)`),
  check('payout_address_requests_reason_check', sql`${table.status} not in ('cancelled', 'superseded') or ${table.resolutionReason} is not null`),
])

// Append-only audit log of pasted payout addresses (0048): requested, cancelled, superseded, and activated (by itself,
// so with no GitHub user).
export const payoutAddressEvents = pgTable('payout_address_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  requestId: bigint('request_id', { mode: 'bigint' }).notNull().references(() => payoutAddressRequests.id),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  event: varchar('event', { length: 16 }).notNull(),
  githubUserId: bigint('github_user_id', { mode: 'bigint' }),
  githubLogin: text('github_login'),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  previousWallet: varchar('previous_wallet', { length: 44 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // The Hugging Face user behind an event on a model market (0051); github_user_id is null then.
  actorSubject: char('actor_subject', { length: 24 }),
}, table => [
  index('payout_address_events_repo').on(table.githubRepoId, table.createdAt),
  check('payout_address_events_event_check', sql`${table.event} in ('requested', 'cancelled', 'superseded', 'activated')`),
  check('payout_address_events_actor_check', sql`(${table.event} = 'activated') = (${table.githubUserId} is null and ${table.actorSubject} is null) and (${table.githubUserId} is null or ${table.githubRepoId} < 4503599627370496) and (${table.actorSubject} is null or (${table.actorSubject} ~ '^[0-9a-f]{24}$' and ${table.githubRepoId} between 4503599627370497 and 7000000000000000))`),
])

// One grant per market, ever (0011). A claim names its authority like a binding (0052): a GitHub user id, or for a model
// market the Hugging Face user's sub and the model owner's _id at claim time.
export const builderAllocationClaims = pgTable('builder_allocation_claims', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => markets.githubRepoId),
  // Null for a Hugging Face claim (0052).
  githubUserId: bigint('github_user_id', { mode: 'bigint' }),
  mint: varchar('mint', { length: 44 }).notNull(),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  signature: varchar('signature', { length: 88 }).notNull(),
  signedTransaction: text('signed_transaction').notNull(),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  resolutionReason: text('resolution_reason'),
  authoritySource: varchar('authority_source', { length: 16 }).default('github').notNull(),
  authoritySubject: char('authority_subject', { length: 24 }),
  authorityOwnerSubject: char('authority_owner_subject', { length: 24 }),
}, table => [
  uniqueIndex('builder_allocation_signature_unique').on(table.signature),
  uniqueIndex('builder_allocation_one_payout').on(table.githubRepoId).where(sql`${table.status} in ('pending','settled')`),
  check('builder_allocation_amount_check', sql`${table.amount} = 10000000000000`),
  check('builder_allocation_status_check', sql`${table.status} in ('pending','settled','aborted')`),
  check('builder_allocation_settlement_check', sql`(${table.status} = 'settled') = (${table.settledAt} is not null)`),
  bindingAuthority('builder_allocation_claims_authority_check', table),
  sourceRange('builder_allocation_claims_source_range', table),
])

export const repositoryParticipation = pgTable('repository_participation', {
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).primaryKey().references(() => markets.githubRepoId),
  githubUserId: bigint('github_user_id', { mode: 'bigint' }).notNull(),
  githubLogin: text('github_login').notNull(),
  enabled: boolean('enabled').notNull(),
  optedInAt: timestamp('opted_in_at', { withTimezone: true }).notNull(),
}, table => [githubOnly('repository_participation', table)])

// Operator-reviewed maintainer invitations. Dismissal is permanent; an invite snoozes 30 days.
export const maintainerInvites = pgTable('maintainer_invites', {
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).primaryKey().references(() => repositories.githubRepoId),
  invitedAt: timestamp('invited_at', { withTimezone: true }), dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  operatorGithubUserId: bigint('operator_github_user_id', { mode: 'bigint' }).notNull(), operatorLogin: text('operator_login'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [check('maintainer_invites_state_check', sql`${table.invitedAt} is not null or ${table.dismissedAt} is not null`), githubOnly('maintainer_invites', table)])

// Maintainer decisions: a current GitHub admin declined the repository's market or opted the repository out of repo.ing
// (see drizzle/0041_maintainer_opt_outs.sql, src/maintainer-opt-outs.mjs). At most one active (not withdrawn) per repository.
// A Hugging Face model's decision (0050) is keyed by its registry market id and names Hugging Face subjects, not GitHub users.
export const maintainerOptOuts = pgTable('maintainer_opt_outs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull(),
  kind: varchar('kind', { length: 16 }).notNull(), githubUserId: bigint('github_user_id', { mode: 'bigint' }), note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  withdrawnByGithubUserId: bigint('withdrawn_by_github_user_id', { mode: 'bigint' }),
  authoritySource: varchar('authority_source', { length: 16 }).default('github').notNull(),
  actorSubject: char('actor_subject', { length: 24 }), withdrawnBySubject: char('withdrawn_by_subject', { length: 24 }),
}, t => [uniqueIndex('maintainer_opt_outs_one_active').on(t.githubRepoId).where(sql`${t.withdrawnAt} is null`),
  check('maintainer_opt_outs_github_repo_id_check', sql`${t.githubRepoId} > 0`), check('maintainer_opt_outs_kind_check', sql`${t.kind} in ('decline', 'opt_out')`),
  check('maintainer_opt_outs_github_user_id_check', sql`${t.githubUserId} > 0`),
  check('maintainer_opt_outs_note_check', sql`${t.note} is null or char_length(${t.note}) between 1 and 280`),
  check('maintainer_opt_outs_withdrawn_by_github_user_id_check', sql`${t.withdrawnByGithubUserId} > 0`),
  check('maintainer_opt_outs_actor_check', sql`(${t.authoritySource} = 'github' and ${t.githubUserId} is not null and ${t.actorSubject} is null and ${t.withdrawnBySubject} is null) or (${t.authoritySource} = 'huggingface' and ${t.githubUserId} is null and ${t.withdrawnByGithubUserId} is null and ${t.actorSubject} is not null and ${t.actorSubject} ~ '^[0-9a-f]{24}$' and (${t.withdrawnBySubject} is null or ${t.withdrawnBySubject} ~ '^[0-9a-f]{24}$'))`),
  sourceRange('maintainer_opt_outs_source_range', t),
  check('maintainer_opt_outs_withdrawn_check', sql`(${t.withdrawnAt} is null) = (${t.withdrawnByGithubUserId} is null and ${t.withdrawnBySubject} is null) and (${t.withdrawnByGithubUserId} is null or ${t.withdrawnBySubject} is null) and (${t.withdrawnAt} is null or ${t.withdrawnAt} >= ${t.createdAt})`)])

export const repoClaims = pgTable('repo_claims', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  beneficiaryWallet: varchar('beneficiary_wallet', { length: 44 }).notNull(),
  amountBaseUnits: bigint('amount_base_units', { mode: 'bigint' }).notNull(),
  asset: varchar('asset', { length: 44 }).notNull(),
  claimSignature: varchar('claim_signature', { length: 88 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionReason: text('resolution_reason'),
  signedTransaction: text('signed_transaction'),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }),
  dammAmountBaseUnits: bigint('damm_amount_base_units', { mode: 'bigint' }).notNull().default(0n),
}, (table) => [
  uniqueIndex('repo_claims_signature_unique').on(table.claimSignature),
  uniqueIndex('repo_claims_one_pending_per_repo').on(table.githubRepoId).where(sql`${table.status} = 'pending'`),
  check('repo_claims_positive_amount_check', sql`${table.amountBaseUnits} > 0`),
  check('repo_claims_status_check', sql`${table.status} in ('pending', 'settled', 'aborted')`),
  check('repo_claims_settlement_check', sql`(${table.status} = 'pending' and ${table.settledAt} is null and ${table.resolvedAt} is null and ${table.resolutionReason} is null) or (${table.status} = 'settled' and ${table.settledAt} is not null and ${table.resolvedAt} is null and ${table.resolutionReason} is null) or (${table.status} = 'aborted' and ${table.settledAt} is null and ${table.resolvedAt} is not null and ${table.resolutionReason} is not null)`),
])

// Finalized account checkpoints for the original permanently locked DAMM creator position.
// Amounts are SOL only; base-token fees and unknown fee modes are rejected before indexing.
export const dammFeeEvents = pgTable('damm_fee_events', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  pool: varchar('pool', { length: 44 }).notNull(),
  position: varchar('position', { length: 44 }).notNull(),
  slot: bigint('slot', { mode: 'bigint' }).notNull(),
  amountBaseUnits: bigint('amount_base_units', { mode: 'bigint' }).notNull(),
  cumulativeEarned: bigint('cumulative_earned', { mode: 'bigint' }).notNull(),
  cumulativeClaimed: bigint('cumulative_claimed', { mode: 'bigint' }).notNull(),
  evidenceHash: varchar('evidence_hash', { length: 64 }).notNull(),
  evidence: text('evidence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex('damm_fee_events_position_cumulative_earned_key').on(table.position, table.cumulativeEarned),
  // INCLUDE (amount_base_units) in migration 0038.
  index('damm_fee_events_repo').on(table.githubRepoId)])

// Finalized account checkpoints for the permanently locked DAMM partner position.
// Platform revenue only; never combined with builder credits or discovery rewards.
export const platformFeeEvents = pgTable('platform_fee_events', {
  id: serial('id').primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => repositories.githubRepoId),
  pool: varchar('pool', { length: 44 }).notNull(),
  position: varchar('position', { length: 44 }).notNull(),
  slot: bigint('slot', { mode: 'bigint' }).notNull(),
  amountBaseUnits: bigint('amount_base_units', { mode: 'bigint' }).notNull(),
  cumulativeEarned: bigint('cumulative_earned', { mode: 'bigint' }).notNull(),
  cumulativeClaimed: bigint('cumulative_claimed', { mode: 'bigint' }).notNull(),
  evidenceHash: varchar('evidence_hash', { length: 64 }).notNull(),
  evidence: text('evidence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex('platform_fee_events_position_cumulative_earned_key').on(table.position, table.cumulativeEarned),
  // INCLUDE (amount_base_units) in migration 0038.
  index('platform_fee_events_repo').on(table.githubRepoId),
  check('platform_fee_events_positive_amount_check', sql`${table.amountBaseUnits} > 0`),
])

// One durable intent per repository claim sweep; the protected partner signer only
// executes reviewed intents. Repeated claims are allowed as new fees accrue.
export const platformFeeClaims = pgTable('platform_fee_claims', {
  id: serial('id').primaryKey(),
  phase: varchar('phase', { length: 4 }).notNull().default('DAMM'),
  evidence: text('evidence'),
  receipt: text('receipt'),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => markets.githubRepoId),
  pool: varchar('pool', { length: 44 }).notNull(),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  signature: varchar('signature', { length: 88 }).notNull(),
  signedTransaction: text('signed_transaction').notNull(),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionReason: text('resolution_reason'),
}, table => [
  uniqueIndex('platform_fee_claims_signature_unique').on(table.signature),
  check('platform_fee_claims_phase_check', sql`${table.phase} in ('DBC','DAMM')`),
  check('platform_fee_claims_dbc_evidence_check', sql`${table.phase} <> 'DBC' or (${table.evidence} is not null and (${table.status} <> 'settled' or ${table.receipt} is not null))`),
  uniqueIndex('platform_fee_claims_one_pending').on(table.githubRepoId).where(sql`${table.status} = 'pending'`),
  check('platform_fee_claims_amount_check', sql`${table.amount} > 0`),
  check('platform_fee_claims_status_check', sql`${table.status} in ('pending', 'settled', 'aborted')`),
  check('platform_fee_claims_settlement_check', sql`(${table.status} = 'pending' and ${table.settledAt} is null and ${table.resolvedAt} is null and ${table.resolutionReason} is null) or (${table.status} = 'settled' and ${table.settledAt} is not null and ${table.resolvedAt} is null and ${table.resolutionReason} is null) or (${table.status} = 'aborted' and ${table.settledAt} is null and ${table.resolvedAt} is not null and ${table.resolutionReason} is not null)`),
])

// Versioned allocation policy for platform revenue. Permille parts; the remainder is
// treasury/unallocated. Rows are immutable once activated; allocations record the version used.
export const platformRevenuePolicies = pgTable('platform_revenue_policies', {
  version: integer('version').primaryKey(),
  buybackPermille: integer('buyback_permille').notNull(),
  liquidityPermille: integer('liquidity_permille').notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  check('platform_revenue_policies_permille_check', sql`${table.buybackPermille} >= 0 and ${table.liquidityPermille} >= 0 and ${table.buybackPermille} + ${table.liquidityPermille} <= 1000`),
])

// One row per settled platform fee claim consumed by an allocation group. The unique
// claim signature makes double allocation impossible; parts always sum to the whole.
export const platformRevenueAllocations = pgTable('platform_revenue_allocations', {
  id: serial('id').primaryKey(),
  allocationGroup: varchar('allocation_group', { length: 64 }).notNull(),
  claimSignature: varchar('claim_signature', { length: 88 }).notNull(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull(),
  claimedAmount: bigint('claimed_amount', { mode: 'bigint' }).notNull(),
  buybackAmount: bigint('buyback_amount', { mode: 'bigint' }).notNull(),
  liquidityAmount: bigint('liquidity_amount', { mode: 'bigint' }).notNull(),
  treasuryAmount: bigint('treasury_amount', { mode: 'bigint' }).notNull(),
  policyVersion: integer('policy_version').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex('platform_revenue_allocations_claim_unique').on(table.claimSignature),
  check('platform_revenue_allocations_parts_check', sql`${table.buybackAmount} + ${table.liquidityAmount} + ${table.treasuryAmount} = ${table.claimedAmount} and ${table.buybackAmount} >= 0 and ${table.liquidityAmount} >= 0 and ${table.treasuryAmount} >= 0`),
])

// Durable buyback intents. Execution stays impossible while $REPO configuration is
// absent; token-specific fields remain null until the canonical mint exists.
export const buybackIntents = pgTable('buyback_intents', {
  id: serial('id').primaryKey(),
  idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
  allocationGroup: varchar('allocation_group', { length: 64 }).notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  sourceWallet: varchar('wallet_source', { length: 44 }).notNull(),
  destinationMint: varchar('destination_mint', { length: 44 }),
  destinationTokenAccount: varchar('destination_token_account', { length: 44 }),
  quoteIdentifier: varchar('quote_identifier', { length: 128 }),
  expectedOutput: varchar('expected_output', { length: 40 }),
  minimumOutput: varchar('minimum_output', { length: 40 }),
  maxSlippageBps: integer('max_slippage_bps'),
  maxPriceImpactBps: integer('max_price_impact_bps'),
  policyVersion: integer('policy_version').notNull(),
  network: varchar('network', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  review: text('review'),
  simulation: text('simulation'),
  signature: varchar('signature', { length: 88 }),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  simulatedAt: timestamp('simulated_at', { withTimezone: true }),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionReason: text('resolution_reason'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex('buyback_intents_idempotency_key_unique').on(table.idempotencyKey),
  uniqueIndex('buyback_intents_signature_unique').on(table.signature),
  check('buyback_intents_amount_check', sql`${table.amount} > 0`),
  check('buyback_intents_status_check', sql`${table.status} in ('prepared','reviewed','simulated','settled','aborted')`),
  check('buyback_intents_settlement_check', sql`(${table.status} = 'settled' and ${table.settledAt} is not null and ${table.signature} is not null and ${table.resolvedAt} is null and ${table.resolutionReason} is null) or (${table.status} = 'aborted' and ${table.settledAt} is null and ${table.resolvedAt} is not null and ${table.resolutionReason} is not null) or (${table.status} in ('prepared','reviewed','simulated') and ${table.settledAt} is null and ${table.resolvedAt} is null and ${table.resolutionReason} is null)`),
])

export const liquidityIntents = pgTable('liquidity_intents', {
  id: serial('id').primaryKey().notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => markets.githubRepoId),
  pool: varchar('pool', { length: 44 }).notNull(),
  network: varchar('network', { length: 16 }).notNull(),
  sourceAmount: bigint('source_amount', { mode: 'bigint' }).notNull(),
  swapAmount: bigint('swap_amount', { mode: 'bigint' }).notNull(),
  minSwapOutput: bigint('min_swap_output', { mode: 'bigint' }).notNull(),
  sourceWallet: varchar('source_wallet', { length: 44 }).notNull(),
  tokenAMint: varchar('token_a_mint', { length: 44 }).notNull(),
  tokenBMint: varchar('token_b_mint', { length: 44 }).notNull(),
  maxAmountTokenA: varchar('max_amount_token_a', { length: 48 }).notNull(),
  maxAmountTokenB: varchar('max_amount_token_b', { length: 48 }).notNull(),
  quoteIdentifier: varchar('quote_identifier', { length: 128 }),
  maxSlippageBps: integer('max_slippage_bps').notNull(),
  maxPriceImpactBps: integer('max_price_impact_bps').notNull(),
  lpOwner: varchar('lp_owner', { length: 44 }).notNull(),
  position: varchar('position', { length: 44 }),
  positionNftMint: varchar('position_nft_mint', { length: 44 }),
  lockMode: varchar('lock_mode', { length: 24 }).notNull(),
  policyVersion: integer('policy_version').notNull(),
  rulesVersion: integer('rules_version').notNull(),
  rulesJson: text('rules_json').notNull(),
  minimumLiquidity: varchar('minimum_liquidity', { length: 80 }).notNull(),
  maxNetworkCost: bigint('max_network_cost', { mode: 'bigint' }).notNull(),
  settledNetworkCost: bigint('settled_network_cost', { mode: 'bigint' }),
  status: varchar('status', { length: 16 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  review: text('review'),
  simulation: text('simulation'),
  signature: varchar('signature', { length: 88 }),
  signedTransaction: text('signed_transaction'),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }),
  expectedLiquidity: varchar('expected_liquidity', { length: 80 }),
  settledDebit: bigint('settled_debit', { mode: 'bigint' }),
  settledTokenA: varchar('settled_token_a', { length: 48 }),
  settledTokenB: varchar('settled_token_b', { length: 48 }),
  settledLiquidity: varchar('settled_liquidity', { length: 80 }),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  simulatedAt: timestamp('simulated_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionReason: text('resolution_reason'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex('liquidity_intents_idempotency_key_unique').on(table.idempotencyKey),
  uniqueIndex('liquidity_intents_signature_unique').on(table.signature),
  uniqueIndex('liquidity_intents_position_unique').on(table.position),
  uniqueIndex('liquidity_intents_one_open_per_market').on(table.githubRepoId).where(sql`${table.status} in ('prepared','reviewed','simulated','submitted')`),
  check('liquidity_intents_amount_check', sql`"liquidity_intents"."source_amount" > 0 and "liquidity_intents"."swap_amount" >= 0`),
  check('liquidity_intents_status_check', sql`"liquidity_intents"."status" in ('prepared','reviewed','simulated','submitted','settled','aborted')`),
  check('liquidity_intents_settlement_check', sql`("liquidity_intents"."status" = 'settled' and "liquidity_intents"."settled_at" is not null and "liquidity_intents"."signature" is not null and "liquidity_intents"."position" is not null and "liquidity_intents"."resolved_at" is null and "liquidity_intents"."resolution_reason" is null) or ("liquidity_intents"."status" = 'aborted' and "liquidity_intents"."settled_at" is null and "liquidity_intents"."resolved_at" is not null and "liquidity_intents"."resolution_reason" is not null) or ("liquidity_intents"."status" in ('prepared','reviewed','simulated','submitted') and "liquidity_intents"."settled_at" is null and "liquidity_intents"."resolved_at" is null and "liquidity_intents"."resolution_reason" is null)`),
  check('liquidity_intents_budget_check', sql`swap_amount > 0 AND swap_amount < source_amount AND min_swap_output > 0 AND max_network_cost > 0 AND max_slippage_bps > 0 AND max_slippage_bps < 10000 AND max_price_impact_bps > 0 AND max_price_impact_bps <= 10000 AND lock_mode = 'platform-authority' AND source_wallet = lp_owner`),
])

// Builder-funded LPs: claims remain the sole payout accounting path.
export const builderReinvestIntents = pgTable('builder_reinvest_intents', {
  id: serial('id').primaryKey(),
  idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull().references(() => markets.githubRepoId),
  claimId: integer('claim_id').notNull().references(() => repoClaims.id),
  wallet: varchar('wallet', { length: 44 }).notNull(),
  githubUserId: text('github_user_id').notNull(),
  sourceAmount: bigint('source_amount', { mode: 'bigint' }).notNull(),
  terms: text('terms').notNull(),
  termsHash: varchar('terms_hash', { length: 64 }).notNull(),
  preparedTransaction: text('prepared_transaction').notNull(),
  signedTransaction: text('signed_transaction'),
  signature: varchar('signature', { length: 88 }),
  position: varchar('position', { length: 44 }).notNull(),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  simulation: text('simulation').notNull(),
  settlement: text('settlement'),
  settledDebit: bigint('settled_debit', { mode: 'bigint' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionReason: text('resolution_reason'),
}, table => [
  uniqueIndex('builder_reinvest_idempotency_unique').on(table.idempotencyKey),
  uniqueIndex('builder_reinvest_signature_unique').on(table.signature),
  uniqueIndex('builder_reinvest_position_unique').on(table.position),
  uniqueIndex('builder_reinvest_one_open_per_claim').on(table.claimId).where(sql`${table.status} in ('prepared','cancelling','submitted')`),
  check('builder_reinvest_amount_check', sql`${table.sourceAmount} > 0 and (${table.settledDebit} is null or (${table.settledDebit} > 0 and ${table.settledDebit} <= ${table.sourceAmount}))`),
  check('builder_reinvest_status_check', sql`${table.status} in ('prepared','cancelling','submitted','settled','aborted')`),
  check('builder_reinvest_settlement_check', sql`(${table.status} = 'settled' and ${table.settledAt} is not null and ${table.signature} is not null and ${table.signedTransaction} is not null and ${table.settledDebit} is not null and ${table.settlement} is not null) or (${table.status} <> 'settled' and ${table.settledAt} is null and ${table.settledDebit} is null)`),
  githubOnly('builder_reinvest_intents', table),
])
// Operator-only trade landing telemetry (see drizzle/0028_trade_outcomes.sql). No wallet or key material.
export const tradeOutcomes = pgTable('trade_outcomes', {
  id: serial('id').primaryKey(), attemptKey: varchar('attempt_key',{length:100}).notNull(), outcome: varchar('outcome',{length:24}).notNull(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}), mint: varchar('mint',{length:44}), phase: varchar('phase',{length:16}),
  direction: varchar('direction',{length:4}), amountIn: numeric('amount_in',{precision:20,scale:0}),
  priorityFeeLamports: bigint('priority_fee_lamports',{mode:'bigint'}), cuPriceMicroLamports: bigint('cu_price_micro_lamports',{mode:'bigint'}),
  cuLimit: integer('cu_limit'), signature: varchar('signature',{length:88}), error: text('error'),
  prepareToSignMs: integer('prepare_to_sign_ms'), signToConfirmMs: integer('sign_to_confirm_ms'),
  createdAt: timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[uniqueIndex('trade_outcomes_attempt_outcome_unique').on(t.attemptKey,t.outcome),index('trade_outcomes_created_at').on(t.createdAt),
  check('trade_outcomes_outcome_check',sql`${t.outcome} in ('prepared','submitted','confirmed','expired','failed','verification_failed')`),
  check('trade_outcomes_direction_check',sql`${t.direction} is null or ${t.direction} in ('buy','sell')`)])

// Prepared trade sessions shared by every web instance (see drizzle/0029_trade_sessions.sql). Deleted after 10 minutes.
export const tradeSessions = pgTable('trade_sessions', {
  id: uuid('id').primaryKey(), wallet: varchar('wallet',{length:44}).notNull(), phase: varchar('phase',{length:16}).notNull(),
  direction: varchar('direction',{length:4}).notNull(), githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull(),
  transaction: text('transaction').notNull(), message: text('message').notNull(),
  amountIn: numeric('amount_in',{precision:20,scale:0}).notNull(), minimumAmountOut: numeric('minimum_amount_out',{precision:20,scale:0}).notNull(),
  blockhash: varchar('blockhash',{length:44}).notNull(), lastValidBlockHeight: bigint('last_valid_block_height',{mode:'bigint'}).notNull(),
  record: jsonb('record').notNull(), signature: varchar('signature',{length:88}), signedMessage: text('signed_message'),
  submittedAt: timestamp('submitted_at',{withTimezone:true}), result: jsonb('result'),
  createdAt: timestamp('created_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[index('trade_sessions_created_at').on(t.createdAt),
  check('trade_sessions_phase_check',sql`${t.phase} in ('curve','graduated')`),
  check('trade_sessions_direction_check',sql`${t.direction} in ('buy','sell')`)])

// Operator-only trade canary: latest simulated 0.01 SOL buy per market (never signed or sent).
export const tradeCanaryStatus = pgTable('trade_canary_status', {
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).primaryKey(), symbol: varchar('symbol',{length:16}), phase: varchar('phase',{length:16}),
  ok: boolean('ok').notNull(), consecutiveFailures: integer('consecutive_failures').notNull().default(0), lastError: text('last_error'),
  detail: jsonb('detail'), lastRunAt: timestamp('last_run_at',{withTimezone:true}).notNull(), lastOkAt: timestamp('last_ok_at',{withTimezone:true}),
})

// Repository tips held by the custodial tip wallet, and its payouts/refunds (see drizzle/0030_repo_tips.sql, src/tips.mjs).
export const tipTransfers = pgTable('tip_transfers', {
  id: uuid('id').primaryKey(), kind: varchar('kind',{length:8}).notNull(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(() => repositories.githubRepoId),
  mint: varchar('mint',{length:44}).notNull(), tokenProgram: varchar('token_program',{length:44}).notNull(), decimals: smallint('decimals').notNull(),
  sourceWallet: varchar('source_wallet',{length:44}).notNull(), recipient: varchar('recipient',{length:44}).notNull(),
  amount: numeric('amount',{precision:20,scale:0}).notNull(), tipCount: integer('tip_count').notNull(), requestedBy: text('requested_by').notNull(),
  status: varchar('status',{length:16}).notNull(), signature: varchar('signature',{length:88}).notNull(), signedTransaction: text('signed_transaction').notNull(),
  lastValidBlockHeight: bigint('last_valid_block_height',{mode:'bigint'}).notNull(), receipt: jsonb('receipt'),
  createdAt: timestamp('created_at',{withTimezone:true}).defaultNow().notNull(), settledAt: timestamp('settled_at',{withTimezone:true}),
  resolvedAt: timestamp('resolved_at',{withTimezone:true}), resolutionReason: text('resolution_reason'),
},t=>[uniqueIndex('tip_transfers_signature_unique').on(t.signature),index('tip_transfers_pending').on(t.status).where(sql`${t.status} = 'pending'`),
  check('tip_transfers_kind_check',sql`${t.kind} in ('payout','refund')`),check('tip_transfers_amount_check',sql`${t.amount} > 0`),
  check('tip_transfers_tip_count_check',sql`${t.tipCount} > 0`),check('tip_transfers_status_check',sql`${t.status} in ('pending','settled','aborted')`),githubOnly('tip_transfers',t)])
export const repoTips = pgTable('repo_tips', {
  id: uuid('id').primaryKey(), githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(() => repositories.githubRepoId),
  donorWallet: varchar('donor_wallet',{length:44}).notNull(), tipWallet: varchar('tip_wallet',{length:44}).notNull(),
  mint: varchar('mint',{length:44}).notNull(), tokenProgram: varchar('token_program',{length:44}).notNull(), decimals: smallint('decimals').notNull(),
  symbol: varchar('symbol',{length:16}).notNull(), requestedAmount: numeric('requested_amount',{precision:20,scale:0}).notNull(),
  receivedAmount: numeric('received_amount',{precision:20,scale:0}), status: varchar('status',{length:16}).notNull(),
  message: text('message').notNull(), transaction: text('transaction').notNull(), lastValidBlockHeight: bigint('last_valid_block_height',{mode:'bigint'}).notNull(),
  signature: varchar('signature',{length:88}), signedTransaction: text('signed_transaction'), transferId: uuid('transfer_id').references(() => tipTransfers.id),
  createdAt: timestamp('created_at',{withTimezone:true}).defaultNow().notNull(), submittedAt: timestamp('submitted_at',{withTimezone:true}),
  confirmedAt: timestamp('confirmed_at',{withTimezone:true}), resolvedAt: timestamp('resolved_at',{withTimezone:true}),
  refundAfter: timestamp('refund_after',{withTimezone:true}).notNull(),
},t=>[uniqueIndex('repo_tips_signature_unique').on(t.signature),index('repo_tips_repo_status').on(t.githubRepoId,t.status),
  index('repo_tips_donor').on(t.donorWallet,t.status),index('repo_tips_transfer').on(t.transferId),
  index('repo_tips_open').on(t.status,t.createdAt).where(sql`${t.status} in ('prepared','submitted')`),
  check('repo_tips_status_check',sql`${t.status} in ('prepared','submitted','confirmed','expired','failed','paid','refunded')`),githubOnly('repo_tips',t)])

// "Why I bought" holder notes and their single-use signature nonces (see drizzle/0031_holder_notes.sql, src/holder-notes.mjs).
export const holderNotes = pgTable('holder_notes', {
  id: bigserial('id',{mode:'bigint'}).primaryKey(), mint: varchar('mint',{length:44}).notNull().references(() => markets.mint),
  wallet: varchar('wallet',{length:44}).notNull(), body: text('body').notNull(),
  balanceAtPost: numeric('balance_at_post',{precision:20,scale:0}).notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).defaultNow().notNull(), updatedAt: timestamp('updated_at',{withTimezone:true}).defaultNow().notNull(),
  hiddenAt: timestamp('hidden_at',{withTimezone:true}), hiddenBy: text('hidden_by'),
},t=>[uniqueIndex('holder_notes_mint_wallet_unique').on(t.mint,t.wallet),
  index('holder_notes_public').on(t.mint,t.updatedAt.desc(),t.id.desc()).where(sql`${t.hiddenAt} is null`),index('holder_notes_recent').on(t.updatedAt.desc()),
  check('holder_notes_body_check',sql`char_length(${t.body}) between 1 and 280`),check('holder_notes_balance_check',sql`${t.balanceAtPost} >= 0`)])
export const holderNoteNonces = pgTable('holder_note_nonces', {
  nonce: varchar('nonce',{length:32}).primaryKey(), expiresAt: timestamp('expires_at',{withTimezone:true}).notNull(),
},t=>[index('holder_note_nonces_expiry').on(t.expiresAt)])

// Optional "Connect X": wallet ↔ X account links, X sign-ins awaiting a wallet signature, unlink nonces (see drizzle/0032_x_links.sql, src/x-links.mjs).
export const xLinks = pgTable('x_links', {
  wallet: varchar('wallet',{length:44}).primaryKey(), xUserId: varchar('x_user_id',{length:20}).notNull(), username: varchar('username',{length:15}).notNull(),
  name: varchar('name',{length:64}), profileImageUrl: varchar('profile_image_url',{length:300}), verified: boolean('verified').default(false).notNull(),
  linkedAt: timestamp('linked_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[uniqueIndex('x_links_x_user_unique').on(t.xUserId),check('x_links_username_check',sql`${t.username} ~ '^[A-Za-z0-9_]{1,15}$'`)])
export const xLinkPending = pgTable('x_link_pending', {
  id: varchar('id',{length:32}).primaryKey(), wallet: varchar('wallet',{length:44}).notNull(), xUserId: varchar('x_user_id',{length:20}).notNull(),
  username: varchar('username',{length:15}).notNull(), name: varchar('name',{length:64}), profileImageUrl: varchar('profile_image_url',{length:300}),
  verified: boolean('verified').default(false).notNull(), expiresAt: timestamp('expires_at',{withTimezone:true}).notNull(),
},t=>[index('x_link_pending_expiry').on(t.expiresAt)])
export const xLinkNonces = pgTable('x_link_nonces', {
  nonce: varchar('nonce',{length:32}).primaryKey(), expiresAt: timestamp('expires_at',{withTimezone:true}).notNull(),
},t=>[index('x_link_nonces_expiry').on(t.expiresAt)])
// Parts funds: all-or-nothing hardware lists backed into the tip wallet (see drizzle/0033_parts_funds.sql, src/parts-fund.mjs).
const tz = name => timestamp(name,{withTimezone:true})
export const partsFunds = pgTable('parts_funds', {
  id: uuid('id').primaryKey(), githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(() => repositories.githubRepoId),
  revision: integer('revision').notNull().default(1), title: varchar('title',{length:100}).notNull(), description: varchar('description',{length:1000}),
  goalCents: bigint('goal_cents',{mode:'number'}).notNull(), deadline: tz('deadline').notNull(), status: varchar('status',{length:16}).notNull(),
  closeReason: varchar('close_reason',{length:16}), payoutWallet: varchar('payout_wallet',{length:44}), createdBy: text('created_by').notNull(),
  createdAt: tz('created_at').defaultNow().notNull(), updatedAt: tz('updated_at').defaultNow().notNull(), closedAt: tz('closed_at'),
  settledAt: tz('settled_at'), nextAttemptAt: tz('next_attempt_at'),
},t=>[uniqueIndex('parts_funds_one_active').on(t.githubRepoId).where(sql`${t.settledAt} is null`),index('parts_funds_repo').on(t.githubRepoId,t.createdAt.desc()),
  index('parts_funds_unsettled').on(t.status,t.deadline).where(sql`${t.settledAt} is null`),
  check('parts_funds_status_check',sql`${t.status} in ('open','funded','failed','cancelled')`),check('parts_funds_goal_check',sql`${t.goalCents} > 0 and ${t.goalCents} <= 500000`),
  githubOnly('parts_funds',t)])
export const partsFundItems = pgTable('parts_fund_items', {
  id: uuid('id').primaryKey(), fundId: uuid('fund_id').notNull().references(() => partsFunds.id, { onDelete: 'cascade' }), position: smallint('position').notNull(),
  name: varchar('name',{length:80}).notNull(), url: varchar('url',{length:500}), unitPriceCents: integer('unit_price_cents').notNull(), quantity: smallint('quantity').notNull(),
},t=>[uniqueIndex('parts_fund_items_position').on(t.fundId,t.position)])
export const partsTransfers = pgTable('parts_transfers', {
  id: uuid('id').primaryKey(), kind: varchar('kind',{length:8}).notNull(), fundId: uuid('fund_id').notNull().references(() => partsFunds.id),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(() => repositories.githubRepoId),
  mint: varchar('mint',{length:44}).notNull(), tokenProgram: varchar('token_program',{length:44}).notNull(), decimals: smallint('decimals').notNull(),
  sourceWallet: varchar('source_wallet',{length:44}).notNull(), recipient: varchar('recipient',{length:44}).notNull(),
  amount: numeric('amount',{precision:20,scale:0}).notNull(), pledgeCount: integer('pledge_count').notNull(), requestedBy: text('requested_by').notNull(),
  status: varchar('status',{length:16}).notNull(), signature: varchar('signature',{length:88}).notNull(), signedTransaction: text('signed_transaction').notNull(),
  lastValidBlockHeight: bigint('last_valid_block_height',{mode:'bigint'}).notNull(), receipt: jsonb('receipt'),
  createdAt: tz('created_at').defaultNow().notNull(), settledAt: tz('settled_at'), resolvedAt: tz('resolved_at'), resolutionReason: text('resolution_reason'),
},t=>[uniqueIndex('parts_transfers_signature_unique').on(t.signature),index('parts_transfers_pending').on(t.status).where(sql`${t.status} = 'pending'`),
  index('parts_transfers_fund').on(t.fundId),githubOnly('parts_transfers',t)])
export const partsPledges = pgTable('parts_pledges', {
  id: uuid('id').primaryKey(), fundId: uuid('fund_id').notNull().references(() => partsFunds.id),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(() => repositories.githubRepoId),
  itemId: uuid('item_id').references(() => partsFundItems.id, { onDelete: 'set null' }),
  donorWallet: varchar('donor_wallet',{length:44}).notNull(), tipWallet: varchar('tip_wallet',{length:44}).notNull(),
  mint: varchar('mint',{length:44}).notNull(), tokenProgram: varchar('token_program',{length:44}).notNull(), decimals: smallint('decimals').notNull(),
  symbol: varchar('symbol',{length:16}).notNull(), requestedAmount: numeric('requested_amount',{precision:20,scale:0}).notNull(),
  receivedAmount: numeric('received_amount',{precision:20,scale:0}), usdCents: bigint('usd_cents',{mode:'number'}).notNull(),
  usdPrice: doublePrecision('usd_price').notNull(), status: varchar('status',{length:16}).notNull(),
  message: text('message').notNull(), transaction: text('transaction').notNull(), lastValidBlockHeight: bigint('last_valid_block_height',{mode:'bigint'}).notNull(),
  signature: varchar('signature',{length:88}), signedTransaction: text('signed_transaction'), transferId: uuid('transfer_id').references(() => partsTransfers.id),
  createdAt: tz('created_at').defaultNow().notNull(), submittedAt: tz('submitted_at'), confirmedAt: tz('confirmed_at'), resolvedAt: tz('resolved_at'),
},t=>[uniqueIndex('parts_pledges_signature_unique').on(t.signature),index('parts_pledges_fund_status').on(t.fundId,t.status),
  index('parts_pledges_donor').on(t.donorWallet,t.status),index('parts_pledges_transfer').on(t.transferId),
  index('parts_pledges_open').on(t.status,t.createdAt).where(sql`${t.status} in ('prepared','submitted')`),
  check('parts_pledges_status_check',sql`${t.status} in ('prepared','submitted','confirmed','expired','failed','paid','refunded')`),githubOnly('parts_pledges',t)])
export const partsUpdates = pgTable('parts_updates', {
  id: uuid('id').primaryKey(), fundId: uuid('fund_id').notNull().references(() => partsFunds.id),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(() => repositories.githubRepoId),
  body: varchar('body',{length:1000}).notNull(), images: jsonb('images').notNull().default(sql`'[]'::jsonb`), createdBy: text('created_by').notNull(),
  createdAt: tz('created_at').defaultNow().notNull(),
},t=>[index('parts_updates_fund').on(t.fundId,t.createdAt.desc()),index('parts_updates_repo').on(t.githubRepoId,t.createdAt.desc()),githubOnly('parts_updates',t)])

// Public "new market launched" posts, claimed before sending (see drizzle/0034_launch_alerts.sql, src/launch-alerts.mjs).
export const launchAlerts = pgTable('launch_alerts', {
  id: bigserial('id',{mode:'bigint'}).primaryKey(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(() => repositories.githubRepoId),
  mint: varchar('mint',{length:44}).notNull(), channel: varchar('channel',{length:16}).notNull(), status: varchar('status',{length:16}).notNull(),
  attempts: smallint('attempts').default(1).notNull(), messageId: varchar('message_id',{length:64}), messageUrl: varchar('message_url',{length:300}),
  error: varchar('error',{length:300}), nextAttemptAt: tz('next_attempt_at'),
  createdAt: tz('created_at').defaultNow().notNull(), updatedAt: tz('updated_at').defaultNow().notNull(), sentAt: tz('sent_at'),
},t=>[uniqueIndex('launch_alerts_repo_channel_unique').on(t.githubRepoId,t.channel),index('launch_alerts_channel_recent').on(t.channel,t.updatedAt.desc()),
  check('launch_alerts_channel_check',sql`${t.channel} in ('telegram','x')`),check('launch_alerts_status_check',sql`${t.status} in ('sending','sent','failed','unknown')`),
  check('launch_alerts_sent_check',sql`(${t.status} = 'sent' and ${t.sentAt} is not null and ${t.messageId} is not null) or (${t.status} <> 'sent' and ${t.sentAt} is null)`)])

// Launch reviews awaiting the wallet signature, shared by every web replica (see src/launch-sessions.mjs).
export const launchSessions = pgTable('launch_sessions', {
  id: uuid('id').primaryKey(), marketId: integer('market_id').notNull().references(() => markets.id, { onDelete: 'cascade' }),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull(), repoFullName: text('repo_full_name').notNull(),
  mint: varchar('mint',{length:44}).notNull(), launcherWallet: varchar('launcher_wallet',{length:44}).notNull(),
  config: varchar('config',{length:44}).notNull(), transaction: text('transaction').notNull(), mintSecret: text('mint_secret'),
  blockhash: varchar('blockhash',{length:44}).notNull(), lastValidBlockHeight: bigint('last_valid_block_height',{mode:'bigint'}).notNull(),
  initialBuyLamports: numeric('initial_buy_lamports',{precision:20,scale:0}).notNull().default('0'), trendRevision: integer('trend_revision'),
  createdAt: tz('created_at').defaultNow().notNull(), expiresAt: tz('expires_at').notNull(), consumedAt: tz('consumed_at'),
},t=>[index('launch_sessions_open_market').on(t.marketId).where(sql`${t.consumedAt} is null`),index('launch_sessions_expires_at').on(t.expiresAt),
  check('launch_sessions_initial_buy_lamports_check',sql`${t.initialBuyLamports} >= 0`),
  check('launch_sessions_trend_revision_check',sql`${t.trendRevision} is null or ${t.trendRevision} > 0`),
  check('launch_sessions_secret_check',sql`(${t.consumedAt} is null) = (${t.mintSecret} is not null)`)])

// Public graduation-milestone posts (25/50/75/90% and graduation), claimed before sending, and the per-channel marks
// that keep old crossings from ever being posted (see drizzle/0037_milestone_alerts.sql, src/milestone-alerts.mjs).
export const milestoneAlerts = pgTable('milestone_alerts', {
  id: bigserial('id',{mode:'bigint'}).primaryKey(),
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(() => repositories.githubRepoId),
  mint: varchar('mint',{length:44}).notNull(), channel: varchar('channel',{length:16}).notNull(), milestone: smallint('milestone').notNull(),
  status: varchar('status',{length:16}).notNull(), attempts: smallint('attempts').default(1).notNull(),
  messageId: varchar('message_id',{length:64}), messageUrl: varchar('message_url',{length:300}), error: varchar('error',{length:300}), nextAttemptAt: tz('next_attempt_at'),
  createdAt: tz('created_at').defaultNow().notNull(), updatedAt: tz('updated_at').defaultNow().notNull(), sentAt: tz('sent_at'),
},t=>[uniqueIndex('milestone_alerts_repo_channel_milestone_unique').on(t.githubRepoId,t.channel,t.milestone),index('milestone_alerts_channel_recent').on(t.channel,t.updatedAt.desc()),
  check('milestone_alerts_channel_check',sql`${t.channel} in ('telegram','x')`),check('milestone_alerts_milestone_check',sql`${t.milestone} in (25,50,75,90,100)`),
  check('milestone_alerts_status_check',sql`${t.status} in ('sending','sent','failed','unknown')`),check('milestone_alerts_attempts_check',sql`${t.attempts} between 1 and 100`),
  check('milestone_alerts_sent_check',sql`(${t.status} = 'sent' and ${t.sentAt} is not null and ${t.messageId} is not null) or (${t.status} <> 'sent' and ${t.sentAt} is null)`)])
export const milestoneAlertMarks = pgTable('milestone_alert_marks', {
  githubRepoId: bigint('github_repo_id',{mode:'bigint'}).notNull().references(() => repositories.githubRepoId),
  channel: varchar('channel',{length:16}).notNull(), milestone: smallint('milestone').notNull(), markedAt: tz('marked_at').defaultNow().notNull(),
},t=>[primaryKey({name:'milestone_alert_marks_pkey',columns:[t.githubRepoId,t.channel]}),
  check('milestone_alert_marks_channel_check',sql`${t.channel} in ('telegram','x')`),check('milestone_alert_marks_milestone_check',sql`${t.milestone} in (0,25,50,75,90,100)`)])

// Real-user Core Web Vitals samples (POST /api/vitals); route patterns only, deleted after 14 days.
export const webVitals = pgTable('web_vitals', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  route: varchar('route', { length: 64 }).notNull(),
  metric: varchar('metric', { length: 4 }).notNull(),
  value: doublePrecision('value').notNull(),
  rating: varchar('rating', { length: 17 }).notNull(),
  device: varchar('device', { length: 7 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [index('web_vitals_created_at').on(t.createdAt),
  check('web_vitals_metric_check', sql`${t.metric} in ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')`),
  check('web_vitals_value_check', sql`${t.value} >= 0 and ${t.value} <= 600000`),
  check('web_vitals_rating_check', sql`${t.rating} in ('good', 'needs-improvement', 'poor')`),
  check('web_vitals_device_check', sql`${t.device} in ('mobile', 'desktop')`)])

// Stock-pair ledgers (migration 0054, docs/STOCK_QUOTES.md): a stock-paired market's trades, curve fees, graduation, DAMM fee
// checkpoints, collections and launcher payouts, and each stock's canonical pools and settlement receipts. Separate from every
// SOL table; amounts are raw units of each token. A row naming a market and its stock must match the market's stamp (trigger
// stock_ledger_market_check); fee splits and policy_version come from src/stock-fee-policy.mjs.
const stockMarket = () => ({
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull(),
  assetId: varchar('asset_id', { length: 32 }).notNull(),
  quoteMint: varchar('quote_mint', { length: 44 }).notNull(),
})
export const stockPoolCursors = pgTable('stock_pool_cursors', {
  pool: varchar('pool', { length: 44 }).primaryKey(),
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).notNull(),
  venue: varchar('venue', { length: 4 }).notNull(),
  lastSignature: varchar('last_signature', { length: 88 }).notNull(),
  lastSlot: bigint('last_slot', { mode: 'bigint' }).notNull(),
  updatedAt: tz('updated_at').defaultNow().notNull(),
}, t => [check('stock_pool_cursors_venue_check', sql`${t.venue} in ('dbc', 'damm')`)])
export const stockTradeEvents = pgTable('stock_trade_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), ...stockMarket(),
  venue: varchar('venue', { length: 4 }).notNull(), pool: varchar('pool', { length: 44 }).notNull(),
  signature: varchar('signature', { length: 88 }).notNull(), eventIndex: integer('event_index').notNull(),
  slot: bigint('slot', { mode: 'bigint' }).notNull(), tradedAt: tz('traded_at').notNull(),
  direction: varchar('direction', { length: 4 }).notNull(),
  // Raw stock units in or out of the pool, and raw market-token units.
  quoteAmount: bigint('quote_amount', { mode: 'bigint' }).notNull(), baseAmount: bigint('base_amount', { mode: 'bigint' }).notNull(),
  nextSqrtPrice: varchar('next_sqrt_price', { length: 40 }).notNull(), trader: varchar('trader', { length: 44 }).notNull(),
  createdAt: tz('created_at').defaultNow().notNull(),
}, t => [uniqueIndex('stock_trade_events_chain_event_unique').on(t.signature, t.eventIndex),
  index('stock_trade_events_repo_slot').on(t.githubRepoId, t.slot),
  check('stock_trade_events_venue_check', sql`${t.venue} in ('dbc', 'damm')`),
  check('stock_trade_events_direction_check', sql`${t.direction} in ('buy', 'sell')`),
  check('stock_trade_events_amounts_check', sql`${t.quoteAmount} >= 0 and ${t.baseAmount} >= 0`)])
// DBC curve swaps only; the graduated pool's fees are stockDammFeeCheckpoints.
export const stockFeeEvents = pgTable('stock_fee_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), ...stockMarket(),
  pool: varchar('pool', { length: 44 }).notNull(), signature: varchar('signature', { length: 88 }).notNull(),
  eventIndex: integer('event_index').notNull(), slot: bigint('slot', { mode: 'bigint' }).notNull(),
  creatorAmount: bigint('creator_amount', { mode: 'bigint' }).notNull(), partnerAmount: bigint('partner_amount', { mode: 'bigint' }).notNull(),
  launcherAmount: bigint('launcher_amount', { mode: 'bigint' }).notNull(), accumulatorAmount: bigint('accumulator_amount', { mode: 'bigint' }).notNull(),
  policyVersion: integer('policy_version').notNull(), createdAt: tz('created_at').defaultNow().notNull(),
}, t => [uniqueIndex('stock_fee_events_chain_event_unique').on(t.signature, t.eventIndex),
  check('stock_fee_events_amounts_check', sql`${t.creatorAmount} >= 0 and ${t.partnerAmount} >= 0 and ${t.launcherAmount} >= 0 and ${t.accumulatorAmount} >= 0`),
  check('stock_fee_events_split_check', sql`${t.creatorAmount} + ${t.partnerAmount} = ${t.launcherAmount} + ${t.accumulatorAmount}`),
  check('stock_fee_events_launcher_check', sql`${t.launcherAmount} <= ${t.creatorAmount}`)])
export const stockGraduationObservations = pgTable('stock_graduation_observations', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), ...stockMarket(),
  pool: varchar('pool', { length: 44 }).notNull(), slot: bigint('slot', { mode: 'bigint' }).notNull(), observedAt: tz('observed_at').notNull(),
  quoteReserve: bigint('quote_reserve', { mode: 'bigint' }).notNull(), migrationThreshold: bigint('migration_threshold', { mode: 'bigint' }).notNull(),
  isMigrated: boolean('is_migrated').notNull(),
}, t => [index('stock_graduation_observations_repo_observed').on(t.githubRepoId, t.observedAt),
  check('stock_graduation_observations_amounts_check', sql`${t.quoteReserve} >= 0 and ${t.migrationThreshold} >= 0`)])
export const stockGraduationEvents = pgTable('stock_graduation_events', {
  githubRepoId: bigint('github_repo_id', { mode: 'bigint' }).primaryKey(),
  assetId: varchar('asset_id', { length: 32 }).notNull(), quoteMint: varchar('quote_mint', { length: 44 }).notNull(),
  dbcPool: varchar('dbc_pool', { length: 44 }).notNull(), dammPool: varchar('damm_pool', { length: 44 }).notNull(),
  migrationSignature: varchar('migration_signature', { length: 88 }).notNull(), slot: bigint('slot', { mode: 'bigint' }).notNull(),
  creatorPosition: varchar('creator_position', { length: 44 }), partnerPosition: varchar('partner_position', { length: 44 }),
  evidence: jsonb('evidence').notNull(), createdAt: tz('created_at').defaultNow().notNull(),
})
// Cumulative checkpoints of the graduated pool's creator and partner positions; each credits the growth since the last one.
export const stockDammFeeCheckpoints = pgTable('stock_damm_fee_checkpoints', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), ...stockMarket(),
  dammPool: varchar('damm_pool', { length: 44 }).notNull(), side: varchar('side', { length: 8 }).notNull(),
  position: varchar('position', { length: 44 }).notNull(), slot: bigint('slot', { mode: 'bigint' }).notNull(),
  cumulativeEarned: bigint('cumulative_earned', { mode: 'bigint' }).notNull(), cumulativeClaimed: bigint('cumulative_claimed', { mode: 'bigint' }).notNull(),
  credit: bigint('credit', { mode: 'bigint' }).notNull(), launcherCumulative: bigint('launcher_cumulative', { mode: 'bigint' }).notNull(),
  launcherCredit: bigint('launcher_credit', { mode: 'bigint' }).notNull(), accumulatorCredit: bigint('accumulator_credit', { mode: 'bigint' }).notNull(),
  policyVersion: integer('policy_version').notNull(), createdAt: tz('created_at').defaultNow().notNull(),
}, t => [uniqueIndex('stock_damm_fee_checkpoints_pool_side_slot_unique').on(t.dammPool, t.side, t.slot),
  check('stock_damm_fee_checkpoints_side_check', sql`${t.side} in ('creator', 'partner')`),
  check('stock_damm_fee_checkpoints_amounts_check', sql`${t.cumulativeEarned} >= 0 and ${t.cumulativeClaimed} >= 0 and ${t.credit} >= 0 and ${t.launcherCumulative} >= 0 and ${t.launcherCredit} >= 0 and ${t.accumulatorCredit} >= 0`),
  check('stock_damm_fee_checkpoints_split_check', sql`${t.credit} = ${t.launcherCredit} + ${t.accumulatorCredit}`),
  check('stock_damm_fee_checkpoints_partner_check', sql`${t.side} <> 'partner' or ${t.launcherCredit} = 0`)])
export const stockFeeCollections = pgTable('stock_fee_collections', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), ...stockMarket(),
  source: varchar('source', { length: 16 }).notNull(), reviewedAmount: bigint('reviewed_amount', { mode: 'bigint' }).notNull(),
  actualAmount: bigint('actual_amount', { mode: 'bigint' }), launcherAmount: bigint('launcher_amount', { mode: 'bigint' }).notNull(),
  accumulatorAmount: bigint('accumulator_amount', { mode: 'bigint' }).notNull(), termsHash: varchar('terms_hash', { length: 64 }).notNull(),
  status: varchar('status', { length: 10 }).notNull(), signature: varchar('signature', { length: 88 }), signedTransaction: text('signed_transaction'),
  receipt: jsonb('receipt'), createdAt: tz('created_at').defaultNow().notNull(), settledAt: tz('settled_at'),
}, t => [uniqueIndex('stock_fee_collections_one_pending').on(t.githubRepoId, t.source).where(sql`${t.status} = 'pending'`),
  check('stock_fee_collections_source_check', sql`${t.source} in ('dbc_creator', 'dbc_partner', 'damm_creator', 'damm_partner')`),
  check('stock_fee_collections_status_check', sql`${t.status} in ('pending', 'settled', 'aborted')`),
  check('stock_fee_collections_amounts_check', sql`${t.reviewedAmount} >= 0 and (${t.actualAmount} is null or ${t.actualAmount} >= 0) and ${t.launcherAmount} >= 0 and ${t.accumulatorAmount} >= 0`)])
// The wallet is always the market's launcher_wallet (trigger stock_launcher_payout_wallet_check).
export const stockLauncherPayouts = pgTable('stock_launcher_payouts', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), ...stockMarket(),
  wallet: varchar('wallet', { length: 44 }).notNull(), amount: bigint('amount', { mode: 'bigint' }).notNull(),
  status: varchar('status', { length: 10 }).notNull(), signature: varchar('signature', { length: 88 }), signedTransaction: text('signed_transaction'),
  receipt: jsonb('receipt'), createdAt: tz('created_at').defaultNow().notNull(), settledAt: tz('settled_at'),
}, t => [uniqueIndex('stock_launcher_payouts_one_pending').on(t.githubRepoId).where(sql`${t.status} = 'pending'`),
  check('stock_launcher_payouts_amount_check', sql`${t.amount} > 0`),
  check('stock_launcher_payouts_status_check', sql`${t.status} in ('pending', 'settled', 'aborted')`)])
// Per stock, not per market: one active canonical REPOING/stock pool per asset.
export const stockCanonicalPools = pgTable('stock_canonical_pools', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  assetId: varchar('asset_id', { length: 32 }).notNull(), quoteMint: varchar('quote_mint', { length: 44 }).notNull(),
  pool: varchar('pool', { length: 44 }).notNull(), repoingMint: varchar('repoing_mint', { length: 44 }).notNull(),
  position: varchar('position', { length: 44 }), evidence: jsonb('evidence').notNull(),
  active: boolean('active').default(true).notNull(), registeredAt: tz('registered_at').defaultNow().notNull(),
}, t => [uniqueIndex('stock_canonical_pools_one_active').on(t.assetId).where(sql`${t.active}`)])
export const stockSettlementReceipts = pgTable('stock_settlement_receipts', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  assetId: varchar('asset_id', { length: 32 }).notNull(), quoteMint: varchar('quote_mint', { length: 44 }).notNull(),
  kind: varchar('kind', { length: 16 }).notNull(), signature: varchar('signature', { length: 88 }).notNull(),
  quoteSpent: bigint('quote_spent', { mode: 'bigint' }).notNull(), repoingSpent: bigint('repoing_spent', { mode: 'bigint' }).notNull(),
  repoingReceived: bigint('repoing_received', { mode: 'bigint' }).notNull(), evidence: jsonb('evidence').notNull(),
  createdAt: tz('created_at').defaultNow().notNull(),
}, t => [uniqueIndex('stock_settlement_receipts_signature_unique').on(t.signature),
  check('stock_settlement_receipts_kind_check', sql`${t.kind} in ('swap', 'add_liquidity', 'seed')`),
  check('stock_settlement_receipts_amounts_check', sql`${t.quoteSpent} >= 0 and ${t.repoingSpent} >= 0 and ${t.repoingReceived} >= 0`)])
