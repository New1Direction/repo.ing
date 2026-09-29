import bs58 from 'bs58'
import { PublicKey, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getAccount, getMint, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver } from './market-config.mjs'
import { createGraduatedFees } from './graduated-fees.mjs'
import { settleAllocation } from './builder-allocation-settlement.mjs'

export const BUILDER_ALLOCATION = 10_000_000_000_000n
export const FIXED_SUPPLY = 1_000_000_000_000_000n
export function allocationConfigs(value = process.env.BUILDER_ALLOCATION_CONFIGS ?? '') {
  return value.split(',').map(s => s.trim()).filter(Boolean).map(s => new PublicKey(s).toBase58())
}
export function allocationEnabled(config) { return Boolean(config && allocationConfigs().includes(String(config))) }

export async function allocationRecord(pool, repoId) {
  const { rows: [market] } = await pool.query(`select github_repo_id::text as "githubRepoId", mint, pool,
    creator_wallet as "creatorWallet", builder_allocation_version as version from markets
    where github_repo_id=$1 and status='confirmed' and indexed_at is not null and launch_finality='finalized'`, [String(repoId)])
  if (!market || market.version !== 1) return null
  const { rows: [latest] } = await pool.query(`select status, signature, wallet, amount::text from builder_allocation_claims
    where github_repo_id=$1 order by id desc limit 1`, [String(repoId)])
  return { ...market, latest: latest ?? null }
}
// Fixed supply is proven by the immutable 1B launch config plus no mint authority. Current supply
// may be lower: any holder can burn, and that must not block the builder allocation forever.
export function allocationReserveValid({ market, configKey, state, fixed, mint }) {
  return Boolean(state && fixed && fixed.leftoverReceiver.equals(new PublicKey(market.creatorWallet)) &&
    state.poolState.creator.equals(fixed.leftoverReceiver) && fixed.quoteMint.equals(NATIVE_MINT) && fixed.tokenType === 0 &&
    state.poolState.config.equals(configKey) && state.poolState.baseMint.toBase58() === market.mint &&
    BigInt(fixed.preMigrationTokenSupply.toString()) === FIXED_SUPPLY && mint.supply <= FIXED_SUPPLY &&
    mint.decimals === 6 && !mint.mintAuthority && !mint.freezeAuthority)
}
export function createBuilderAllocation({ pool, connection, config, creator, githubVerifier }) {
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const resolve = createMarketConfigResolver(config)
  const graduation = createGraduatedFees({ connection, config })
  async function inspect(market) {
    const configKey = resolve(market)
    if (!allocationEnabled(configKey.toBase58())) throw Error('Allocation configuration is not approved')
    const [state, fixed, mint] = await Promise.all([
      dbc.state.getPool(market.pool), dbc.state.getPoolConfig(configKey), getMint(connection, new PublicKey(market.mint), 'finalized'),
    ])
    if (!allocationReserveValid({ market, configKey, state, fixed, mint })) throw Error('Allocation reserve configuration needs review')
    const graduated = await graduation.read(market, state, fixed)
    return { state, fixed, graduated }
  }
  async function status(repoId) {
    const market = await allocationRecord(pool, repoId)
    if (!market) return { enrolled: false }
    if (market.latest?.status === 'settled' || market.latest?.status === 'pending') {
      return { enrolled: true, amount: String(BUILDER_ALLOCATION), state: market.latest.status, receipt: market.latest }
    }
    const { graduated } = await inspect(market)
    return { enrolled: true, amount: String(BUILDER_ALLOCATION), state: graduated ? 'available' : 'locked' }
  }
  async function claim({ review, githubAuthorization }) {
    if (!creator || !githubVerifier || !review || review.expiresAt <= Date.now() || review.amount !== String(BUILDER_ALLOCATION)) throw Error('Allocation review expired')
    const repoId = String(review.repoId)
    if (!/^[1-9]\d*$/.test(repoId)) throw Error('Invalid repository')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId])
      try {
        const market = await allocationRecord(client, repoId)
        if (!market) throw Error('Market is not enrolled for an allocation')
        if (market.latest && ['pending','settled'].includes(market.latest.status)) throw Error('Allocation already submitted or paid')
        if (market.creatorWallet !== creator.publicKey.toBase58()) throw Error('Wrong allocation authority')
        const github = await githubVerifier.verifyCurrentAuthority({ githubRepoId: BigInt(repoId), ...githubAuthorization })
        const checkedAt = new Date(github.verifiedAt).getTime()
        if (!github.verified || github.permission !== 'admin' || String(github.githubRepoId) !== repoId ||
            String(github.githubUserId) !== String(review.githubUserId) || !Number.isFinite(checkedAt) ||
            Date.now() - checkedAt > 60000 || checkedAt > Date.now() + 5000) throw Error('Current GitHub admin authority required')
        const { rows: [beneficiary] } = await client.query('select wallet, bound_at, github_user_id::text as user from repo_beneficiaries where github_repo_id=$1', [repoId])
        if (!beneficiary || beneficiary.wallet !== review.wallet || beneficiary.bound_at.toISOString() !== review.boundAt ||
            beneficiary.user !== String(github.githubUserId) || beneficiary.wallet === creator.publicKey.toBase58()) throw Error('Payout wallet or authority changed; bind your wallet and review again')
        const { state, graduated } = await inspect(market)
        if (!graduated) throw Error('Builder allocation stays locked until verified graduation')
        const mint = new PublicKey(market.mint), recipient = new PublicKey(beneficiary.wallet)
        const source = getAssociatedTokenAddressSync(mint, creator.publicKey)
        const destination = getAssociatedTokenAddressSync(mint, recipient)
        const tx = new Transaction()
        if (!state.poolState.isWithdrawLeftover) {
          tx.add(await dbc.migration.withdrawLeftover({ pool: new PublicKey(market.pool), payer: creator.publicKey }))
        } else {
          // Withdrawal is permissionless but always pays the immutable protected receiver.
          // A third party performing it cannot change the grant's recipient or create a second grant.
          const reserve = await getAccount(connection, source, 'finalized')
          if (reserve.amount < BUILDER_ALLOCATION || reserve.delegate || !reserve.owner.equals(creator.publicKey)) throw Error('Builder token reserve needs review')
        }
        tx.add(createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, destination, recipient, mint),
          createTransferCheckedInstruction(source, mint, destination, creator.publicKey, BUILDER_ALLOCATION, 6))
        const latest = await connection.getLatestBlockhash('confirmed')
        tx.feePayer = creator.publicKey; tx.recentBlockhash = latest.blockhash; tx.sign(creator)
        const simulation = await connection.simulateTransaction(tx)
        if (simulation.value.err) throw Error('Allocation preflight failed; reserve or network funds need checking')
        if (Date.now() - checkedAt > 60000 || review.expiresAt <= Date.now()) throw Error('Allocation review expired')
        const signature = bs58.encode(tx.signature), signedTransaction = tx.serialize().toString('base64')
        const intent = { signature, signedTransaction, wallet: beneficiary.wallet, mint: market.mint, amount: String(BUILDER_ALLOCATION) }
        await client.query(`insert into builder_allocation_claims
          (github_repo_id, github_user_id, mint, wallet, amount, status, signature, signed_transaction, last_valid_block_height)
          values($1,$2,$3,$4,$5,'pending',$6,$7,$8)`, [repoId, String(github.githubUserId), market.mint, beneficiary.wallet, intent.amount, signature, signedTransaction, latest.lastValidBlockHeight])
        await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
        await connection.confirmTransaction({ signature, ...latest }, 'finalized')
        const receipt = await settleAllocation(client, connection, intent)
        if (!receipt) throw Error('Allocation submitted; final receipt is being checked')
        return receipt
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId]) }
    } finally { client.release() }
  }
  return { status, claim }
}
