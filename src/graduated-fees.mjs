import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token'
import { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress, MigrationOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, CP_AMM_PROGRAM_ID, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import { createMarketConfigResolver, readPoolConfig } from './market-config.mjs'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'

const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const verifiedMigrations = new Map()
const MIGRATE = Buffer.from([156,169,230,103,53,228,80,64])
// Only an original migration position may contribute builder fees. NFT ownership alone is insufficient.
export function migrationPosition(transaction, market, config, target) {
  if (!transaction?.meta || transaction.meta.err) return null
  const keys = transaction.transaction.message.accountKeys
  const instructions = [...transaction.transaction.message.instructions,
    ...(transaction.meta.innerInstructions ?? []).flatMap(group => group.instructions)]
  for (const ix of instructions) {
    if (!keys[ix.programIdIndex]?.equals(DBC) || !Buffer.from(bs58.decode(ix.data)).subarray(0,8).equals(MIGRATE)) continue
    const a = ix.accounts.map(i => keys[i])
    if (a[0]?.toBase58() !== market.pool || !a[2]?.equals(config) || !a[4]?.equals(target) ||
        a[13]?.toBase58() !== market.mint || !a[14]?.equals(NATIVE_MINT) || !a[12]?.equals(CP_AMM_PROGRAM_ID)) continue
    return { position: a[7], nftAccount: a[6], nftMint: a[5],
      partner: { position: a[10], nftAccount: a[9], nftMint: a[8] } }
  }
  return null
}

// The migrate instruction must name the curve, and a curve can migrate only once. Walking the
// settled curve newest-first finds it after a handful of post-migration txs, regardless of how
// busy the DAMM pool is or how many pre-migration txs touched the derivable pool address.
async function findMigration(connection, loadTransaction, market, configKey, target) {
  const curve = new PublicKey(market.pool)
  let before
  for (;;) {
    const page = await connection.getSignaturesForAddress(curve, { limit: 1000, ...(before ? { before } : {}) }, 'finalized')
    for (const item of page) {
      if (item.err) continue
      const tx = await loadTransaction(connection, item.signature)
      const match = migrationPosition(tx, market, configKey, target)
      if (match) return { ...match, signature: item.signature, slot: tx.slot }
    }
    if (page.length < 1000) return null
    before = page.at(-1).signature
  }
}

const proofRow = (market, configKey, target, proof) => ({ curve: market.pool, config: configKey.toBase58(), mint: market.mint,
  pool: target.toBase58(), signature: proof.signature, slot: String(proof.slot),
  creatorPosition: proof.position.toBase58(), creatorNftAccount: proof.nftAccount.toBase58(), creatorNftMint: proof.nftMint.toBase58(),
  partnerPosition: proof.partner.position.toBase58(), partnerNftAccount: proof.partner.nftAccount.toBase58(), partnerNftMint: proof.partner.nftMint.toBase58() })
const sameRow = (a, b) => Object.keys(a).every(key => String(a[key]) === String(b?.[key]))
const PROOF_COLUMNS = `curve, config, mint, pool, signature, slot::text as slot, creator_position as "creatorPosition",
  creator_nft_account as "creatorNftAccount", creator_nft_mint as "creatorNftMint", partner_position as "partnerPosition",
  partner_nft_account as "partnerNftAccount", partner_nft_mint as "partnerNftMint"`

// Code may deploy before migration 0024. Only a missing table (42P01) falls back to the chain scan;
// every other database error still fails the read.
let proofTableMissing = false
async function proofQuery(db, text, params) {
  if (proofTableMissing) return null
  try { return await db.query(text, params) } catch (error) {
    if (error?.code !== '42P01') throw error
    proofTableMissing = true
    console.error('graduated migration proof table missing; using chain scan')
    return null
  }
}

export function createGraduatedFees({ connection, config, db = null, loadTransaction = loadFinalizedTransaction }) {
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const amm = new CpAmm(connection)
  const resolve = createMarketConfigResolver(config)
  const proven = verifiedMigrations
  const repoId = market => market.githubRepoId ?? market.repoId
  // A stored proof is only a pointer: its signature is reloaded from finalized chain state and must
  // reproduce every stored account, so a stale or tampered row fails closed instead of paying.
  async function storedProof(market, configKey, target) {
    if (!db || repoId(market) == null) return null
    const result = await proofQuery(db, `select ${PROOF_COLUMNS} from graduated_migration_proofs where github_repo_id=$1`, [String(repoId(market))])
    const row = result?.rows[0]
    if (!row) return null
    const tx = await loadTransaction(connection, row.signature)
    const match = migrationPosition(tx, market, configKey, target)
    const proof = match && { ...match, signature: row.signature, slot: tx.slot }
    if (!proof || !sameRow(proofRow(market, configKey, target, proof), row)) throw Error('Stored graduated migration proof mismatch')
    return { ...proof, stored: true }
  }
  async function storeProof(market, configKey, target, proof) {
    if (!db || repoId(market) == null) return proof
    const row = proofRow(market, configKey, target, proof)
    const inserted = await proofQuery(db, `insert into graduated_migration_proofs (github_repo_id, curve, config, mint, pool, signature, slot, creator_position,
      creator_nft_account, creator_nft_mint, partner_position, partner_nft_account, partner_nft_mint)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (github_repo_id) do nothing`,
    [String(repoId(market)), ...Object.values(row)])
    if (!inserted) return proof
    const { rows: [stored] } = await db.query(`select ${PROOF_COLUMNS} from graduated_migration_proofs where github_repo_id=$1`, [String(repoId(market))])
    if (!sameRow(row, stored)) throw Error('Conflicting graduated migration proof; review required')
    return { ...proof, stored: true }
  }
  // The canonical DAMM pool is derived from the fixed config and must be named by the curve's own
  // finalized migrate instruction. Trading and fee accounting share this proof.
  async function destination(market, suppliedState, suppliedFixed) {
    const configKey = resolve(market)
    const state = suppliedState ?? await dbc.state.getPool(market.pool)
    const fixed = suppliedFixed ?? await readPoolConfig(dbc, configKey)
    if (!state || !fixed || !state.poolState.config.equals(configKey) ||
        state.poolState.baseMint.toBase58() !== market.mint || state.poolState.creator.toBase58() !== market.creatorWallet) throw Error('Invalid canonical creator pool')
    if (!state.poolState.isMigrated) return null
    if (fixed.migrationOption !== MigrationOption.MET_DAMM_V2 || !fixed.quoteMint.equals(NATIVE_MINT) ||
        fixed.creatorPermanentLockedLiquidityPercentage !== 50 || fixed.partnerPermanentLockedLiquidityPercentage !== 50) throw Error('Unsupported graduated fee configuration')
    const feeConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption]
    if (!feeConfig) throw Error('Unknown migration fee configuration')
    const target = deriveDammV2PoolAddress(feeConfig, new PublicKey(market.mint), NATIVE_MINT)
    const cacheKey = `${connection.rpcEndpoint}:${market.pool}`
    let proof = proven.get(cacheKey)
    if (!proof) proof = await storedProof(market, configKey, target)
    if (!proof) {
      proof = await findMigration(connection, loadTransaction, market, configKey, target)
      if (!proof) throw Error('Finalized canonical DAMM migration evidence unavailable')
    }
    if (!proven.has(cacheKey)) {
      if (proven.size >= 1000) proven.delete(proven.keys().next().value)
      proven.set(cacheKey, proof)
    }
    return { configKey, fixed, target, proof, cacheKey }
  }
  async function read(market, suppliedState, suppliedFixed) {
    const found = await destination(market, suppliedState, suppliedFixed)
    if (!found) return null
    const { configKey, fixed, target, cacheKey } = found
    let { proof } = found
    // One finalized bank snapshot avoids mixing fee growth and claim checkpoints from different slots.
    const accounts = [target, proof.position, proof.nftAccount, proof.partner.position, proof.partner.nftAccount]
    const snapshot = await connection.getMultipleAccountsInfoAndContext(accounts, 'finalized')
    const [poolInfo, positionInfo, nftInfo, partnerPositionInfo, partnerNftInfo] = snapshot.value
    if (!poolInfo?.owner.equals(CP_AMM_PROGRAM_ID) || !positionInfo?.owner.equals(CP_AMM_PROGRAM_ID) ||
        !partnerPositionInfo?.owner.equals(CP_AMM_PROGRAM_ID)) throw Error('Invalid DAMM account owner')
    const poolState = amm._program.coder.accounts.decode('pool', poolInfo.data)
    const positionState = amm._program.coder.accounts.decode('position', positionInfo.data)
    const nft = unpackAccount(proof.nftAccount, nftInfo, TOKEN_2022_PROGRAM_ID)
    if (!poolState.tokenAMint.equals(new PublicKey(market.mint)) || !poolState.tokenBMint.equals(NATIVE_MINT) ||
        poolState.collectFeeMode !== 1 || !positionState.pool.equals(target) || !positionState.nftMint.equals(proof.nftMint) ||
        !nft.mint.equals(proof.nftMint) || nft.owner.toBase58() !== market.creatorWallet || nft.amount !== 1n || nft.delegate ||
        positionState.permanentLockedLiquidity.lten(0) || positionState.unlockedLiquidity.gtn(1) || !positionState.vestedLiquidity.isZero()) throw Error('Graduated creator position or SOL fee mode mismatch')
    const partnerState = amm._program.coder.accounts.decode('position', partnerPositionInfo.data)
    const partnerNft = unpackAccount(proof.partner.nftAccount, partnerNftInfo, TOKEN_2022_PROGRAM_ID)
    if (!fixed.feeClaimer || !partnerState.pool.equals(target) || !partnerState.nftMint.equals(proof.partner.nftMint) ||
        !partnerNft.mint.equals(proof.partner.nftMint) || !partnerNft.owner.equals(fixed.feeClaimer) || partnerNft.amount !== 1n ||
        partnerNft.delegate || partnerState.permanentLockedLiquidity.lten(0) || partnerState.unlockedLiquidity.gtn(1) ||
        !partnerState.vestedLiquidity.isZero()) throw Error('Graduated partner position or fee claimer mismatch')
    const fees = getUnClaimLpFee(poolState, positionState)
    if (!fees.feeTokenA.isZero() || !positionState.metrics.totalClaimedAFee.isZero()) throw Error('Non-SOL graduated fees require separate asset accounting')
    const partnerFees = getUnClaimLpFee(poolState, partnerState)
    if (!partnerFees.feeTokenA.isZero() || !partnerState.metrics.totalClaimedAFee.isZero()) throw Error('Non-SOL partner fees require separate asset accounting')
    const available = BigInt(fees.feeTokenB.toString()), claimed = BigInt(positionState.metrics.totalClaimedBFee.toString())
    const partnerAvailable = BigInt(partnerFees.feeTokenB.toString()), partnerClaimed = BigInt(partnerState.metrics.totalClaimedBFee.toString())
    if (available < 0n || claimed < 0n || partnerAvailable < 0n || partnerClaimed < 0n) throw Error('Negative graduated fee state')
    // Persist only a proof that was just proven from finalized history and passed every current check.
    if (!proof.stored && db && !proofTableMissing) proven.set(cacheKey, proof = await storeProof(market, configKey, target, proof))
    const evidence = { migration: proof.signature, accounts: snapshot.value.slice(0, 3).map((info, i) => ({
      address: accounts[i].toBase58(), owner: info.owner.toBase58(), data: info.data.toString('base64') })) }
    const partnerEvidence = { migration: proof.signature, accounts: [target, proof.partner.position, proof.partner.nftAccount]
      .map((address, i) => ({ address: address.toBase58(), owner: snapshot.value[[0, 3, 4][i]].owner.toBase58(),
        data: snapshot.value[[0, 3, 4][i]].data.toString('base64') })) }
    return { pool: target, position: proof.position, nftAccount: proof.nftAccount, poolState,
      available, claimed, earned: available + claimed, slot: snapshot.context.slot, evidence,
      hash: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), amm,
      partner: { pool: target, position: proof.partner.position, nftAccount: proof.partner.nftAccount, poolState,
        available: partnerAvailable, claimed: partnerClaimed, earned: partnerAvailable + partnerClaimed, slot: snapshot.context.slot,
        evidence: partnerEvidence, hash: createHash('sha256').update(JSON.stringify(partnerEvidence)).digest('hex'), amm } }
  }
  return { read, destination }
}

// Caller holds the repository advisory lock. Credits are append-only finalized account evidence,
// separate from transaction swap events; no synthetic trade or SOL estimate is inserted.
export async function recordGraduatedFees(client, market, snapshot) {
  if (!snapshot) return 0n
  const { rows } = await client.query('select coalesce(sum(amount_base_units),0)::text as earned from damm_fee_events where github_repo_id=$1', [String(market.githubRepoId)])
  const previous = BigInt(rows[0].earned)
  if (snapshot.earned < previous) throw Error('Graduated fee entitlement decreased; review required')
  const credit = snapshot.earned - previous
  if (credit > 0n) await client.query(`insert into damm_fee_events
    (github_repo_id, pool, position, slot, amount_base_units, cumulative_earned, cumulative_claimed, evidence_hash, evidence)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [String(market.githubRepoId), snapshot.pool.toBase58(), snapshot.position.toBase58(),
    snapshot.slot, String(credit), String(snapshot.earned), String(snapshot.claimed), snapshot.hash, JSON.stringify(snapshot.evidence)])
  return credit
}

// Platform revenue from the permanently locked partner position. Append-only finalized
// evidence, kept strictly separate from builder credits and discovery rewards.
export async function recordPlatformFees(client, market, partner) {
  if (!partner) return 0n
  const { rows } = await client.query('select coalesce(sum(amount_base_units),0)::text as earned from platform_fee_events where github_repo_id=$1', [String(market.githubRepoId)])
  const previous = BigInt(rows[0].earned)
  if (partner.earned < previous) throw Error('Platform fee entitlement decreased; review required')
  const credit = partner.earned - previous
  if (credit > 0n) await client.query(`insert into platform_fee_events
    (github_repo_id, pool, position, slot, amount_base_units, cumulative_earned, cumulative_claimed, evidence_hash, evidence)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [String(market.githubRepoId), partner.pool.toBase58(), partner.position.toBase58(),
    partner.slot, String(credit), String(partner.earned), String(partner.claimed), partner.hash, JSON.stringify(partner.evidence)])
  return credit
}
