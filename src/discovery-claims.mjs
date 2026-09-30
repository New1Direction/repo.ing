import { createHmac, randomUUID } from 'node:crypto'
import { createMarketConfigResolver } from './market-config.mjs'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { ACCOUNT_SIZE, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { CollectFeeMode, DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { discoverySummary } from './discovery-rewards.mjs'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'
import { matchesReviewedTransaction } from './launch-wallet-assertions.mjs'

const PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const EVENT_PREFIX = Buffer.from('e445a52e51cb9a1d', 'hex')
export class DiscoveryClaimError extends Error {}
const fail = message => { throw new DiscoveryClaimError(message) }
const decode = value => Transaction.from(Buffer.from(value, 'base64'))
const unsigned = tx => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')

// The recipient pays and signs FIRST: wallets (Phantom) block transactions that arrive already
// partially signed, and cannot append their Lighthouse safety assertions to them. The temporary
// WSOL authority and the partner sign only after wallet verification, and the fully signed intent
// is committed BEFORE any broadcast.
export function createDiscoveryClaims({ pool, connection, config, partner = null }) {
  // Derived per claim, so the offer can be sent unsigned and signed later without storing a key.
  // It only authorises this claim's temporary WSOL account; nothing moves without the partner.
  const temporaryAuthority = id => Keypair.fromSeed(createHmac('sha256', Buffer.from(partner.secretKey))
    .update(`repo.ing discovery temporary WSOL v1:${id}`).digest())
  const resolveConfig = createMarketConfigResolver(config)
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const withLock = async (repoId, callback) => {
    if (!/^\d+$/.test(String(repoId)) || BigInt(repoId) <= 0n) fail('Valid repository ID required')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [String(repoId)])
      try { return await callback(client) }
      finally { await client.query('select pg_advisory_unlock($1::bigint)', [String(repoId)]) }
    } finally { client.release() }
  }
  const activeClaim = async (db, repoId) => (await db.query(`select * from discovery_claims
    where github_repo_id = $1 and status in ('prepared','pending') limit 1`, [String(repoId)])).rows[0]
  const abort = async (db, claim, reason) => {
    await db.query(`update discovery_claims set status = 'aborted', resolution_reason = $2 where id = $1`, [claim.id, reason])
    return { id: claim.id, status: 'aborted', signature: claim.signature, reason }
  }

  async function settle(db, claim, market) {
    if (claim.status === 'prepared') {
      if (await connection.getBlockHeight('finalized') > Number(claim.last_valid_block_height)) {
        return abort(db, claim, 'Unsigned wallet offer expired')
      }
      return { id: claim.id, status: 'prepared' }
    }
    const signed = decode(claim.transaction)
    if (!signed.verifySignatures() || bs58.encode(signed.signature) !== claim.signature) {
      fail('Stored discovery transaction requires settlement review')
    }
    const chainTx = await connection.getTransaction(claim.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (chainTx?.meta) {
      if (chainTx.transaction.signatures[0] !== claim.signature ||
          !chainTx.transaction.message.serialize().equals(signed.serializeMessage())) {
        fail('Finalized discovery transaction does not match the saved payout')
      }
      if (chainTx.meta.err) return abort(db, claim, 'Transaction finalized with an error; no reward paid')
      const keys = chainTx.transaction.message.accountKeys
      const events = []
      for (const group of chainTx.meta.innerInstructions ?? []) {
        const outer = chainTx.transaction.message.instructions[group.index]
        if (!keys[outer?.programIdIndex]?.equals(PROGRAM)) continue
        for (const ix of group.instructions) {
          if (!keys[ix.programIdIndex]?.equals(PROGRAM)) continue
          const bytes = Buffer.from(bs58.decode(ix.data))
          if (!bytes.subarray(0, 8).equals(EVENT_PREFIX)) continue
          const event = dbc.state.getProgram().coder.events.decode(bytes.subarray(8).toString('base64'))
          if (event?.name === 'evtClaimTradingFee' && event.data.pool.equals(new PublicKey(market.pool))) events.push(event.data)
        }
      }
      // Event proof is transaction-local. Comparing pool balances before/after
      // would break when another user's swap lands during confirmation.
      if (events.length !== 1 || events[0].tokenBaseAmount.toString() !== '0' ||
          events[0].tokenQuoteAmount.toString() !== claim.amount) {
        fail('Discovery payout receipt needs settlement review')
      }
      await db.query(`update discovery_claims set status = 'settled', settled_at = now() where id = $1`, [claim.id])
      return { id: claim.id, status: 'settled', signature: claim.signature, amount: claim.amount }
    }
    const status = (await connection.getSignatureStatuses([claim.signature], { searchTransactionHistory: true })).value[0]
    // A processed/confirmed result is still ambiguous, even after blockhash
    // expiry. Never replace it until finalized transaction evidence is available.
    if (!status && await provablyExpiredUnlanded(connection, claim.signature, claim.last_valid_block_height)) {
      return abort(db, claim, 'Blockhash expired with no transaction in finalized history')
    }
    return { id: claim.id, status: 'pending', signature: claim.signature, amount: claim.amount }
  }

  async function requireMarket(db, repoId) {
    const market = await discoverySummary(db, repoId)
    if (!market) fail('This market is not enrolled in discovery rewards')
    const configKey = resolveConfig(market)
    if (!deriveDbcPoolAddress(NATIVE_MINT, new PublicKey(market.mint), configKey).equals(new PublicKey(market.pool))) {
      fail('Discovery market does not match the canonical DBC config')
    }
    return market
  }
  const offer = claim => ({ id: claim.id, status: claim.status, amount: claim.amount,
    signature: claim.signature, ...(claim.status === 'prepared' ? { transaction: claim.transaction } : {}) })

  async function costs(transaction, market) {
    const receiver = new PublicKey(market.wallet)
    const baseAccount = getAssociatedTokenAddressSync(new PublicKey(market.mint), receiver)
    const [fee, baseInfo, balance, rent] = await Promise.all([
      connection.getFeeForMessage(transaction.compileMessage(), 'confirmed'),
      connection.getAccountInfo(baseAccount, 'confirmed'), connection.getBalance(receiver, 'confirmed'),
      connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
    ])
    if (fee.value === null) fail('Solana network fee is unavailable; retry shortly')
    if (balance < fee.value + rent + (baseInfo ? 0 : rent)) {
      fail('Your wallet needs SOL for the network fee and temporary account deposit before claiming')
    }
    return { networkFee: String(fee.value), accountSetupFee: String(baseInfo ? 0 : rent) }
  }

  async function prepare({ repoId, wallet }) {
    if (!partner) fail('Discovery payouts are temporarily unavailable. Your rewards remain accrued.')
    return withLock(repoId, async db => {
      let market = await requireMarket(db, repoId)
      if (wallet !== market.wallet) fail('Connect the wallet that launched this repository to claim its discovery rewards')
      const active = await activeClaim(db, repoId)
      if (active) {
        const result = await settle(db, active, market)
        if (result.status === 'prepared') return { ...offer(active), ...await costs(decode(active.transaction), market) }
        if (result.status === 'pending') return result
        market = await requireMarket(db, repoId)
      }
      const amount = BigInt(market.remaining)
      if (amount <= 0n) fail('No discovery rewards are available to claim yet')
      const state = await dbc.state.getPool(market.pool)
      const configKey = resolveConfig(market)
      const fixed = await dbc.state.getPoolConfig(configKey)
      if (!state || !fixed || !state.poolState.config.equals(configKey) ||
          !state.poolState.baseMint.equals(new PublicKey(market.mint)) ||
          !state.poolState.creator.equals(new PublicKey(market.creatorWallet)) ||
          !fixed.feeClaimer.equals(partner.publicKey) || !fixed.quoteMint.equals(NATIVE_MINT) ||
          fixed.collectFeeMode !== CollectFeeMode.QuoteToken) fail('Canonical partner fee authority needs review')
      if (BigInt(state.poolState.partnerQuoteFee.toString()) < amount) {
        fail('Partner fees need reconciliation before this reward can be paid. Your recorded reward is preserved.')
      }
      const receiver = new PublicKey(market.wallet)
      if (receiver.equals(partner.publicKey)) fail('The platform fee authority cannot claim discovery rewards')
      // A unique temporary authority avoids closing either party's existing WSOL account.
      const id = randomUUID()
      const temporary = temporaryAuthority(id)
      const transaction = await dbc.partner.claimPartnerTradingFee({ feeClaimer: partner.publicKey,
        payer: receiver, receiver, tempWSolAcc: temporary.publicKey, pool: new PublicKey(market.pool),
        maxBaseAmount: new BN(0), maxQuoteAmount: new BN(amount.toString()) })
      const latest = await connection.getLatestBlockhash('confirmed')
      transaction.feePayer = receiver
      transaction.recentBlockhash = latest.blockhash
      transaction.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from([
        'repo.ing discovery reward v1', `Chain: Solana ${await connection.getGenesisHash()}`,
        `Repository ID: ${repoId}`, `Wallet: ${market.wallet}`, `Claim: ${id}`,
        `Reward lamports: ${amount}`, `Expires at block height: ${latest.lastValidBlockHeight}`,
      ].join('\n')) }))
      const estimate = await costs(transaction, market)
      const { rows } = await db.query(`insert into discovery_claims
        (id, github_repo_id, wallet, amount, status, transaction, last_valid_block_height)
        values ($1,$2,$3,$4,'prepared',$5,$6) returning *`,
      [id, String(repoId), market.wallet, amount.toString(), unsigned(transaction), String(latest.lastValidBlockHeight)])
      return { ...offer(rows[0]), ...estimate }
    })
  }

  async function submit({ repoId, id, transaction: encoded }) {
    if (!partner) fail('Discovery payouts are temporarily unavailable')
    if (typeof encoded !== 'string' || encoded.length > 4096) fail('Invalid discovery claim transaction')
    return withLock(repoId, async db => {
      const market = await requireMarket(db, repoId)
      const claim = (await db.query('select * from discovery_claims where id = $1 and github_repo_id = $2',
        [id, String(repoId)])).rows[0]
      if (!claim) fail('Discovery claim was not found')
      if (claim.status === 'settled') return offer(claim)
      if (claim.status === 'aborted') fail('This claim expired or failed. Prepare a new claim.')
      if (claim.status === 'pending') return settle(db, claim, market)
      const transaction = decode(encoded)
      const original = decode(claim.transaction)
      const userSignature = transaction.signatures.find(item => item.publicKey.toBase58() === market.wallet)?.signature
      // The saved offer exactly, or it plus constrained, trailing Lighthouse assertions from the wallet.
      if (!userSignature || !transaction.verifySignatures(false) ||
          !matchesReviewedTransaction(Buffer.from(original.serializeMessage()), transaction) || claim.wallet !== market.wallet) {
        fail('Wallet signature or discovery payout transaction does not match the saved offer')
      }
      if (await connection.getBlockHeight('confirmed') > Number(claim.last_valid_block_height)) {
        await abort(db, claim, 'Unsigned wallet offer expired')
        fail('Wallet approval expired; prepare the claim again')
      }
      // Offers prepared before this change arrive with the temporary signature already present.
      const temporary = temporaryAuthority(claim.id)
      if (transaction.signatures.some(item => item.publicKey.equals(temporary.publicKey) && !item.signature)) {
        transaction.partialSign(temporary)
      }
      transaction.partialSign(partner)
      if (!transaction.verifySignatures()) fail('Discovery claim signatures are incomplete or invalid')
      const signature = bs58.encode(transaction.signature)
      const raw = transaction.serialize()
      const simulation = await connection.simulateTransaction(transaction)
      if (simulation.value.err) fail('The claim could not be simulated. Check your SOL balance and retry.')
      await db.query(`update discovery_claims set status = 'pending', signature = $2, transaction = $3 where id = $1`,
        [claim.id, signature, raw.toString('base64')])
      // Network errors leave the durable intent pending. Recovery rebroadcasts
      // these exact bytes; it never constructs another payout for this amount.
      try { await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }) }
      catch { /* Worker and status polling resume this same signed transaction. */ }
      return { id: claim.id, status: 'pending', signature, amount: claim.amount }
    })
  }

  async function recover(repoId) {
    return withLock(repoId, async db => {
      const claim = await activeClaim(db, repoId)
      if (!claim) return null
      const market = await requireMarket(db, repoId)
      const result = await settle(db, claim, market)
      if (result.status === 'pending') {
        try { await connection.sendRawTransaction(Buffer.from(claim.transaction, 'base64'), { skipPreflight: false, maxRetries: 0 }) }
        catch { /* Retain pending status until finality or proven expiry. */ }
      }
      return result
    })
  }
  async function runOnce() {
    const { rows } = await pool.query(`select github_repo_id::text as "repoId" from discovery_claims where status in ('prepared','pending')`)
    const results = []
    for (const row of rows) {
      try { results.push({ repoId: row.repoId, ...await recover(row.repoId) }) }
      catch (error) {
        console.error('discovery recovery needs review', { repo: row.repoId, error: error.message })
        results.push({ repoId: row.repoId, status: 'review' })
      }
    }
    return results
  }
  return { prepare, submit, recover, runOnce }
}
