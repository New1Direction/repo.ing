import { createHash } from 'node:crypto'
import BN from 'bn.js'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Connection, PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcEventAuthority, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CP_AMM_PROGRAM_ID, CpAmm, derivePositionNftAccount, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import { PLATFORM_FEE_WALLET } from '../app/lib/buyback-receipts.mjs'
import { createQuoteAwareConfigResolver } from './market-config.mjs'
import { quoteOfMarket } from './quote-assets.mjs'
import { stockQuoteConfigs } from './quote-configs.mjs'
import { POLICY_VERSION, assertStockPolicyConfig } from './stock-fee-policy.mjs'
import { decimalText } from './stock-accumulator.mjs'

// Read-only previews of collecting a stock-paired market's fees into custody (docs/STOCK_QUOTES.md, "Accumulator and
// settlement"): for each source (the curve's creator and partner fees, the graduated pool's creator and partner positions), what
// the pools hold, what the stock ledgers expect, and, only when the two agree exactly, the exact instructions and amounts a
// collection WOULD use with the hash of its terms. Nothing is signed or sent and no key is loaded: execution comes later behind
// an operator flag, and must rebuild these terms and match their hash (as the SOL platform-fee claims do,
// src/platform-dbc-fees.mjs). checkStockCollectionReceipt is the receipt check that execution will settle with: exact
// Token-2022 balance deltas of the stock and the program's own claim event.

export const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const STOCK_COLLECTION_SOURCES = Object.freeze(['dbc_creator', 'dbc_partner', 'damm_creator', 'damm_partner'])
// The DBC fee claimer of every stock config (scripts/create-stock-quote-config.mjs) and the partner position's owner.
export const STOCK_PARTNER_WALLET = PLATFORM_FEE_WALLET
// Custody of collected stock fees: the partner wallet, where SOL platform-fee claims settle too. Fixed here; the scripts never
// take it as an argument (only tests pass their own). Collections land in its Token-2022 account for the stock; launcher
// payouts and the owner's settlements leave from there.
export const STOCK_FEE_CUSTODY = PLATFORM_FEE_WALLET
const EVENT_CPI_PREFIX = Buffer.from('e445a52e51cb9a1d', 'hex')
const DISCRIMINATORS = Object.freeze({
  dbc_creator: Buffer.from('52dcfabd03556b2d', 'hex'), // claim_creator_trading_fee
  dbc_partner: Buffer.from('08ec5931987db151', 'hex'), // claim_trading_fee
  damm: Buffer.from('b4269a118521a2d3', 'hex'), // claim_position_fee
})
// Where the claim instruction names the pool, the receiver's stock account, the vault it is paid from and the signer.
const CLAIM_ACCOUNTS = Object.freeze({
  dbc_creator: { pool: 1, receiver: 3, vault: 5, signer: 8 },
  dbc_partner: { pool: 2, receiver: 4, vault: 6, signer: 9 },
  damm: { pool: 1, position: 2, receiver: 4, vault: 6, signer: 10 },
})
const local = connection => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(connection?.rpcEndpoint ?? '')
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const big = value => BigInt(value ?? 0)
const key = value => new PublicKey(value)
const isDamm = source => source.startsWith('damm_')

// Stock-paired markets that are launched, indexed and finalized: exactly the indexed markets listPlatformFees leaves out
// (src/platform-fee-operations.mjs), so the two lists partition every indexed market. Optionally one stock's markets only.
export async function listStockMarkets(pool, { assetId = null, repoId = null } = {}) {
  const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint, m.pool, m.creator_wallet as "creatorWallet",
      m.launcher_wallet as "launcherWallet", m.quote_asset_id as "quoteAssetId", m.quote_mint as "quoteMint",
      m.quote_registry_version as "quoteRegistryVersion", coalesce(r.full_name, 'Repo ' || m.github_repo_id) as "fullName",
      g.damm_pool as "dammPool", g.creator_position as "creatorPosition", g.partner_position as "partnerPosition"
    from markets m left join repositories r on r.github_repo_id = m.github_repo_id
      left join stock_graduation_events g on g.github_repo_id = m.github_repo_id
    where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and m.quote_asset_id is not null
      and ($1::text is null or m.quote_asset_id = $1) and ($2::bigint is null or m.github_repo_id = $2)
    order by m.github_repo_id`, [assetId, repoId == null ? null : String(repoId)])
  return rows
}

// What the stock ledgers say each source of one market has earned and has had collected, in one consistent snapshot.
export async function readCollectionLedger(pool, repoId) {
  const db = await pool.connect()
  try {
    await db.query('begin isolation level repeatable read read only')
    try {
      const id = [String(repoId)]
      const { rows: [fees] } = await db.query(`select count(*)::int as events, coalesce(sum(creator_amount),0)::text as creator,
        coalesce(sum(partner_amount),0)::text as partner, coalesce(sum(launcher_amount),0)::text as launcher
        from stock_fee_events where github_repo_id=$1`, id)
      const { rows: checkpoints } = await db.query(`select side, count(*)::int as count, sum(credit)::text as credit,
          sum(launcher_credit)::text as launcher, (array_agg(cumulative_earned order by slot desc))[1]::text as earned,
          (array_agg(position order by slot desc))[1] as position,
          (array_agg(damm_pool order by slot desc))[1] as pool, max(slot)::text as slot
        from stock_damm_fee_checkpoints where github_repo_id=$1 group by side`, id)
      const { rows: collections } = await db.query(`select source, status, count(*)::int as count,
          coalesce(sum(actual_amount),0)::text as actual, sum(launcher_amount)::text as launcher, sum(accumulator_amount)::text as accumulator
        from stock_fee_collections where github_repo_id=$1 group by source, status`, id)
      await db.query('commit')
      return collectionLedger({ fees, checkpoints, collections })
    } catch (error) { await db.query('rollback').catch(() => {}); throw error }
  } finally { db.release() }
}

// Per source: earned (the whole fee recorded, both shares), launcherEarned (the launcher's part of it), and what settled
// collections took (collected, collectedLauncher), with pending collections counted.
export function collectionLedger({ fees, checkpoints, collections }) {
  const done = (source, status) => collections.filter(c => c.source === source && c.status === status)
  const settled = source => done(source, 'settled').reduce((t, c) => ({ actual: t.actual + big(c.actual), launcher: t.launcher + big(c.launcher) }), { actual: 0n, launcher: 0n })
  const side = name => checkpoints.find(c => c.side === name) ?? null
  const result = {}
  for (const source of STOCK_COLLECTION_SOURCES) {
    const s = settled(source), pending = done(source, 'pending').reduce((n, c) => n + c.count, 0)
    let earned, launcherEarned, checkpoint = null
    if (source === 'dbc_creator') { earned = big(fees?.creator); launcherEarned = big(fees?.launcher) }
    else if (source === 'dbc_partner') { earned = big(fees?.partner); launcherEarned = 0n }
    else {
      const row = side(source === 'damm_creator' ? 'creator' : 'partner')
      earned = big(row?.credit); launcherEarned = big(row?.launcher)
      checkpoint = row && { count: row.count, cumulativeEarned: row.earned, position: row.position, pool: row.pool, slot: row.slot }
    }
    result[source] = { earned, launcherEarned, collected: s.actual, collectedLauncher: s.launcher, pending, checkpoint }
  }
  return result
}

// One source's reconciliation of the pool against the ledger and, when they agree, the amounts a collection takes. Pure.
// chain: { uncollected, claimed?, pool?, position? } in raw units (a graduated position's own total claimed so far, and the
// pool and position the graduation recorded).
export function evaluateCollection(source, ledger, chain) {
  const expected = ledger.earned - ledger.collected
  const result = { source, onchain: String(chain.uncollected), ledgerExpected: String(expected), earned: String(ledger.earned),
    collected: String(ledger.collected), launcherEarned: String(ledger.launcherEarned), launcherCollected: String(ledger.collectedLauncher) }
  const refuse = (status, reason) => ({ ...result, status, reason })
  if (ledger.pending) return refuse('PENDING', 'A collection from this source is already in flight')
  if (isDamm(source)) {
    if (!ledger.checkpoint) return chain.uncollected + big(chain.claimed) === 0n ? refuse('EMPTY', 'Nothing has accrued yet')
      : refuse('MISMATCH', 'The graduated position has fees the ledger has no checkpoint for; indexing must catch up')
    if ((chain.pool && ledger.checkpoint.pool !== chain.pool) || (chain.position && ledger.checkpoint.position !== chain.position))
      return refuse('MISMATCH', 'The ledger checkpoints another pool or position than the graduation recorded; review required')
    if (big(ledger.checkpoint.cumulativeEarned) !== ledger.earned) return refuse('MISMATCH', 'DAMM checkpoint credits do not add up to the latest cumulative total')
    const earnedOnchain = chain.uncollected + big(chain.claimed)
    if (earnedOnchain !== ledger.earned) return refuse('MISMATCH', earnedOnchain > ledger.earned
      ? 'The position has earned more than the last checkpoint; indexing must catch up' : 'The position reports less than the ledger has credited; review required')
    if (big(chain.claimed) !== ledger.collected) return refuse('MISMATCH', 'Fees were claimed from this position outside the collection ledger; review required')
  } else if (chain.uncollected !== expected) {
    return refuse('MISMATCH', chain.uncollected > expected ? 'The pool holds fees the ledger has not recorded; indexing must catch up'
      : 'The pool holds less than the ledger expects; review required')
  }
  const launcherAmount = ledger.launcherEarned - ledger.collectedLauncher
  if (launcherAmount < 0n || launcherAmount > chain.uncollected) return refuse('MISMATCH', "The launcher's uncollected share does not fit in the amount the pool holds")
  if (chain.uncollected === 0n) return refuse('EMPTY', 'Nothing to collect')
  return { ...result, status: 'MATCH', amount: String(chain.uncollected), launcherAmount: String(launcherAmount),
    accumulatorAmount: String(chain.uncollected - launcherAmount) }
}

const describe = (ix, names = {}) => ({ program: ix.programId.toBase58(), name: names.name ?? null,
  accounts: ix.keys.map((k, i) => ({ name: names.accounts?.[i] ?? null, address: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })),
  data: Buffer.from(ix.data).toString('base64') })
const ATA_ACCOUNTS = ['payer', 'associatedAccount', 'owner', 'mint', 'systemProgram', 'tokenProgram']

// The instructions a collection would send: the custody's market-token account and stock account, created idempotently (the
// claim names both; base fees are zero, collectFeeMode 0), then the program's own claim of exactly `amount` of the stock
// (DBC: maxQuoteAmount caps it; a graduated position's claim takes everything accrued at execution). Built offline.
export async function collectionInstructions({ source, signer, custody, market, quoteMint, amount, dbc: d = null, damm = null, programs }) {
  const signerKey = key(signer), owner = key(custody), baseMint = key(market.mint), stockMint = key(quoteMint)
  const baseAccount = getAssociatedTokenAddressSync(baseMint, owner, true, TOKEN_PROGRAM_ID)
  const stockAccount = getAssociatedTokenAddressSync(stockMint, owner, true, TOKEN_2022_PROGRAM_ID)
  const instructions = [
    describe(createAssociatedTokenAccountIdempotentInstruction(signerKey, baseAccount, owner, baseMint, TOKEN_PROGRAM_ID), { name: 'createIdempotent', accounts: ATA_ACCOUNTS }),
    describe(createAssociatedTokenAccountIdempotentInstruction(signerKey, stockAccount, owner, stockMint, TOKEN_2022_PROGRAM_ID), { name: 'createIdempotent', accounts: ATA_ACCOUNTS }),
  ]
  let claim
  if (!isDamm(source)) {
    const common = { poolAuthority: deriveDbcPoolAuthority(), pool: key(market.pool), tokenAAccount: baseAccount, tokenBAccount: stockAccount,
      baseVault: key(d.baseVault), quoteVault: key(d.quoteVault), baseMint, quoteMint: stockMint, tokenBaseProgram: TOKEN_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_2022_PROGRAM_ID, eventAuthority: deriveDbcEventAuthority(), program: DBC_PROGRAM }
    const ix = source === 'dbc_creator'
      ? await programs.dbc.methods.claimCreatorTradingFee(new BN(0), new BN(String(amount))).accountsStrict({ ...common, creator: signerKey }).instruction()
      : await programs.dbc.methods.claimTradingFee(new BN(0), new BN(String(amount))).accountsStrict({ ...common, config: key(d.config), feeClaimer: signerKey }).instruction()
    claim = describe(ix, { name: source === 'dbc_creator' ? 'claim_creator_trading_fee' : 'claim_trading_fee',
      accounts: source === 'dbc_creator'
        ? ['poolAuthority', 'pool', 'tokenAAccount', 'tokenBAccount', 'baseVault', 'quoteVault', 'baseMint', 'quoteMint', 'creator', 'tokenBaseProgram', 'tokenQuoteProgram', 'eventAuthority', 'program']
        : ['poolAuthority', 'config', 'pool', 'tokenAAccount', 'tokenBAccount', 'baseVault', 'quoteVault', 'baseMint', 'quoteMint', 'feeClaimer', 'tokenBaseProgram', 'tokenQuoteProgram', 'eventAuthority', 'program'] })
  } else {
    const position = source === 'damm_creator' ? damm.creator : damm.partner
    const ix = await programs.amm.buildClaimPositionFeeInstruction({ owner: signerKey, poolAuthority: programs.amm.poolAuthority, pool: key(damm.pool),
      position: key(position.position), positionNftAccount: key(position.nftAccount), tokenAAccount: baseAccount, tokenBAccount: stockAccount,
      tokenAVault: key(damm.tokenAVault), tokenBVault: key(damm.tokenBVault), tokenAMint: baseMint, tokenBMint: stockMint,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID })
    claim = describe(ix, { name: 'claim_position_fee', accounts: ['poolAuthority', 'pool', 'position', 'tokenAAccount', 'tokenBAccount',
      'tokenAVault', 'tokenBVault', 'tokenAMint', 'tokenBMint', 'positionNftAccount', 'owner', 'tokenAProgram', 'tokenBProgram', 'eventAuthority', 'program'] })
  }
  instructions.push(claim)
  return { instructions, receiverTokenAccount: stockAccount.toBase58(), receiverBaseAccount: baseAccount.toBase58() }
}

// The exact terms a collection may execute. Their hash (64 hex characters, stock_fee_collections.terms_hash) pins every
// account and amount; a fresh read that changes any of them changes the hash.
export function stockCollectionTerms({ market, asset, source, evaluation, signer, custody, built, sourceVault, pool, position = null, config = null }) {
  return { purpose: 'stock-fee-collection', policyVersion: POLICY_VERSION, repoId: String(market.repoId), assetId: asset.assetId,
    quoteMint: asset.mint, mint: market.mint, source, pool, ...(config ? { config } : {}), ...(position ? { position } : {}),
    signer, receiver: custody, receiverTokenAccount: built.receiverTokenAccount, sourceVault, amount: evaluation.amount,
    launcherAmount: evaluation.launcherAmount, accumulatorAmount: evaluation.accumulatorAmount,
    ledger: { earned: evaluation.earned, collected: evaluation.collected, launcherEarned: evaluation.launcherEarned,
      launcherCollected: evaluation.launcherCollected },
    instructionsSha256: sha256(built.instructions) }
}
export const stockCollectionTermsHash = terms => sha256(terms)

const SIGNER_ROLE = { dbc_creator: "the market's creator signer", dbc_partner: 'the partner (fee claimer)',
  damm_creator: "the creator position's owner", damm_partner: "the partner position's owner" }
const SOURCE_NAME = { dbc_creator: 'curve creator fees', dbc_partner: 'curve partner fees',
  damm_creator: 'graduated pool creator position fees', damm_partner: 'graduated pool partner position fees' }

// The pools' side of one stock-paired market, read at finalized commitment (both RPCs must agree byte for byte when a second
// one is given). Throws on anything that is not the canonical stock market the row says it is.
export function createStockChainReader({ connection, verification = null, config, legacyConfigs = process.env.DBC_LEGACY_CONFIGS ?? '',
  stockConfigs = () => stockQuoteConfigs(), partner = STOCK_PARTNER_WALLET }) {
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const amm = new CpAmm(connection)
  const coder = dbc.state.getProgram().coder.accounts, ammCoder = amm._program.coder.accounts
  const resolve = createQuoteAwareConfigResolver(config, legacyConfigs, stockConfigs)
  async function read(keys) {
    const reads = await Promise.all([connection, ...(verification ? [verification] : [])].map(c => c.getMultipleAccountsInfoAndContext(keys, 'finalized')))
    if (reads.length === 2 && reads[0].value.some((a, i) => Boolean(a) !== Boolean(reads[1].value[i]) || (a && !a.data.equals(reads[1].value[i].data))))
      throw Error('RPC disagreement; refresh before collection')
    return reads[0]
  }
  async function readMarket(market) {
    const asset = quoteOfMarket(market)
    if (asset.type !== 'TOKENIZED_EQUITY') throw Error('Not a stock-paired market')
    const configKey = resolve(market), poolKey = key(market.pool), stockMint = key(asset.mint)
    const graduated = Boolean(market.dammPool)
    if (graduated && (!market.creatorPosition || !market.partnerPosition)) throw Error('Graduation is recorded without both positions; review required')
    const keys = [poolKey, configKey, ...(graduated ? [key(market.dammPool), key(market.creatorPosition), key(market.partnerPosition)] : [])]
    const first = await read(keys)
    const [poolInfo, configInfo, dammInfo, creatorInfo, partnerInfo] = first.value
    if (!poolInfo?.owner.equals(DBC_PROGRAM) || !configInfo?.owner.equals(DBC_PROGRAM)) throw Error('Invalid canonical DBC account')
    const s = coder.decode('virtualPool', poolInfo.data).poolState
    const fixed = coder.decode('poolConfig', configInfo.data)
    if (!s.config.equals(configKey) || s.baseMint.toBase58() !== market.mint || s.creator.toBase58() !== market.creatorWallet ||
      !fixed.quoteMint.equals(stockMint) || fixed.quoteTokenFlag !== 1 || fixed.collectFeeMode !== 0 || fixed.tokenType !== 0 ||
      !fixed.feeClaimer.equals(key(partner)) || !s.partnerBaseFee.isZero() || !s.creatorBaseFee.isZero()) {
      throw Error('Canonical stock config, creator or fee mode mismatch')
    }
    assertStockPolicyConfig(fixed)
    const out = { asset, slot: first.context.slot, verified: Boolean(verification),
      dbc: { pool: market.pool, config: configKey.toBase58(), baseVault: s.baseVault.toBase58(), quoteVault: s.quoteVault.toBase58(),
        creator: s.creator.toBase58(), feeClaimer: fixed.feeClaimer.toBase58(), isMigrated: Boolean(s.isMigrated),
        creatorFee: BigInt(s.creatorQuoteFee.toString()), partnerFee: BigInt(s.partnerQuoteFee.toString()) }, damm: null }
    if (graduated) {
      if (!dammInfo?.owner.equals(CP_AMM_PROGRAM_ID) || !creatorInfo?.owner.equals(CP_AMM_PROGRAM_ID) || !partnerInfo?.owner.equals(CP_AMM_PROGRAM_ID))
        throw Error('Invalid graduated DAMM account owner')
      const p = ammCoder.decode('pool', dammInfo.data)
      if (p.tokenAMint.toBase58() !== market.mint || !p.tokenBMint.equals(stockMint) || p.tokenBFlag !== 1 || p.collectFeeMode !== 1)
        throw Error('Graduated pool mints or fee mode mismatch')
      const positions = [creatorInfo, partnerInfo].map(info => ammCoder.decode('position', info.data))
      const nftAccounts = positions.map(position => derivePositionNftAccount(position.nftMint))
      const nfts = await read(nftAccounts)
      const sides = ['creator', 'partner'].map((side, i) => {
        const position = positions[i], info = nfts.value[i]
        if (!position.pool.equals(key(market.dammPool)) || !info?.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error(`Graduated ${side} position mismatch`)
        const nft = unpackAccount(nftAccounts[i], info, TOKEN_2022_PROGRAM_ID)
        const expectedOwner = side === 'creator' ? market.creatorWallet : fixed.feeClaimer.toBase58()
        if (!nft.mint.equals(position.nftMint) || nft.owner.toBase58() !== expectedOwner || nft.amount !== 1n || nft.delegate)
          throw Error(`Graduated ${side} position owner mismatch`)
        const fees = getUnClaimLpFee(p, position)
        if (!fees.feeTokenA.isZero() || !position.metrics.totalClaimedAFee.isZero()) throw Error(`Graduated ${side} position has market-token fees`)
        return { position: (side === 'creator' ? market.creatorPosition : market.partnerPosition), nftAccount: nftAccounts[i].toBase58(),
          owner: expectedOwner, uncollected: BigInt(fees.feeTokenB.toString()), claimed: BigInt(position.metrics.totalClaimedBFee.toString()) }
      })
      out.damm = { pool: market.dammPool, tokenAVault: p.tokenAVault.toBase58(), tokenBVault: p.tokenBVault.toBase58(),
        creator: sides[0], partner: sides[1] }
    }
    return out
  }
  return { readMarket, programs: { dbc: dbc.state.getProgram(), amm }, local: local(connection) }
}

// What each source of one market holds on chain: { uncollected, claimed?, pool?, position? }.
export function chainSources(chain) {
  const side = name => chain.damm && { uncollected: chain.damm[name].uncollected, claimed: chain.damm[name].claimed, pool: chain.damm.pool,
    position: chain.damm[name].position }
  return { dbc_creator: { uncollected: chain.dbc.creatorFee }, dbc_partner: { uncollected: chain.dbc.partnerFee },
    damm_creator: side('creator'), damm_partner: side('partner') }
}

// The total still collectable from one market's pools, both shares (the accumulator's onchain comparison).
export const chainUncollected = chain => Object.values(chainSources(chain)).reduce((total, s) => total + (s ? s.uncollected : 0n), 0n)

// Custody's balance of a stock, raw (its associated Token-2022 account; none is 0). A failed read throws: never taken as zero.
export async function custodyStockBalance(connection, asset, custody = STOCK_FEE_CUSTODY) {
  const account = getAssociatedTokenAddressSync(key(asset.mint), key(custody), true, TOKEN_2022_PROGRAM_ID)
  const info = await connection.getAccountInfo(account, 'finalized')
  return info ? unpackAccount(account, info, TOKEN_2022_PROGRAM_ID).amount : 0n
}

export function createStockCollections({ pool, reader, custody = STOCK_FEE_CUSTODY }) {
  // One market: every source's reconciliation and, where it matches, the collection it would make.
  async function previewMarket(market) {
    const base = { repoId: market.repoId, fullName: market.fullName, mint: market.mint, assetId: market.quoteAssetId }
    if ([market.creatorWallet, market.launcherWallet].includes(custody)) return { ...base, status: 'REFUSED', error: "Custody must not be the market's creator or launcher wallet", sources: [] }
    let chain, ledger
    try { [chain, ledger] = await Promise.all([reader.readMarket(market), readCollectionLedger(pool, market.repoId)]) }
    catch (error) { return { ...base, status: 'UNREADABLE', error: error.message, sources: [] } }
    const onchain = chainSources(chain), sources = []
    for (const source of STOCK_COLLECTION_SOURCES) {
      if (!onchain[source]) continue
      const evaluation = evaluateCollection(source, ledger[source], onchain[source])
      if (evaluation.status !== 'MATCH') { sources.push(evaluation); continue }
      if (!reader.local && !chain.verified) { sources.push({ ...evaluation, status: 'REFUSED', reason: 'Independent RPC verification is required for collection' }); continue }
      const damm = isDamm(source), side = damm ? chain.damm[source === 'damm_creator' ? 'creator' : 'partner'] : null
      const signer = source === 'dbc_creator' ? chain.dbc.creator : source === 'dbc_partner' ? chain.dbc.feeClaimer : side.owner
      const built = await collectionInstructions({ source, signer, custody, market, quoteMint: chain.asset.mint, amount: evaluation.amount,
        dbc: chain.dbc, damm: chain.damm, programs: reader.programs })
      const terms = stockCollectionTerms({ market, asset: chain.asset, source, evaluation, signer, custody, built,
        sourceVault: damm ? chain.damm.tokenBVault : chain.dbc.quoteVault, pool: damm ? chain.damm.pool : chain.dbc.pool,
        position: side?.position ?? null, config: damm ? null : chain.dbc.config })
      sources.push({ ...evaluation, signer, receiver: custody, receiverTokenAccount: built.receiverTokenAccount,
        instructions: built.instructions, terms, termsHash: stockCollectionTermsHash(terms) })
    }
    return { ...base, status: sources.some(s => s.status === 'MATCH') ? 'COLLECTABLE' : 'NOTHING', slot: chain.slot,
      uncollected: String(chainUncollected(chain)), graduated: Boolean(chain.damm), sources }
  }
  async function previewAll({ assetId = null, repoId = null } = {}) {
    const results = []
    for (const market of await listStockMarkets(pool, { assetId, repoId })) results.push(await previewMarket(market))
    return results
  }
  return { previewMarket, previewAll }
}

// Plain-English lines for one market's preview.
export function describeCollectionPreview(preview, { symbol = 'stock', decimals = 8 } = {}) {
  const units = raw => `${decimalText(raw, decimals)} ${symbol} (${raw} raw units)`
  const lines = [`${preview.fullName} (${preview.repoId}): ${preview.status}${preview.error ? `: ${preview.error}` : ''}`]
  for (const s of preview.sources ?? []) {
    if (s.status === 'MATCH') {
      lines.push(`  ${SOURCE_NAME[s.source]}: the pool holds ${units(s.amount)} and the ledger agrees. A collection WOULD claim exactly that into ` +
        `custody ${s.receiver} (stock account ${s.receiverTokenAccount}), signed by ${SIGNER_ROLE[s.source]} ${s.signer}: ` +
        `${units(s.launcherAmount)} for the launcher, ${units(s.accumulatorAmount)} for the accumulator. Terms hash ${s.termsHash}.`)
    } else lines.push(`  ${SOURCE_NAME[s.source]}: ${s.status}: ${s.reason}. Pool holds ${units(s.onchain)}, ledger expects ${units(s.ledgerExpected)}; nothing would be collected.`)
  }
  return lines
}

// ---------------------------------------------------------------------------------------------------------------------------
// Receipts. A transaction as src/finalized-transaction.mjs normalizes it: message.accountKeys (static and loaded, PublicKey[]),
// compiled instructions (programIdIndex, accounts, base58 data) and meta with inner instructions and token balances.

const keysOf = transaction => transaction.transaction.message.accountKeys.map(k => (k instanceof PublicKey ? k : key(k)))

// The self-CPI events one program logged in a transaction, in order: [{ name, data, instruction }] with lower-case names.
export function programEvents(transaction, programId, coder) {
  const keys = keysOf(transaction), events = []
  for (const group of transaction.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (!keys[ix.programIdIndex]?.equals(programId)) continue
      const data = Buffer.from(bs58.decode(ix.data))
      if (!data.subarray(0, 8).equals(EVENT_CPI_PREFIX)) continue
      const event = coder.decode(data.subarray(8).toString('base64'))
      if (!event) throw Error(`${programId.toBase58()} event does not decode`)
      events.push({ name: event.name.toLowerCase(), data: event.data, instruction: group.index })
    }
  }
  return events
}

// Every token account of `mint` the transaction touched: address → { owner, programId, pre, post, delta } in raw units. An
// account created or closed in the transaction counts from or to zero.
export function tokenDeltas(transaction, mint) {
  const keys = keysOf(transaction), accounts = new Map()
  for (const [side, list] of [['pre', transaction.meta?.preTokenBalances], ['post', transaction.meta?.postTokenBalances]]) {
    for (const balance of list ?? []) {
      if (balance.mint !== mint) continue
      const address = keys[balance.accountIndex]?.toBase58()
      if (!address) throw Error('Token balance names an account the transaction does not list')
      const entry = accounts.get(address) ?? { owner: balance.owner ?? null, programId: balance.programId ?? null, pre: 0n, post: 0n }
      entry[side] = BigInt(balance.uiTokenAmount.amount)
      accounts.set(address, entry)
    }
  }
  for (const entry of accounts.values()) entry.delta = entry.post - entry.pre
  return accounts
}

const coders = (() => {
  let cached
  return () => (cached ??= (() => {
    // Decoding needs no network: the clients are built on an unused endpoint only to reach their IDL coders.
    const offline = new Connection('http://127.0.0.1:1', 'finalized')
    return { dbc: new DynamicBondingCurveClient(offline, 'finalized').state.getProgram().coder.events, damm: new CpAmm(offline)._program.coder.events }
  })())
})()

// A collection's finalized receipt against its reviewed terms: the signer paid; only compute-budget, token-account and the one
// claim instruction ran; the claim named the reviewed pool, signer and custody account; the program's claim event and the
// Token-2022 balance deltas of the stock agree exactly (custody +X, the paying vault -X, no other account of the stock moved).
// A curve claim takes exactly the reviewed amount (maxQuoteAmount); a position claim takes everything accrued at execution, so
// X may exceed the review and the excess is reported for the ledger to credit first. Returns the receipt; throws on any mismatch.
export function checkStockCollectionReceipt({ transaction, terms, signature }) {
  if (!transaction?.meta) throw Error('Collection receipt is not available yet')
  if (transaction.meta.err) throw Error('Collection transaction failed on chain')
  if (signature && transaction.transaction.signatures?.[0] !== signature) throw Error('Receipt signature mismatch')
  const keys = keysOf(transaction), message = transaction.transaction.message
  if (keys[0]?.toBase58() !== terms.signer) throw Error('The collection was not paid for by its reviewed signer')
  const damm = isDamm(terms.source), program = damm ? CP_AMM_PROGRAM_ID : DBC_PROGRAM
  const discriminator = damm ? DISCRIMINATORS.damm : DISCRIMINATORS[terms.source], layout = CLAIM_ACCOUNTS[damm ? 'damm' : terms.source]
  const allowed = [ComputeBudgetProgram.programId, ASSOCIATED_TOKEN_PROGRAM_ID, program]
  const claims = []
  for (const ix of message.instructions) {
    const programId = keys[ix.programIdIndex]
    if (!allowed.some(p => p.equals(programId))) throw Error(`Unexpected program ${programId?.toBase58()} in the collection`)
    if (!programId.equals(program)) continue
    if (!Buffer.from(bs58.decode(ix.data)).subarray(0, 8).equals(discriminator)) throw Error('Unexpected instruction of the claim program')
    claims.push(ix)
  }
  if (claims.length !== 1) throw Error('Expected exactly one claim instruction')
  const named = index => keys[claims[0].accounts[index]]?.toBase58()
  if (named(layout.pool) !== terms.pool || named(layout.receiver) !== terms.receiverTokenAccount || named(layout.vault) !== terms.sourceVault ||
    named(layout.signer) !== terms.signer || (damm && named(layout.position) !== terms.position)) throw Error('The claim names other accounts than its review')
  const events = programEvents(transaction, program, damm ? coders().damm : coders().dbc)
  const wanted = damm ? 'evtclaimpositionfee' : terms.source === 'dbc_creator' ? 'evtclaimcreatortradingfee' : 'evtclaimtradingfee'
  const matching = events.filter(e => e.name === wanted && e.data.pool.toBase58() === terms.pool && (!damm || e.data.position.toBase58() === terms.position))
  if (matching.length !== 1) throw Error('Expected exactly one claim event for the reviewed pool')
  const event = matching[0].data
  const [baseClaimed, stockClaimed] = damm ? [event.feeAClaimed, event.feeBClaimed] : [event.tokenBaseAmount, event.tokenQuoteAmount]
  const amount = BigInt(stockClaimed.toString())
  if (!new BN(baseClaimed.toString()).isZero()) throw Error('The claim moved market tokens')
  const deltas = tokenDeltas(transaction, terms.quoteMint)
  for (const [address, entry] of deltas) {
    const expected = address === terms.receiverTokenAccount ? amount : address === terms.sourceVault ? -amount : 0n
    if (entry.delta !== expected) throw Error(`Exact ${terms.quoteMint} balance delta mismatch on ${address}`)
  }
  if (deltas.get(terms.receiverTokenAccount)?.delta !== amount || deltas.get(terms.sourceVault)?.delta !== -amount) throw Error('Custody or vault balance evidence missing')
  const reviewed = big(terms.amount)
  if (damm ? amount < reviewed : amount !== reviewed) throw Error('Collected amount differs from the reviewed amount')
  return { source: terms.source, signature: transaction.transaction.signatures?.[0] ?? signature ?? null, slot: transaction.slot,
    amount: String(amount), reviewed: String(reviewed), excess: String(amount - reviewed), receiver: terms.receiver,
    receiverTokenAccount: terms.receiverTokenAccount, networkFee: String(transaction.meta.fee) }
}
