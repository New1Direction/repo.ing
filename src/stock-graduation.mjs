import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token'
import { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress, MigrationOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, CP_AMM_PROGRAM_ID, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import { createQuoteAwareConfigResolver, readPoolConfig } from './market-config.mjs'
import { quoteOfMarket } from './quote-assets.mjs'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'
import { agreedFinalizedTransaction, agreeGraduation, assertFreshGraduation, evidenceHash, evidenceJSON } from './graduation-state.mjs'
import { readGenesisHash } from './rpc-usage.mjs'
import { assertStockPolicyConfig, dammCheckpoint, POLICY_VERSION } from './stock-fee-policy.mjs'

// Graduation of a stock-paired market (docs/STOCK_QUOTES.md): its DBC curve, quoted in the stock, migrates into a DAMM v2 pool of
// the market token and the stock, with a permanently locked creator position and partner position. Everything here mirrors the
// SOL path (src/graduation-state.mjs, src/graduated-fees.mjs) with the stock as the quote, and writes only the stock ledgers
// (migration 0054): stock_graduation_observations, stock_graduation_events and stock_damm_fee_checkpoints. The SOL resolvers
// keep refusing stock markets.
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const MIGRATE = Buffer.from([156, 169, 230, 103, 53, 228, 80, 64])
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const LOCAL_RPC = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/
const verifiedMigrations = new Map()

// The market's registry stock, or an error: nothing here reads a SOL market.
export function stockQuoteOf(market) {
  const quote = quoteOfMarket(market)
  if (quote.type === 'SOL') throw Error('STOCK_MARKET_REQUIRED')
  return quote
}
const requiredQuoteMint = quoteMint => {
  if (!quoteMint) throw Error('STOCK_QUOTE_MINT_REQUIRED')
  const key = new PublicKey(quoteMint)
  if (key.equals(NATIVE_MINT)) throw Error('STOCK_QUOTE_MINT_REQUIRED')
  return key
}

// The curve's own migrate instruction into `target`, with the stock as its quote mint through Token-2022: the only proof of a
// stock graduation's pool and positions. quoteMint is required; a SOL migration never proves a stock one.
export function stockMigrationPosition(transaction, market, config, target, quoteMint) {
  const quote = requiredQuoteMint(quoteMint)
  if (!transaction?.meta || transaction.meta.err) return null
  const keys = transaction.transaction.message.accountKeys
  const instructions = [...transaction.transaction.message.instructions,
    ...(transaction.meta.innerInstructions ?? []).flatMap(group => group.instructions)]
  for (const ix of instructions) {
    if (!keys[ix.programIdIndex]?.equals(DBC) || !Buffer.from(bs58.decode(ix.data)).subarray(0, 8).equals(MIGRATE)) continue
    const a = ix.accounts.map(i => keys[i])
    if (a[0]?.toBase58() !== market.pool || !a[2]?.equals(config) || !a[4]?.equals(target) || !a[12]?.equals(CP_AMM_PROGRAM_ID) ||
        a[13]?.toBase58() !== market.mint || !a[14]?.equals(quote) || !a[20]?.equals(TOKEN_PROGRAM_ID) || !a[21]?.equals(TOKEN_2022_PROGRAM_ID)) continue
    return { position: a[7], nftAccount: a[6], nftMint: a[5], partner: { position: a[10], nftAccount: a[9], nftMint: a[8] } }
  }
  return null
}

// A curve migrates once: walking it newest-first finds the migrate instruction after a handful of later transactions.
async function findMigration(connection, loadTransaction, market, configKey, target, quoteMint) {
  const curve = new PublicKey(market.pool)
  let before
  for (;;) {
    const page = await connection.getSignaturesForAddress(curve, { limit: 1000, ...(before ? { before } : {}) }, 'finalized')
    for (const item of page) {
      if (item.err) continue
      const tx = await loadTransaction(connection, item.signature)
      const match = stockMigrationPosition(tx, market, configKey, target, quoteMint)
      if (match) return { ...match, signature: item.signature, slot: tx.slot }
    }
    if (page.length < 1000) return null
    before = page.at(-1).signature
  }
}

// The stock's DBC config must be the stock launch config the policy and this path assume.
export function assertStockGraduationConfig(fixed, quote) {
  if (fixed.migrationOption !== MigrationOption.MET_DAMM_V2 || !fixed.quoteMint.equals(new PublicKey(quote.mint)) || fixed.quoteTokenFlag !== 1 ||
      fixed.creatorPermanentLockedLiquidityPercentage !== 50 || fixed.partnerPermanentLockedLiquidityPercentage !== 50) {
    throw Error('Unsupported graduated stock configuration')
  }
  assertStockPolicyConfig(fixed)
}

const proofFields = proof => ({ creatorNftAccount: proof.nftAccount.toBase58(), creatorNftMint: proof.nftMint.toBase58(),
  partnerNftAccount: proof.partner.nftAccount.toBase58(), partnerNftMint: proof.partner.nftMint.toBase58() })

// destination: the proven DAMM pool of a graduated stock-paired curve (null while it trades on the curve). read: one finalized
// snapshot of that pool and both locked positions, with each position's fees earned in the stock (unclaimed + claimed).
// db (optional): a stored stock_graduation_events row is only a pointer; its signature is reloaded from finalized history and
// must reproduce the stored positions, so a stale or tampered row fails closed.
export function createStockGraduation({ connection, config, db = null, loadTransaction = loadFinalizedTransaction }) {
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const amm = new CpAmm(connection)
  const resolve = createQuoteAwareConfigResolver(config)
  async function storedProof(market, configKey, target, quoteMint) {
    if (!db) return null
    const { rows: [row] } = await db.query(`select migration_signature, damm_pool, creator_position, partner_position, evidence
      from stock_graduation_events where github_repo_id = $1`, [String(market.githubRepoId)])
    if (!row) return null
    const tx = await loadTransaction(connection, row.migration_signature)
    const match = stockMigrationPosition(tx, market, configKey, target, quoteMint)
    const stored = row.evidence?.migration ?? {}
    if (!match || row.damm_pool !== target.toBase58() || row.creator_position !== match.position.toBase58() ||
        row.partner_position !== match.partner.position.toBase58() || Object.entries(proofFields(match)).some(([key, value]) => stored[key] !== value)) {
      throw Error('Stored stock migration proof mismatch')
    }
    return { ...match, signature: row.migration_signature, slot: tx.slot, stored: true }
  }
  async function destination(market, suppliedState, suppliedFixed) {
    const quote = stockQuoteOf(market), configKey = resolve(market), quoteMint = new PublicKey(quote.mint)
    const state = suppliedState ?? await dbc.state.getPool(market.pool)
    const fixed = suppliedFixed ?? await readPoolConfig(dbc, configKey)
    if (!state || !fixed || !state.poolState.config.equals(configKey) || state.poolState.baseMint.toBase58() !== market.mint ||
        state.poolState.creator.toBase58() !== market.creatorWallet) throw Error('Invalid canonical creator pool')
    if (!state.poolState.isMigrated) return null
    assertStockGraduationConfig(fixed, quote)
    const feeConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption]
    if (!feeConfig) throw Error('Unknown migration fee configuration')
    const target = deriveDammV2PoolAddress(feeConfig, new PublicKey(market.mint), quoteMint)
    const cacheKey = `${connection.rpcEndpoint}:${market.pool}:${quote.mint}`
    let proof = verifiedMigrations.get(cacheKey) ?? await storedProof(market, configKey, target, quoteMint)
    if (!proof) {
      proof = await findMigration(connection, loadTransaction, market, configKey, target, quoteMint)
      if (!proof) throw Error('Finalized canonical DAMM migration evidence unavailable')
    }
    if (!verifiedMigrations.has(cacheKey)) {
      if (verifiedMigrations.size >= 1000) verifiedMigrations.delete(verifiedMigrations.keys().next().value)
      verifiedMigrations.set(cacheKey, proof)
    }
    return { configKey, fixed, target, proof, quote }
  }
  async function read(market, suppliedState, suppliedFixed) {
    const found = await destination(market, suppliedState, suppliedFixed)
    if (!found) return null
    const { fixed, target, proof, quote } = found
    // One finalized bank snapshot, so fee growth and claim checkpoints come from the same slot.
    const accounts = [target, proof.position, proof.nftAccount, proof.partner.position, proof.partner.nftAccount]
    const snapshot = await connection.getMultipleAccountsInfoAndContext(accounts, 'finalized')
    const [poolInfo, positionInfo, nftInfo, partnerPositionInfo, partnerNftInfo] = snapshot.value
    if (!poolInfo?.owner.equals(CP_AMM_PROGRAM_ID) || !positionInfo?.owner.equals(CP_AMM_PROGRAM_ID) ||
        !partnerPositionInfo?.owner.equals(CP_AMM_PROGRAM_ID)) throw Error('Invalid DAMM account owner')
    const coder = amm._program.coder.accounts
    const poolState = coder.decode('pool', poolInfo.data)
    if (!poolState.tokenAMint.equals(new PublicKey(market.mint)) || !poolState.tokenBMint.equals(new PublicKey(quote.mint)) ||
        poolState.collectFeeMode !== 1 || poolState.tokenAFlag !== 0 || poolState.tokenBFlag !== 1) throw Error('Graduated stock pool or fee mode mismatch')
    // A locked position of the pool: its NFT held by `owner`, permanently locked, and its fees (unclaimed + claimed) in the stock.
    const readSide = (info, nftInfoOf, nft, owner, label) => {
      const position = coder.decode('position', info.data), account = unpackAccount(nft.nftAccount, nftInfoOf, TOKEN_2022_PROGRAM_ID)
      if (!position.pool.equals(target) || !position.nftMint.equals(nft.nftMint) || !account.mint.equals(nft.nftMint) || account.owner.toBase58() !== owner ||
          account.amount !== 1n || account.delegate || position.permanentLockedLiquidity.lten(0) || position.unlockedLiquidity.gtn(1) ||
          !position.vestedLiquidity.isZero()) throw Error(`Graduated ${label} position mismatch`)
      const fees = getUnClaimLpFee(poolState, position)
      // Fees are collected in the stock only; anything in the market token needs accounting this path does not have.
      if (!fees.feeTokenA.isZero() || !position.metrics.totalClaimedAFee.isZero()) throw Error('Graduated stock fees outside the stock need separate accounting')
      const available = BigInt(fees.feeTokenB.toString()), claimed = BigInt(position.metrics.totalClaimedBFee.toString())
      if (available < 0n || claimed < 0n) throw Error('Negative graduated fee state')
      return { position: nft.position, nftAccount: nft.nftAccount, nftMint: nft.nftMint, state: position, available, claimed, earned: available + claimed }
    }
    if (!fixed.feeClaimer) throw Error('Graduated partner position mismatch')
    const creator = readSide(positionInfo, nftInfo, proof, market.creatorWallet, 'creator')
    const partner = readSide(partnerPositionInfo, partnerNftInfo, proof.partner, fixed.feeClaimer.toBase58(), 'partner')
    const evidenceOf = indexes => ({ migration: proof.signature, accounts: indexes.map(i => ({ address: accounts[i].toBase58(),
      owner: snapshot.value[i].owner.toBase58(), data: snapshot.value[i].data.toString('base64') })) })
    const evidence = evidenceOf([0, 1, 2]), partnerEvidence = evidenceOf([0, 3, 4])
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    return { pool: target, poolState, quote, proof, slot: snapshot.context.slot, amm, feeClaimer: fixed.feeClaimer,
      ...creator, evidence, hash: hash(evidence),
      partner: { ...partner, pool: target, slot: snapshot.context.slot, evidence: partnerEvidence, hash: hash(partnerEvidence) } }
  }
  return { read, destination }
}

// Progress toward graduation in raw units of the stock (a scaled-UI multiplier only changes how wallets show it).
export function stockGraduationProgress(reserve, threshold, migrated = false) {
  const current = BigInt(reserve), target = BigInt(threshold)
  if (current < 0n || target <= 0n) throw Error('INVALID_THRESHOLD')
  const reached = migrated || current >= target
  return { phase: migrated ? 'GRADUATED' : 'CURVE', status: migrated ? 'graduated' : current >= target ? 'migrating' : 'active',
    reserveBaseUnits: String(current), thresholdBaseUnits: String(target), remainingBaseUnits: String(reached ? 0n : target - current),
    progressPercent: reached ? 100 : Number(current * 10000n / target) / 100 }
}

const accountEvidence = (info, address) => {
  if (!info) throw Error('ACCOUNT_MISSING')
  return { address: address.toBase58(), owner: info.owner.toBase58(), data: info.data.toString('base64') }
}

// Two providers must agree on everything (the SOL graduation's rule): the network, the finalized curve and config accounts, the
// graduated pool and positions, and the migration transaction. No estimates; nothing is persisted here.
export async function readStockGraduationState({ connection, verification, config, market, env = process.env, db = null }) {
  if (!verification) throw Error('VERIFICATION_RPC_REQUIRED')
  const local = [connection, verification].every(c => LOCAL_RPC.test(c.rpcEndpoint)) && env.NODE_ENV !== 'production'
  if (connection.rpcEndpoint === verification.rpcEndpoint && !local) throw Error('INDEPENDENT_RPC_REQUIRED')
  const genesis = agreeGraduation(...await Promise.all([connection, verification].map(c => readGenesisHash(c))))
  if (genesis !== MAINNET_GENESIS && !local) throw Error('NETWORK_MISMATCH')
  const quote = stockQuoteOf(market)
  // The stock's registered config (STOCK_QUOTE_CONFIGS) must derive this market's curve.
  let configKey
  try { configKey = createQuoteAwareConfigResolver(config)(market) } catch { throw Error('STOCK_CONFIG_UNRESOLVED') }
  const poolKey = new PublicKey(market.pool), addresses = [poolKey, configKey]
  const reads = await Promise.all([connection, verification].map(async c => {
    const snapshot = await c.getMultipleAccountsInfoAndContext(addresses, 'finalized')
    const time = await c.getBlockTime(snapshot.context.slot)
    if (!time) throw Error('STALE_PROGRESS')
    const evidence = snapshot.value.map((info, i) => accountEvidence(info, addresses[i]))
    if (snapshot.value.some(a => !a?.owner.equals(DBC))) throw Error('CONFIG_OR_POOL_OWNER_MISMATCH')
    return { snapshot, evidence, time }
  }))
  agreeGraduation(...reads.map(r => r.evidence))
  const coder = new DynamicBondingCurveClient(connection, 'finalized').state.getProgram().coder.accounts
  const state = coder.decode('virtualPool', reads[0].snapshot.value[0].data).poolState, fixed = coder.decode('poolConfig', reads[0].snapshot.value[1].data)
  if (!state.config.equals(configKey) || state.baseMint.toBase58() !== market.mint || state.creator.toBase58() !== market.creatorWallet ||
      !fixed.quoteMint.equals(new PublicKey(quote.mint)) || fixed.quoteTokenFlag !== 1) throw Error('CONFIG_OR_POOL_MISMATCH')
  try { assertStockPolicyConfig(fixed) } catch { throw Error('STOCK_POLICY_CONFIG_MISMATCH') }
  const slot = Math.min(...reads.map(r => r.snapshot.context.slot))
  const value = { ...stockGraduationProgress(state.quoteReserve.toString(), fixed.migrationQuoteThreshold.toString()),
    repoId: String(market.githubRepoId), assetId: quote.assetId, quoteMint: quote.mint, config: configKey.toBase58(), curve: market.pool,
    mint: market.mint, checkedAt: new Date().toISOString(), chainTime: new Date(Math.min(...reads.map(r => r.time)) * 1000).toISOString(),
    slot, slots: reads.map(r => r.snapshot.context.slot), accountEvidence: reads[0].evidence, destination: null, migration: null }
  assertFreshGraduation(value)
  if (!state.isMigrated) return value
  const snapshots = await Promise.all([connection, verification].map(c => createStockGraduation({ connection: c, config, db }).read(market, { poolState: state }, fixed)))
  if (snapshots.some(s => !s)) throw Error('GRADUATION_STATE_DISAGREEMENT')
  agreeGraduation(...snapshots.map(s => ({ evidence: s.evidence, partner: s.partner.evidence })))
  const g = snapshots[0]
  const tx = await agreedFinalizedTransaction(connection, verification, g.proof.signature)
  const proof = stockMigrationPosition(tx, market, configKey, g.pool, quote.mint)
  if (!proof || !proof.position.equals(g.position) || !proof.partner.position.equals(g.partner.position) || tx.slot > slot) {
    throw Error('MIGRATION_EVIDENCE_INCOMPLETE')
  }
  const balances = side => ({ native: tx.transaction.message.accountKeys.map((k, i) => ({ address: k.toBase58(), lamports: String(tx.meta[`${side}Balances`][i]) })),
    tokens: tx.meta[`${side}TokenBalances`] })
  value.migration = { signature: g.proof.signature, slot: tx.slot, blockTime: tx.blockTime, curve: market.pool, config: value.config, mint: market.mint,
    assetId: quote.assetId, quoteMint: quote.mint, pool: g.pool.toBase58(), creatorPosition: g.position.toBase58(), partnerPosition: g.partner.position.toBase58(),
    ...proofFields(proof), transactionHash: evidenceHash(tx.transaction), pre: balances('pre'), post: balances('post') }
  value.migrationHash = evidenceHash(value.migration)
  value.positionEvidence = { creator: g.evidence, partner: g.partner.evidence }
  const feeView = side => ({ position: side.position.toBase58(), earned: String(side.earned), claimed: String(side.claimed), available: String(side.available) })
  Object.assign(value, stockGraduationProgress(state.quoteReserve.toString(), fixed.migrationQuoteThreshold.toString(), true), {
    destination: { pool: g.pool.toBase58(), url: `https://app.meteora.ag/dammv2/${g.pool.toBase58()}` },
    // A disabled pool (Meteora's switch) cannot be traded (assertTradableStockPool), but its proof, swaps and fees are still
    // recorded; the monitor reports it for review.
    dammPoolEnabled: g.poolState.poolStatus === 0, dammQuoteReserve: g.poolState.tokenBAmount.toString(), partnerWallet: g.feeClaimer.toBase58(),
    fees: { slot: Math.min(...snapshots.map(s => s.slot)), creator: feeView(g), partner: feeView(g.partner) } })
  return assertFreshGraduation(value)
}

// The migration proof, once: a second, different proof for the same market is a conflict to review, never a replacement.
export async function recordStockGraduationEvent(db, state) {
  const m = state.migration
  if (!m) return false
  const { rows } = await db.query(`insert into stock_graduation_events (github_repo_id, asset_id, quote_mint, dbc_pool, damm_pool, migration_signature,
    slot, creator_position, partner_position, evidence) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict (github_repo_id) do nothing returning github_repo_id`,
  [state.repoId, state.assetId, state.quoteMint, m.curve, m.pool, m.signature, String(m.slot), m.creatorPosition, m.partnerPosition,
    evidenceJSON({ migration: m, migrationHash: state.migrationHash, positions: state.positionEvidence, postCurve: state.accountEvidence })])
  const { rows: [stored] } = await db.query(`select migration_signature, damm_pool, creator_position, partner_position, evidence->>'migrationHash' as hash
    from stock_graduation_events where github_repo_id = $1`, [state.repoId])
  if (stored.migration_signature !== m.signature || stored.damm_pool !== m.pool || stored.creator_position !== m.creatorPosition ||
      stored.partner_position !== m.partnerPosition || stored.hash !== state.migrationHash) throw Error('DUPLICATE_GRADUATION_CONFLICT')
  return rows.length === 1
}

// A reading of the curve's progress. Kept when it says something new (reserve, threshold, migration) or, while the curve trades,
// when the last one is older than heartbeatMs, so the public view stays fresh without a row every pass. A migrated curve never
// changes again: its migrated reading is kept once (the public view of a graduated market rests on stock_graduation_events).
// observed_at is the finalized chain time of the reading (never later than the check), so freshness is judged conservatively.
export const STOCK_OBSERVATION_HEARTBEAT_MS = 60_000
export async function recordStockObservation(db, state, { heartbeatMs = STOCK_OBSERVATION_HEARTBEAT_MS, now = Date.now } = {}) {
  const migrated = state.phase === 'GRADUATED'
  const { rows: [last] } = await db.query(`select quote_reserve::text as reserve, migration_threshold::text as threshold, is_migrated, observed_at
    from stock_graduation_observations where github_repo_id = $1 order by observed_at desc, id desc limit 1`, [state.repoId])
  if (last && last.reserve === state.reserveBaseUnits && last.threshold === state.thresholdBaseUnits && last.is_migrated === migrated &&
      (migrated || now() - new Date(last.observed_at).getTime() < heartbeatMs)) return false
  await db.query(`insert into stock_graduation_observations (github_repo_id, asset_id, quote_mint, pool, slot, observed_at, quote_reserve,
    migration_threshold, is_migrated) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [state.repoId, state.assetId, state.quoteMint, state.curve, String(state.slot), state.chainTime, state.reserveBaseUnits, state.thresholdBaseUnits, migrated])
  return true
}

// DAMM fee checkpoints (stock fee policy, src/stock-fee-policy.mjs dammCheckpoint): each side's cumulative earnings (unclaimed +
// claimed, in the stock) at a finalized slot, crediting the growth since that side's last checkpoint. The creator side pays the
// launcher floor(earned * 150 / 497) as a running total; the partner side goes to the accumulator whole. A new row only when a
// side earned more, never for an older slot, and a cumulative that fell is refused (review) by the policy.
export async function recordStockDammCheckpoints(db, state) {
  const m = state.migration
  if (!m) return []
  const written = []
  for (const side of ['creator', 'partner']) {
    const position = state.fees[side]
    if (position.position !== (side === 'creator' ? m.creatorPosition : m.partnerPosition)) throw Error('MIGRATION_EVIDENCE_INCOMPLETE')
    const { rows: [previous] } = await db.query(`select slot::text, cumulative_earned::text as "cumulativeEarned", launcher_cumulative::text as "launcherCumulative",
      side, policy_version as "policyVersion" from stock_damm_fee_checkpoints where damm_pool = $1 and side = $2 order by slot desc limit 1`, [m.pool, side])
    const slot = BigInt(state.fees.slot)
    if (previous && BigInt(previous.slot) >= slot) continue
    const checkpoint = dammCheckpoint({ side, cumulativeEarned: position.earned, previous: previous ? { cumulativeEarned: previous.cumulativeEarned,
      launcherCumulative: previous.launcherCumulative, side: previous.side, policyVersion: previous.policyVersion } : null })
    if (checkpoint.credit === 0n) continue
    const { rowCount } = await db.query(`insert into stock_damm_fee_checkpoints (github_repo_id, asset_id, quote_mint, damm_pool, side, position, slot,
      cumulative_earned, cumulative_claimed, credit, launcher_cumulative, launcher_credit, accumulator_credit, policy_version)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (damm_pool, side, slot) do nothing`,
    [state.repoId, state.assetId, state.quoteMint, m.pool, side, position.position, String(slot), position.earned,
      position.claimed, String(checkpoint.credit), String(checkpoint.launcherCumulative), String(checkpoint.launcherCredit),
      String(checkpoint.accumulatorCredit), POLICY_VERSION])
    if (rowCount) written.push({ side, slot: String(slot), earned: position.earned, credit: String(checkpoint.credit),
      launcherCredit: String(checkpoint.launcherCredit), accumulatorCredit: String(checkpoint.accumulatorCredit) })
  }
  return written
}
