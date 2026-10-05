import bs58 from 'bs58'
import { PublicKey, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getAccount, getMint, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver } from './market-config.mjs'
import { createGraduatedFees } from './graduated-fees.mjs'
import { settleAllocation } from './builder-allocation-settlement.mjs'
import { broadcastUntilSettled, signedWithPriorityFee } from './trade-landing.mjs'
import { MarketIdentityError, assertAuthoritySource, isMarketId, marketSource } from './market-identity.mjs'
import { assertBindingAuthority } from './claim.mjs'
import { activateDuePayoutAddress } from './payout-address.mjs'
import { modelBeneficiary } from './wallet-binding.mjs'

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

// Hugging Face model markets (owner decision: they keep the 1% allocation) are claimed under the GitHub rules above, with
// Hugging Face authority: the model's CURRENT owner, re-checked at claim time (the signed-in user owns the model, or is an
// admin of the organization that owns it; SSO/MFA-restricted organizations fail closed in src/hf-verification.mjs), paid
// to the wallet bound through the model's Hugging Face binding (src/wallet-binding.mjs, 0051), one grant per market ever.
const SUBJECT = /^[0-9a-f]{24}$/
const isModelMarketId = id => isMarketId(id) && marketSource(id) === 'huggingface'
const isoTime = value => { const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toISOString() : null }

// The fresh Hugging Face check for a model market's grant (app/lib/hf-session.mjs verifyCurrentAuthority): this market's,
// an owner or org admin whose role matches the owner's kind, at most 60 s old, and the same user and model owner the review
// was sealed for, so a change of either since the review refuses the claim. Returns the check's time.
export function assertModelAllocationAuthority(authority, review, now = Date.now()) {
  assertAuthoritySource(authority, review.repoId)
  const checkedAt = new Date(authority.verifiedAt).getTime()
  const role = authority.role === 'owner' ? authority.ownerKind === 'user' && authority.subject === authority.ownerSubject
    : authority.role === 'admin' && authority.ownerKind === 'org' && authority.subject !== authority.ownerSubject
  if (authority.verified !== true || authority.permission !== 'admin' || !role || String(authority.githubRepoId) !== String(review.repoId) ||
      !SUBJECT.test(authority.subject ?? '') || !SUBJECT.test(authority.ownerSubject ?? '') ||
      authority.subject !== review.subject || authority.ownerSubject !== review.ownerSubject ||
      !Number.isFinite(checkedAt) || now - checkedAt > 60000 || checkedAt > now + 5000) throw Error('Current Hugging Face owner authority required')
  return checkedAt
}

// binding: modelBeneficiary(…, { subject: authority.subject }), the market's binding only if this Hugging Face user made it
// (the counterpart of repo_beneficiaries.github_user_id). A binding made for a previous owner is never paid
// (assertBindingAuthority, src/claim.mjs); otherwise it must still be the reviewed wallet and binding time, and never the
// protected creator signer itself.
export function assertModelAllocationBinding(binding, { review, authority, creatorWallet }) {
  if (!binding) throw Error('Payout wallet or authority changed; bind your wallet and review again')
  assertBindingAuthority({ authoritySource: 'huggingface', authorityOwnerSubject: binding.ownerSubject }, 'huggingface', authority)
  if (binding.subject !== authority.subject || binding.wallet !== review.wallet || isoTime(binding.boundAt) !== review.boundAt ||
      binding.wallet === creatorWallet) throw Error('Payout wallet or authority changed; bind your wallet and review again')
}

export function createBuilderAllocation({ pool, connection, config, creator, githubVerifier }) {
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const resolve = createMarketConfigResolver(config)
  const graduation = createGraduatedFees({ connection, config, db: pool })
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
  // knownGraduated: the caller already saw this market graduate (graduation never reverses), so display status skips the
  // chain reads. A claim never takes this shortcut: claim() inspects the chain itself.
  async function status(repoId, { knownGraduated = false } = {}) {
    const market = await allocationRecord(pool, repoId)
    if (!market) return { enrolled: false }
    if (market.latest?.status === 'settled' || market.latest?.status === 'pending') {
      return { enrolled: true, amount: String(BUILDER_ALLOCATION), state: market.latest.status, receipt: market.latest }
    }
    if (knownGraduated) return { enrolled: true, amount: String(BUILDER_ALLOCATION), state: 'available' }
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
        const grant = new Transaction()
        if (!state.poolState.isWithdrawLeftover) {
          grant.add(await dbc.migration.withdrawLeftover({ pool: new PublicKey(market.pool), payer: creator.publicKey }))
        } else {
          // Withdrawal is permissionless but always pays the immutable protected receiver.
          // A third party performing it cannot change the grant's recipient or create a second grant.
          const reserve = await getAccount(connection, source, 'finalized')
          if (reserve.amount < BUILDER_ALLOCATION || reserve.delegate || !reserve.owner.equals(creator.publicKey)) throw Error('Builder token reserve needs review')
        }
        grant.add(createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, destination, recipient, mint),
          createTransferCheckedInstruction(source, mint, destination, creator.publicKey, BUILDER_ALLOCATION, 6))
        const latest = await connection.getLatestBlockhash('confirmed')
        const { transaction: tx } = await signedWithPriorityFee(connection, grant, { feePayer: creator.publicKey,
          blockhash: latest.blockhash, signers: [creator] })
        const simulation = await connection.simulateTransaction(tx)
        if (simulation.value.err) throw Error('Allocation preflight failed; reserve or network funds need checking')
        if (Date.now() - checkedAt > 60000 || review.expiresAt <= Date.now()) throw Error('Allocation review expired')
        const signature = bs58.encode(tx.signature), signedTransaction = tx.serialize().toString('base64')
        const intent = { signature, signedTransaction, wallet: beneficiary.wallet, mint: market.mint, amount: String(BUILDER_ALLOCATION) }
        await client.query(`insert into builder_allocation_claims
          (github_repo_id, github_user_id, mint, wallet, amount, status, signature, signed_transaction, last_valid_block_height)
          values($1,$2,$3,$4,$5,'pending',$6,$7,$8)`, [repoId, String(github.githubUserId), market.mint, beneficiary.wallet, intent.amount, signature, signedTransaction, latest.lastValidBlockHeight])
        await broadcastUntilSettled(connection, tx.serialize(), { signature, lastValidBlockHeight: latest.lastValidBlockHeight })
        await connection.confirmTransaction({ signature, ...latest }, 'finalized')
        const receipt = await settleAllocation(client, connection, intent)
        if (!receipt) throw Error('Allocation submitted; final receipt is being checked')
        return receipt
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId]) }
    } finally { client.release() }
  }
  // A model market's grant: claim() above with Hugging Face authority (githubVerifier.source 'huggingface', as for fee
  // claims in src/claim.mjs) and the model's Hugging Face binding. review: sealed for one Hugging Face session
  // (app/lib/hf-auth.mjs) with the user (subject), the model owner it was made under (ownerSubject) and the binding.
  async function claimModel({ review }) {
    if (!creator || !githubVerifier || !review || !(review.expiresAt > Date.now()) || review.amount !== String(BUILDER_ALLOCATION)) throw Error('Allocation review expired')
    const repoId = String(review.repoId)
    // Before anything is read or written: the payout authority must be the market's own source.
    assertAuthoritySource(githubVerifier, repoId)
    if (!SUBJECT.test(review.subject ?? '') || !SUBJECT.test(review.ownerSubject ?? '')) throw Error('Allocation review expired')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId])
      try {
        const market = await allocationRecord(client, repoId)
        if (!market) throw Error('Market is not enrolled for an allocation')
        if (market.latest && ['pending','settled'].includes(market.latest.status)) throw Error('Allocation already submitted or paid')
        if (market.creatorWallet !== creator.publicKey.toBase58()) throw Error('Wrong allocation authority')
        const authority = await githubVerifier.verifyCurrentAuthority({ githubRepoId: BigInt(repoId) })
        const checkedAt = assertModelAllocationAuthority(authority, review)
        // As for a fee claim: a pasted address whose hold has passed becomes the binding first, with a new bound_at, so a
        // review of the previous recipient stops matching (src/payout-address.mjs).
        await activateDuePayoutAddress(client, repoId)
        const binding = await modelBeneficiary(client, repoId, { subject: authority.subject })
        assertModelAllocationBinding(binding, { review, authority, creatorWallet: creator.publicKey.toBase58() })
        return await grantModelAllocation(client, market, { repoId, wallet: binding.wallet, authority, checkedAt, review })
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId]) }
    } finally { client.release() }
  }
  // The grant steps of claim() above, from inspect() on; only the durable intent names the Hugging Face authority. Keep the
  // two in step.
  async function grantModelAllocation(client, market, { repoId, wallet, authority, checkedAt, review }) {
    const { state, graduated } = await inspect(market)
    if (!graduated) throw Error('Builder allocation stays locked until verified graduation')
    const mint = new PublicKey(market.mint), recipient = new PublicKey(wallet)
    const source = getAssociatedTokenAddressSync(mint, creator.publicKey)
    const destination = getAssociatedTokenAddressSync(mint, recipient)
    const grant = new Transaction()
    if (!state.poolState.isWithdrawLeftover) {
      grant.add(await dbc.migration.withdrawLeftover({ pool: new PublicKey(market.pool), payer: creator.publicKey }))
    } else {
      const reserve = await getAccount(connection, source, 'finalized')
      if (reserve.amount < BUILDER_ALLOCATION || reserve.delegate || !reserve.owner.equals(creator.publicKey)) throw Error('Builder token reserve needs review')
    }
    grant.add(createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, destination, recipient, mint),
      createTransferCheckedInstruction(source, mint, destination, creator.publicKey, BUILDER_ALLOCATION, 6))
    const latest = await connection.getLatestBlockhash('confirmed')
    const { transaction: tx } = await signedWithPriorityFee(connection, grant, { feePayer: creator.publicKey,
      blockhash: latest.blockhash, signers: [creator] })
    const simulation = await connection.simulateTransaction(tx)
    if (simulation.value.err) throw Error('Allocation preflight failed; reserve or network funds need checking')
    if (Date.now() - checkedAt > 60000 || !(review.expiresAt > Date.now())) throw Error('Allocation review expired')
    const signature = bs58.encode(tx.signature), signedTransaction = tx.serialize().toString('base64')
    const intent = { signature, signedTransaction, wallet, mint: market.mint, amount: String(BUILDER_ALLOCATION) }
    await client.query(`insert into builder_allocation_claims
      (github_repo_id, github_user_id, mint, wallet, amount, status, signature, signed_transaction, last_valid_block_height,
        authority_source, authority_subject, authority_owner_subject)
      values($1,null,$2,$3,$4,'pending',$5,$6,$7,'huggingface',$8,$9)`, [repoId, market.mint, wallet, intent.amount, signature, signedTransaction,
      latest.lastValidBlockHeight, authority.subject, authority.ownerSubject])
    await broadcastUntilSettled(connection, tx.serialize(), { signature, lastValidBlockHeight: latest.lastValidBlockHeight })
    await connection.confirmTransaction({ signature, ...latest }, 'finalized')
    const receipt = await settleAllocation(client, connection, intent)
    if (!receipt) throw Error('Allocation submitted; final receipt is being checked')
    return receipt
  }
  // A model market id takes claimModel; every other request runs claim() exactly as before, and a verifier from another
  // source is refused before anything is read.
  function claimForSource(request) {
    if (isModelMarketId(request?.review?.repoId)) return claimModel(request)
    const source = githubVerifier?.source ?? 'github'
    if (source !== 'github') return Promise.reject(new MarketIdentityError(`A ${source} authority cannot act for a github market`))
    return claim(request)
  }
  return { status, claim: claimForSource }
}
