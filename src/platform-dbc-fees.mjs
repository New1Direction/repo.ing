import { createHash } from 'node:crypto'
import { broadcastUntilSettled } from './trade-landing.mjs'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { ACCOUNT_SIZE, NATIVE_MINT, TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver } from './market-config.mjs'
import { discoveryEarned } from './discovery-rewards.mjs'

const PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const EVENT_PREFIX = Buffer.from('e445a52e51cb9a1d', 'hex')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const local = connection => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(connection.rpcEndpoint)

export function platformTreasuryWallet(partner, env = process.env) {
  return new PublicKey(env.PLATFORM_FEE_TREASURY_WALLET || partner.toBase58())
}

export function dbcPlatformEntitlement({ gross, eligible, discoveryPaid, platformPaid, version, onchain }) {
  if ([gross, eligible, discoveryPaid, platformPaid, onchain].some(n => BigInt(n) < 0n) || BigInt(eligible) > BigInt(gross)) throw Error('Invalid partner fee evidence')
  const earned = version == null ? 0n : discoveryEarned(eligible, version)
  const reserved = earned - BigInt(discoveryPaid)
  const expected = BigInt(gross) - BigInt(discoveryPaid) - BigInt(platformPaid)
  if (reserved < 0n || expected < reserved) throw Error('Partner or discovery entitlement is inconsistent')
  if (BigInt(onchain) !== expected) throw Error('DBC partner fees need indexing or reconciliation before collection')
  return { gross: String(gross), discoveryEarned: String(earned), discoveryReserved: String(reserved),
    platformPaid: String(platformPaid), onchainAvailable: String(onchain), available: String(expected - reserved) }
}

export function createDbcPlatformFees({ pool, connection, config, partner, verification = null, env = process.env }) {
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const resolve = createMarketConfigResolver(config)
  const coder = dbc.state.getProgram().coder.accounts
  const destination = () => platformTreasuryWallet(partner.publicKey, env)
  async function withLock(repoId, fn) {
    if (!/^[1-9]\d*$/.test(String(repoId))) throw Error('Invalid repository')
    const db = await pool.connect()
    try {
      await db.query('select pg_advisory_lock($1::bigint)', [String(repoId)])
      try { return await fn(db) } finally { await db.query('select pg_advisory_unlock($1::bigint)', [String(repoId)]) }
    } finally { db.release() }
  }
  async function inspect(db, repoId) {
    if (!partner) throw Error('Protected partner signer is required')
    const { rows: [m] } = await db.query(`select github_repo_id::text as "repoId",mint,pool,
      creator_wallet as "creatorWallet",discovery_version as version from markets
      where github_repo_id=$1 and status='confirmed' and indexed_at is not null and launch_finality='finalized'`, [String(repoId)])
    if (!m) throw Error('Market is not finalized and indexed')
    const configKey = resolve(m), poolKey = new PublicKey(m.pool), receiver = destination()
    if (!local(connection) && !verification) throw Error('Independent RPC verification is required for collection')
    const keys = [poolKey, configKey]
    const reads = await Promise.all([connection, ...(verification ? [verification] : [])].map(c => c.getMultipleAccountsInfoAndContext(keys, 'finalized')))
    for (const read of reads) for (const a of read.value) if (!a?.owner.equals(PROGRAM)) throw Error('Invalid canonical DBC account')
    if (reads.length === 2 && reads[0].value.some((a, i) => !a.data.equals(reads[1].value[i].data))) throw Error('RPC disagreement; refresh before collection')
    const s = coder.decode('virtualPool', reads[0].value[0].data).poolState
    const fixed = coder.decode('poolConfig', reads[0].value[1].data)
    if (!s.config.equals(configKey) || s.baseMint.toBase58() !== m.mint || s.creator.toBase58() !== m.creatorWallet ||
      !deriveDbcPoolAddress(NATIVE_MINT, s.baseMint, configKey).equals(poolKey) || !fixed.feeClaimer.equals(partner.publicKey) ||
      !fixed.quoteMint.equals(NATIVE_MINT) || fixed.collectFeeMode !== 0 || fixed.tokenType !== 0 ||
      !s.partnerBaseFee.isZero()) throw Error('Canonical partner config or SOL fee mode mismatch')
    if (receiver.toBase58() === m.creatorWallet) throw Error('Treasury must not be the builder payout signer')
    const { rows: [totals] } = await db.query(`select
      coalesce((select sum(partner_amount) from discovery_fee_events where github_repo_id=$1),0)::text as gross,
      coalesce((select sum(partner_amount) from discovery_fee_events where github_repo_id=$1 and discovery_eligible),0)::text as eligible,
      coalesce((select sum(amount) from discovery_claims where github_repo_id=$1 and status='settled'),0)::text as "discoveryPaid",
      coalesce((select sum(amount) from platform_fee_claims where github_repo_id=$1 and phase='DBC' and status='settled'),0)::text as "platformPaid",
      (select count(*)::int from discovery_claims where github_repo_id=$1 and status='pending') as "discoveryPending",
      (select count(*)::int from platform_fee_claims where github_repo_id=$1 and status='pending') as "platformPending"`, [String(repoId)])
    if (totals.discoveryPending || totals.platformPending) throw Error('A partner fee claim is already in flight')
    const entitlement = dbcPlatformEntitlement({ ...totals, version: m.version, onchain: s.partnerQuoteFee.toString() })
    const terms = { phase: 'DBC', repoId: String(repoId), mint: m.mint, pool: m.pool, config: configKey.toBase58(),
      receiver: receiver.toBase58(), source: partner.publicKey.toBase58(), ...entitlement }
    return { ...terms, termsHash: hash(terms), slot: reads[0].context.slot, quoteVault: s.quoteVault.toBase58(),
      creatorUnclaimed: s.creatorQuoteFee.toString(), enrolled: true, state: 'available' }
  }
  async function claim({ review, simulateOnly = false }) {
    if (env.PLATFORM_DBC_COLLECTION_ENABLED !== 'true') throw Error('DBC platform collection is disabled')
    if (!review || review.purpose !== 'platform-fee-review' || review.phase !== 'DBC' ||
      !Number.isFinite(review.expiresAt) || review.expiresAt <= Date.now()) throw Error('Platform fee review expired')
    const genesis = await connection.getGenesisHash()
    if (!local(connection) && genesis !== MAINNET) throw Error('Platform collection requires Solana mainnet')
    if (verification && await verification.getGenesisHash() !== genesis) throw Error('RPC network disagreement')
    return withLock(review.repoId, async db => {
      const current = await inspect(db, review.repoId)
      if (review.receiver !== current.receiver || review.termsHash !== current.termsHash || String(review.amount) !== current.available) throw Error('Platform claim terms changed; refresh and review again')
      const amount = BigInt(current.available)
      if (amount <= 0n) throw Error('No platform fees remain to claim')
      const receivingAccount = await connection.getAccountInfo(new PublicKey(current.receiver), 'finalized')
      if (!PublicKey.isOnCurve(new PublicKey(current.receiver)) || (receivingAccount &&
        (receivingAccount.executable || !receivingAccount.owner.equals(SystemProgram.programId)))) throw Error('Treasury must be a normal Solana wallet')
      if (!/^[1-9]\d*$/.test(String(review.maxNetworkFeeLamports)) || BigInt(review.maxNetworkFeeLamports) > 100_000n) throw Error('Invalid reviewed network fee limit')
      // Fresh temporary ATAs keep the claim from closing any existing wallet
      // token account. Both rent deposits return to the fee payer atomically.
      const temporary = Keypair.generate(), receiver = new PublicKey(current.receiver)
      const tx = await dbc.partner.claimPartnerTradingFee({ feeClaimer: partner.publicKey, payer: partner.publicKey,
        receiver: temporary.publicKey, tempWSolAcc: temporary.publicKey, pool: new PublicKey(current.pool),
        maxBaseAmount: new BN(0), maxQuoteAmount: new BN(amount.toString()) })
      const rent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)
      const baseAccount = getAssociatedTokenAddressSync(new PublicKey(current.mint), temporary.publicKey)
      const quoteAccount = getAssociatedTokenAddressSync(NATIVE_MINT, temporary.publicKey)
      tx.add(SystemProgram.transfer({ fromPubkey: temporary.publicKey, toPubkey: receiver, lamports: amount }),
        SystemProgram.transfer({ fromPubkey: temporary.publicKey, toPubkey: partner.publicKey, lamports: rent }),
        createCloseAccountInstruction(baseAccount, partner.publicKey, temporary.publicKey))
      const latest = await connection.getLatestBlockhash('confirmed')
      tx.feePayer = partner.publicKey; tx.recentBlockhash = latest.blockhash; tx.sign(partner, temporary)
      const fee = (await connection.getFeeForMessage(tx.compileMessage(), 'confirmed')).value
      if (fee == null || BigInt(fee) > BigInt(review.maxNetworkFeeLamports) || amount <= BigInt(fee)) throw Error('Claim does not cover its reviewed network cost')
      if (await connection.getBalance(partner.publicKey, 'confirmed') < rent * 2 + fee) throw Error('Partner signer needs operating SOL for temporary deposits')
      const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(tx.serialize()), { sigVerify: true, commitment: 'confirmed' })
      if (simulation.value.err) throw Error(`DBC platform collection preflight failed: ${JSON.stringify(simulation.value.err)}`)
      if (review.expiresAt <= Date.now()) throw Error('Platform fee review expired')
      const evidence = { ...current, networkFee: String(fee), genesis, maxNetworkFeeLamports: String(review.maxNetworkFeeLamports),
        temporaryAccounts: [temporary.publicKey.toBase58(), baseAccount.toBase58(), quoteAccount.toBase58()] }
      if (simulateOnly) return { ...current, networkFee: String(fee), temporaryDeposit: String(rent * 2),
        depositRefund: String(rent * 2), status: 'simulated', broadcast: false }
      const signature = bs58.encode(tx.signature), signedTransaction = tx.serialize().toString('base64')
      await db.query(`insert into platform_fee_claims (github_repo_id,pool,wallet,amount,status,signature,signed_transaction,last_valid_block_height,phase,evidence)
        values($1,$2,$3,$4,'pending',$5,$6,$7,'DBC',$8)`, [current.repoId, current.pool, current.receiver, current.available,
        signature, signedTransaction, latest.lastValidBlockHeight, JSON.stringify(evidence)])
      const intent = { signature, signedTransaction, wallet: current.receiver, amount: current.available, pool: current.pool, phase: 'DBC', evidence: JSON.stringify(evidence) }
      // Use the same bank commitment as the fresh blockhash; settlement remains finalized.
      await broadcastUntilSettled(connection, tx.serialize(), { signature, lastValidBlockHeight: latest.lastValidBlockHeight })
      await connection.confirmTransaction({ signature, ...latest }, 'finalized')
      const receipt = await settleDbcPlatformClaim(db, connection, intent)
      if (!receipt) throw Error('Platform collection submitted; final receipt is pending')
      return receipt
    })
  }
  return { status: repoId => withLock(repoId, db => inspect(db, repoId)), claim }
}

export async function settleDbcPlatformClaim(db, connection, intent) {
  const signed = Transaction.from(Buffer.from(intent.signedTransaction, 'base64'))
  if (!signed.verifySignatures() || bs58.encode(signed.signature) !== intent.signature) throw Error('Stored platform collection signature mismatch')
  const evidence = JSON.parse(intent.evidence)
  if (evidence.phase !== 'DBC' || evidence.receiver !== intent.wallet || evidence.pool !== intent.pool || evidence.available !== String(intent.amount)) throw Error('Stored platform collection terms mismatch')
  const tx = await connection.getTransaction(intent.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  if (!tx?.meta) return null
  if (tx.meta.err) throw Error('Platform collection finalized with an error')
  if (tx.transaction.signatures[0] !== intent.signature || !tx.transaction.message.serialize().equals(signed.serializeMessage())) throw Error('Platform collection receipt does not match signed intent')
  const keys = tx.transaction.message.accountKeys
  const index = address => keys.findIndex(k => k.toBase58() === address)
  const delta = address => { const i = index(address); if (i < 0) throw Error('Receipt account missing'); return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]) }
  const fee = BigInt(tx.meta.fee), amount = BigInt(intent.amount), sameWallet = intent.wallet === evidence.source
  if (String(fee) !== evidence.networkFee || delta(intent.wallet) !== amount - (sameWallet ? fee : 0n) ||
    (!sameWallet && delta(evidence.source) !== -fee)) throw Error('Exact treasury or signer SOL delta mismatch')
  for (const address of evidence.temporaryAccounts) {
    const i = index(address)
    if (i < 0 || tx.meta.preBalances[i] !== 0 || tx.meta.postBalances[i] !== 0) throw Error('Temporary claim account or rent refund mismatch')
  }
  const tokenBalance = side => {
    const value = tx.meta[side].find(b => b.accountIndex === index(evidence.quoteVault) && b.mint === NATIVE_MINT.toBase58())
    if (!value) throw Error('Claim quote vault token evidence missing')
    return BigInt(value.uiTokenAmount.amount)
  }
  if (tokenBalance('preTokenBalances') - tokenBalance('postTokenBalances') !== amount) throw Error('Quote vault debit differs from collected fee')
  const coder = new DynamicBondingCurveClient(connection, 'finalized').state.getProgram().coder.events
  const events = []
  for (const group of tx.meta.innerInstructions ?? []) {
    if (!keys[tx.transaction.message.instructions[group.index]?.programIdIndex]?.equals(PROGRAM)) continue
    for (const ix of group.instructions) {
      if (!keys[ix.programIdIndex]?.equals(PROGRAM)) continue
      const data = Buffer.from(bs58.decode(ix.data))
      if (!data.subarray(0, 8).equals(EVENT_PREFIX)) continue
      const event = coder.decode(data.subarray(8).toString('base64'))
      if (event?.name === 'evtClaimTradingFee' && event.data.pool.toBase58() === intent.pool) events.push(event.data)
    }
  }
  if (events.length !== 1 || events[0].tokenBaseAmount.toString() !== '0' || events[0].tokenQuoteAmount.toString() !== intent.amount) throw Error('Canonical partner fee event mismatch')
  const receipt = { phase: 'DBC', signature: intent.signature, wallet: intent.wallet, amount: intent.amount,
    networkFee: String(fee), slot: tx.slot, reconciliation: 'MATCH', status: 'settled' }
  await db.query(`update platform_fee_claims set status='settled',settled_at=now(),receipt=$2 where signature=$1 and phase='DBC' and status='pending'`, [intent.signature, JSON.stringify(receipt)])
  return receipt
}

export async function recoverDbcPlatformClaim(pool, connection, candidate) {
  const db = await pool.connect()
  try {
    const { rows: [lock] } = await db.query('select pg_try_advisory_lock($1::bigint) as locked', [candidate.repoId])
    if (!lock.locked) return { repoId: candidate.repoId, status: 'pending' }
    try {
      const { rows: [intent] } = await db.query(`select signature,signed_transaction as "signedTransaction",wallet,amount::text,pool,phase,evidence,
        last_valid_block_height::text as expiry from platform_fee_claims where signature=$1 and phase='DBC' and status='pending'`, [candidate.signature])
      if (!intent) {
        const { rows: [finished] } = await db.query('select status from platform_fee_claims where signature=$1', [candidate.signature])
        return { repoId: candidate.repoId, status: finished?.status ?? 'unknown' }
      }
      const chainTx = await connection.getTransaction(intent.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
      if (chainTx?.meta?.err) {
        await db.query("update platform_fee_claims set status='aborted',resolved_at=now(),resolution_reason='Finalized transaction failed' where signature=$1 and status='pending'", [intent.signature])
        return { repoId: candidate.repoId, signature: intent.signature, status: 'aborted' }
      }
      let receipt = await settleDbcPlatformClaim(db, connection, intent)
      if (!receipt) {
        const status = (await connection.getSignatureStatuses([intent.signature], { searchTransactionHistory: true })).value[0]
        if (!status && BigInt(await connection.getBlockHeight('finalized')) > BigInt(intent.expiry)) {
          receipt = await settleDbcPlatformClaim(db, connection, intent)
          if (!receipt && !(await connection.getSignatureStatuses([intent.signature], { searchTransactionHistory: true })).value[0]) {
            await db.query("update platform_fee_claims set status='aborted',resolved_at=now(),resolution_reason='Signed collection expired without chain evidence' where signature=$1 and status='pending'", [intent.signature])
            return { repoId: candidate.repoId, signature: intent.signature, status: 'aborted' }
          }
        } else if (!status) await connection.sendRawTransaction(Buffer.from(intent.signedTransaction, 'base64'), { skipPreflight: false, preflightCommitment: 'confirmed' })
      }
      return { repoId: candidate.repoId, signature: intent.signature, status: receipt?.status || 'pending' }
    } finally { await db.query('select pg_advisory_unlock($1::bigint)', [candidate.repoId]) }
  } finally { db.release() }
}
