import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { ACCOUNT_SIZE, NATIVE_MINT, createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { createMarketConfigResolver } from './market-config.mjs'
import { broadcastUntilSettled, isDustPayout, maxPayoutNetworkFee, signedWithPriorityFee } from './trade-landing.mjs'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'

const PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const EVENT_PREFIX = Buffer.from('e445a52e51cb9a1d', 'hex')
const PURPOSE = 'builder-fee-collection-v1'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const local = c => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(c.rpcEndpoint)
export const MAX_COLLECTION_NETWORK_FEE_LAMPORTS = maxPayoutNetworkFee(2)

// A collection is a separate debit, never an owner payout or partner-revenue allocation.
export function createBuilderFeeCollections({ pool, connection, verification = null, config, creator = null, env = process.env }) {
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const resolve = createMarketConfigResolver(config)
  const peers = () => [connection, ...(verification ? [verification] : [])]
  async function network() {
    if (!local(connection) && !verification) throw Error('Independent RPC verification required')
    const values = await Promise.all(peers().map(c => c.getGenesisHash()))
    if (values.some(v => v !== values[0])) throw Error('RPC network disagreement')
    if (!local(connection) && values[0] !== MAINNET) throw Error('Collection requires Solana mainnet')
    return values[0]
  }
  async function lock(repoId, fn) {
    if (!/^[1-9]\d*$/.test(String(repoId))) throw Error('Invalid repository')
    const db = await pool.connect()
    try {
      await db.query('select pg_advisory_lock($1::bigint)', [String(repoId)])
      try { return await fn(db) } finally { await db.query('select pg_advisory_unlock($1::bigint)', [String(repoId)]) }
    } finally { db.release() }
  }
  async function inspect(db, repoId, receiver, exactAmount) {
    if (!creator) throw Error('Protected creator signer required')
    const genesis = await network()
    const { rows: [m] } = await db.query(`select github_repo_id::text as "repoId", mint, pool, creator_wallet as "creatorWallet",
      quote_mint as "quoteMint",quote_asset_id as "quoteAssetId",bundle_id as "bundleId",early_access_end as "earlyAccessEnd",transfer_hook_program as "transferHookProgram"
      from markets where github_repo_id=$1 and status='confirmed' and indexed_at is not null and launch_finality='finalized'`, [String(repoId)])
    if (!m) throw Error('Repository has no finalized indexed canonical market')
    const configKey = resolve(m), keys = [new PublicKey(m.pool), configKey]
    const reads = await Promise.all(peers().map(c => c.getMultipleAccountsInfoAndContext(keys, 'finalized')))
    for (const r of reads) for (const a of r.value) if (!a?.owner.equals(PROGRAM)) throw Error('Invalid canonical DBC account')
    if (reads.slice(1).some(r => r.value.some((a, i) => !a.data.equals(reads[0].value[i].data)))) throw Error('RPC disagreement; refresh review')
    const s = dbc.state.getProgram().coder.accounts.decode('virtualPool', reads[0].value[0].data).poolState
    const fixed = dbc.state.getProgram().coder.accounts.decode('poolConfig', reads[0].value[1].data)
    if (!s.config.equals(configKey) || s.baseMint.toBase58() !== m.mint || s.creator.toBase58() !== m.creatorWallet ||
        !s.creator.equals(creator.publicKey) || !fixed.quoteMint.equals(NATIVE_MINT) || fixed.collectFeeMode !== 0 ||
        fixed.tokenType !== 0 || fixed.creatorTradingFeePercentage <= 0 || !s.creatorBaseFee.isZero()) throw Error('Canonical creator or SOL fee config mismatch')
    const to = new PublicKey(receiver)
    if (to.equals(creator.publicKey) || !PublicKey.isOnCurve(to)) throw Error('Receiver must be a separate normal SOL wallet')
    const account = await connection.getAccountInfo(to, 'finalized')
    if (account && (account.executable || !account.owner.equals(SystemProgram.programId))) throw Error('Receiver must be a normal SOL wallet')
    // Graduation leaves DBC fees claimable. DAMM position fees are a separate,
    // all-or-nothing claim and must never fund this exact DBC withdrawal.
    // Only this service's own DBC collections reduce the DBC balance: an operator payout recorded in the same ledger
    // under another purpose (for example a DAMM position-fee payout) never took DBC fees. The on-chain equality below
    // still has to hold, so a payout that did take DBC fees keeps the review refused.
    const { rows: [totals] } = await db.query(`select
      coalesce((select sum(amount_base_units) from fee_events where github_repo_id=$1),0)::text as earned,
      coalesce((select sum(amount_base_units - damm_amount_base_units) from repo_claims where github_repo_id=$1 and status='settled'),0)::text as "ownerPaid",
      coalesce((select sum(amount) from builder_fee_collections where github_repo_id=$1 and status='settled' and (terms::jsonb->>'purpose')=$2),0)::text as "platformCollected",
      (select count(*) from repo_claims where github_repo_id=$1 and status='pending')::int +
      (select count(*) from platform_fee_claims where github_repo_id=$1 and status='pending')::int +
      (select count(*) from discovery_claims where github_repo_id=$1 and status='pending')::int +
      (select count(*) from builder_fee_collections where github_repo_id=$1 and status='pending')::int as pending`, [String(repoId), PURPOSE])
    if (totals.pending) throw Error('A conflicting payout is pending; resolve it before collection')
    const unclaimed = BigInt(totals.earned) - BigInt(totals.ownerPaid) - BigInt(totals.platformCollected)
    if (unclaimed < 0n || unclaimed !== BigInt(s.creatorQuoteFee.toString())) throw Error('Builder fees need indexing or reconciliation before collection')
    if (exactAmount !== undefined && !/^[1-9][0-9]*$/.test(String(exactAmount))) throw Error('Exact collection amount must be positive integer lamports')
    const amount = exactAmount === undefined ? unclaimed / 2n : BigInt(exactAmount)
    if (amount <= 0n) throw Error('No economical builder fees remain')
    if (amount > unclaimed) throw Error('Exact collection amount exceeds unclaimed builder fees')
    return { purpose: PURPOSE, repoId: String(repoId), mint: m.mint, pool: m.pool, config: configKey.toBase58(),
      source: creator.publicKey.toBase58(), receiver: to.toBase58(), feeSource: 'DBC', earned: totals.earned, ownerPaid: totals.ownerPaid,
      platformCollected: totals.platformCollected, unclaimed: String(unclaimed), amount: String(amount), remaining: String(unclaimed - amount),
      creatorUnclaimed: s.creatorQuoteFee.toString(), partnerUnclaimed: s.partnerQuoteFee.toString(), quoteVault: s.quoteVault.toBase58(),
      ...(exactAmount === undefined ? {} : { selection: 'exact' }),
      genesis, maxNetworkFeeLamports: String(MAX_COLLECTION_NETWORK_FEE_LAMPORTS) }
  }
  function termsFor(row) {
    const t = JSON.parse(row.terms)
    if (digest(t) !== row.terms_hash || t.purpose !== PURPOSE || t.repoId !== String(row.github_repo_id) ||
        t.mint !== row.mint || t.pool !== row.pool || t.receiver !== row.wallet || t.amount !== String(row.amount) ||
        t.expiresAt !== new Date(row.expires_at).getTime() ||
        (t.selection === undefined ? BigInt(t.amount) !== BigInt(t.unclaimed) / 2n
          : t.selection !== 'exact' || BigInt(t.amount) <= 0n || BigInt(t.amount) > BigInt(t.unclaimed)) ||
        BigInt(t.remaining) !== BigInt(t.unclaimed) - BigInt(t.amount)) throw Error('Stored collection terms mismatch')
    return t
  }
  function publicRow(row) {
    return { id: row.id, status: row.status, terms: termsFor(row), termsHash: row.terms_hash,
      expiresAt: new Date(row.expires_at).getTime(), signature: row.signature, receipt: row.receipt ? JSON.parse(row.receipt) : null }
  }
  async function review({ repoId, receiver = BUYBACK_WALLETS.custody, amount }) {
    return lock(repoId, async db => {
      const terms = { ...await inspect(db, repoId, receiver, amount), expiresAt: Date.now() + 10 * 60_000 }
      const { rows: [row] } = await db.query(`insert into builder_fee_collections
        (id,github_repo_id,mint,pool,wallet,amount,status,terms,terms_hash,expires_at)
        values($1,$2,$3,$4,$5,$6,'reviewed',$7,$8,$9) returning *`,
      [randomUUID(), terms.repoId, terms.mint, terms.pool, terms.receiver, terms.amount, JSON.stringify(terms), digest(terms), new Date(terms.expiresAt)])
      return publicRow(row)
    })
  }
  async function settle(db, row) {
    const terms = termsFor(row)
    if (await network() !== terms.genesis) throw Error('Recovery network mismatch')
    const signed = Transaction.from(Buffer.from(row.signed_transaction, 'base64'))
    if (!signed.verifySignatures() || bs58.encode(signed.signature) !== row.signature || signed.feePayer.toBase58() !== terms.source) throw Error('Stored signed collection mismatch')
    const txs = await Promise.all(peers().map(c => c.getTransaction(row.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })))
    if (txs.some(t => !t?.meta)) return null
    const tx = txs[0]
    if (txs.some(t => t.slot !== tx.slot || !isDeepStrictEqual(t.meta.err, tx.meta.err) ||
        !t.transaction.message.serialize().equals(tx.transaction.message.serialize()) ||
        !isDeepStrictEqual(t.meta.preBalances, tx.meta.preBalances) || !isDeepStrictEqual(t.meta.postBalances, tx.meta.postBalances) ||
        !isDeepStrictEqual(t.meta.preTokenBalances, tx.meta.preTokenBalances) || !isDeepStrictEqual(t.meta.postTokenBalances, tx.meta.postTokenBalances) ||
        !isDeepStrictEqual(t.meta.innerInstructions, tx.meta.innerInstructions) || t.meta.fee !== tx.meta.fee)) throw Error('Independent finalized receipt disagreement')
    if (!tx.transaction.message.serialize().equals(signed.serializeMessage()) || tx.transaction.signatures[0] !== row.signature) throw Error('Finalized message differs from signed intent')
    if (tx.meta.err) {
      await db.query("update builder_fee_collections set status='aborted',resolved_at=now(),resolution_reason='Finalized transaction failed' where id=$1 and status='pending'", [row.id])
      return { status: 'aborted', signature: row.signature }
    }
    const keys = tx.transaction.message.accountKeys
    const index = address => keys.findIndex(k => k.toBase58() === address)
    const delta = address => { const i = index(address); if (i < 0) throw Error('Receipt account missing'); return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]) }
    const fee = BigInt(tx.meta.fee), amount = BigInt(terms.amount)
    if (fee > BigInt(terms.maxNetworkFeeLamports) || delta(terms.receiver) !== amount || delta(terms.source) !== -fee) throw Error('Exact receiver or payer delta mismatch')
    const temporary = signed.signatures.find(s => s.publicKey.toBase58() !== terms.source)?.publicKey
    if (!temporary || signed.signatures.length !== 2) throw Error('Temporary authority mismatch')
    for (const key of [temporary, getAssociatedTokenAddressSync(new PublicKey(terms.mint), temporary), getAssociatedTokenAddressSync(NATIVE_MINT, temporary)]) {
      const i = index(key.toBase58())
      if (i < 0 || tx.meta.preBalances[i] !== 0 || tx.meta.postBalances[i] !== 0) throw Error('Temporary accounts or rent refund mismatch')
    }
    const token = side => {
      const b = tx.meta[side]?.find(b => b.accountIndex === index(terms.quoteVault) && b.mint === NATIVE_MINT.toBase58())
      if (!b) throw Error('Quote vault evidence missing')
      return BigInt(b.uiTokenAmount.amount)
    }
    if (token('preTokenBalances') - token('postTokenBalances') !== amount) throw Error('Quote vault debit mismatch')
    const events = []
    for (const group of tx.meta.innerInstructions ?? []) for (const ix of group.instructions) {
      if (!keys[ix.programIdIndex]?.equals(PROGRAM)) continue
      const bytes = Buffer.from(bs58.decode(ix.data))
      if (!bytes.subarray(0, 8).equals(EVENT_PREFIX)) continue
      const event = dbc.state.getProgram().coder.events.decode(bytes.subarray(8).toString('base64'))
      if (event?.name === 'evtClaimCreatorTradingFee') events.push(event.data)
    }
    if (events.length !== 1 || events[0].pool.toBase58() !== terms.pool || events[0].tokenBaseAmount.toString() !== '0' || events[0].tokenQuoteAmount.toString() !== terms.amount) throw Error('Canonical creator fee event mismatch')
    const receipt = { status: 'settled', signature: row.signature, amount: terms.amount, remaining: terms.remaining,
      receiver: terms.receiver, networkFee: String(fee), slot: tx.slot, reconciliation: 'MATCH' }
    await db.query("update builder_fee_collections set status='settled',settled_at=now(),receipt=$2 where id=$1 and status='pending'", [row.id, JSON.stringify(receipt)])
    return receipt
  }
  async function claim({ reviewId, termsHash, simulateOnly = false }) {
    if (env.BUILDER_FEE_COLLECTION_ENABLED !== 'true') throw Error('Builder fee collection is disabled')
    const { rows: [initial] } = await pool.query('select * from builder_fee_collections where id=$1', [reviewId])
    if (!initial) throw Error('Collection review not found')
    return lock(initial.github_repo_id, async db => {
      const { rows: [row] } = await db.query('select * from builder_fee_collections where id=$1', [reviewId])
      if (row.status !== 'reviewed') throw Error('Review already consumed; inspect its receipt')
      const terms = termsFor(row)
      if (termsHash !== row.terms_hash || terms.expiresAt <= Date.now()) throw Error('Collection review changed or expired')
      const current = { ...await inspect(db, terms.repoId, terms.receiver, terms.selection === 'exact' ? terms.amount : undefined), expiresAt: terms.expiresAt }
      if (digest(current) !== row.terms_hash) throw Error('Collection terms changed; refresh and review again')
      const temporary = Keypair.generate()
      const tx = await dbc.creator.claimCreatorTradingFee({ creator: creator.publicKey, payer: creator.publicKey,
        pool: new PublicKey(terms.pool), receiver: temporary.publicKey, tempWSolAcc: temporary.publicKey,
        maxBaseAmount: new BN(0), maxQuoteAmount: new BN(terms.amount) })
      const rent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)
      tx.add(SystemProgram.transfer({ fromPubkey: temporary.publicKey, toPubkey: new PublicKey(terms.receiver), lamports: BigInt(terms.amount) }),
        SystemProgram.transfer({ fromPubkey: temporary.publicKey, toPubkey: creator.publicKey, lamports: rent }),
        createCloseAccountInstruction(getAssociatedTokenAddressSync(new PublicKey(terms.mint), temporary.publicKey), creator.publicKey, temporary.publicKey))
      const latest = await connection.getLatestBlockhash('confirmed')
      const { transaction } = await signedWithPriorityFee(connection, tx, { feePayer: creator.publicKey, blockhash: latest.blockhash, signers: [creator, temporary] })
      const fee = (await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value
      if (fee == null || BigInt(fee) > BigInt(terms.maxNetworkFeeLamports) || isDustPayout(BigInt(terms.amount), fee)) throw Error('Collection does not cover its reviewed network cost')
      if (await connection.getBalance(creator.publicKey, 'confirmed') < rent * 2 + fee) throw Error('Creator signer needs operating SOL')
      const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(transaction.serialize()), { sigVerify: true, commitment: 'confirmed' })
      if (simulation.value.err) throw Error(`Collection simulation failed: ${JSON.stringify(simulation.value.err)}`)
      if (terms.expiresAt <= Date.now()) throw Error('Collection review expired')
      if (simulateOnly) return { status: 'simulated', broadcast: false, amount: terms.amount, remaining: terms.remaining, receiver: terms.receiver, networkFee: String(fee), temporaryDeposit: String(rent * 2), depositRefund: String(rent * 2) }
      const signature = bs58.encode(transaction.signature)
      const { rows: [intent] } = await db.query(`update builder_fee_collections set status='pending',signature=$2,signed_transaction=$3,last_valid_block_height=$4
        where id=$1 and status='reviewed' returning *`, [row.id, signature, transaction.serialize().toString('base64'), latest.lastValidBlockHeight])
      if (!intent) throw Error('Review already consumed')
      await broadcastUntilSettled(connection, transaction.serialize(), { signature, lastValidBlockHeight: latest.lastValidBlockHeight })
      await connection.confirmTransaction({ signature, ...latest }, 'finalized')
      const receipt = await settle(db, intent)
      if (!receipt) throw Error(`Collection ${signature} submitted; independent final receipt is pending`)
      return receipt
    })
  }
  async function receipt(id) {
    const { rows: [row] } = await pool.query('select * from builder_fee_collections where id=$1', [id])
    if (!row) throw Error('Collection not found')
    return publicRow(row)
  }
  async function recover() {
    const { rows } = await pool.query("select id,github_repo_id::text as repo from builder_fee_collections where status='pending'")
    const results = []
    for (const entry of rows) {
      try {
        results.push(await lock(entry.repo, async db => {
          const { rows: [row] } = await db.query('select * from builder_fee_collections where id=$1', [entry.id])
          if (row.status !== 'pending') return { id: row.id, status: row.status }
          let proof = await settle(db, row)
          if (proof) return { id: row.id, ...proof }
          const statuses = await Promise.all(peers().map(c => c.getSignatureStatuses([row.signature], { searchTransactionHistory: true }).then(r => r.value[0])))
          if (statuses.some(Boolean)) return { id: row.id, status: 'pending', signature: row.signature }
          if ((await Promise.all(peers().map(c => provablyExpiredUnlanded(c, row.signature, row.last_valid_block_height)))).every(Boolean)) {
            proof = await settle(db, row)
            if (proof) return { id: row.id, ...proof }
            await db.query("update builder_fee_collections set status='aborted',resolved_at=now(),resolution_reason='Expired without independent chain evidence' where id=$1 and status='pending'", [row.id])
            return { id: row.id, status: 'aborted', signature: row.signature }
          }
          await connection.sendRawTransaction(Buffer.from(row.signed_transaction, 'base64'), { skipPreflight: false, preflightCommitment: 'confirmed' })
          return { id: row.id, status: 'pending', signature: row.signature }
        }))
      } catch (error) { results.push({ id: entry.id, status: 'review', error: error.message }) }
    }
    return results
  }
  return { review, claim, receipt, recover }
}
