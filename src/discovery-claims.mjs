import { createHmac, randomUUID } from 'node:crypto'
import { createMarketConfigResolver } from './market-config.mjs'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { ACCOUNT_SIZE, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync, unpackMint } from '@solana/spl-token'
import { CollectFeeMode, DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { discoverySummary } from './discovery-rewards.mjs'
import { isEarlyAccessMarket } from './early-access.mjs'
import { assertHookClaimInstructions, hookClaimInstructions } from './dbc-hook-claims.mjs'
import { associatedAccountLength } from './trade-costs.mjs'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'
import { broadcastUntilSettled, isDustPayout, maxPayoutNetworkFee, signedWithPriorityFee } from './trade-landing.mjs'
import { DISCOVERY_CLAIM_MESSAGE_MS, MIN_DISCOVERY_CLAIM_LAMPORTS, discoveryClaimMessage, formatLamportsAsSol,
  isClaimId, verifyDiscoveryClaimSignature } from './discovery-claim-message.mjs'

const PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const EVENT_PREFIX = Buffer.from('e445a52e51cb9a1d', 'hex')
// Partner (fee payer) + temporary WSOL authority, plus the bounded priority fee.
export const DISCOVERY_MAX_NETWORK_FEE_LAMPORTS = maxPayoutNetworkFee(2)
// The first broadcast rebroadcasts for a short while inside the request; recovery (claim-status polling and the
// worker) keeps rebroadcasting the same bytes afterwards.
const SUBMIT_BROADCAST_MS = 12_000
export class DiscoveryClaimError extends Error {}
const fail = message => { throw new DiscoveryClaimError(message) }
const decode = value => Transaction.from(Buffer.from(value, 'base64'))
// Rows prepared before message authorization carry an unsigned wallet transaction and no message.
const isLegacy = claim => claim.auth_message === null || claim.auth_message === undefined

// Claims are authorized by the launcher wallet signing a plain-text message (see discovery-claim-message.mjs). The
// server then builds and signs the payout itself: the partner fee authority pays every fee and deposit, a per-claim
// temporary authority receives the claimed quote fee (so no account of the launcher's is created or closed), and
// exactly the claimed lamports are transferred to the launcher wallet in the same transaction. The fully signed
// payout is committed as 'pending' BEFORE any broadcast; recovery only ever rebroadcasts those bytes.
// earlyAccess (EARLY_ACCESS_DBC_CONFIG): a contributor early access market's reward is paid from its Token-2022 hook pool with
// claim_trading_fee2 (src/dbc-hook-claims.mjs, docs/EARLY_ACCESS.md step 6e); without it such a market is not enrolled here.
export function createDiscoveryClaims({ pool, connection, config, partner = null, now = Date.now,
  minClaimLamports = MIN_DISCOVERY_CLAIM_LAMPORTS, submitBroadcastMs = SUBMIT_BROADCAST_MS, earlyAccess = null }) {
  // Derived per claim so no key is stored. It only controls this claim's temporary accounts.
  const temporaryAuthority = id => Keypair.fromSeed(createHmac('sha256', Buffer.from(partner.secretKey))
    .update(`repo.ing discovery temporary WSOL v1:${id}`).digest())
  const resolveConfig = createMarketConfigResolver(config, undefined, undefined, { earlyAccess })
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
    await db.query(`update discovery_claims set status = 'aborted', resolution_reason = $2 where id = $1 and status = $3`,
      [claim.id, reason, claim.status])
    return { id: claim.id, status: 'aborted', signature: claim.signature, reason }
  }
  const messageExpired = claim => now() >= new Date(claim.auth_expires_at).getTime()

  // A message-authorized payout must pay the launcher from a server fee payer: the launcher wallet never signs,
  // and exactly one system transfer sends it exactly the claimed amount.
  function checkPayoutShape(signed, claim) {
    const payer = signed.feePayer
    const wallet = new PublicKey(claim.wallet)
    let transfers = []
    try {
      transfers = signed.instructions.filter(ix => ix.programId.equals(SystemProgram.programId) &&
        SystemInstruction.decodeInstructionType(ix) === 'Transfer').map(ix => SystemInstruction.decodeTransfer(ix))
        .filter(transfer => transfer.toPubkey.equals(wallet))
    } catch { transfers = [] }
    if (!payer || payer.equals(wallet) || (partner && !payer.equals(partner.publicKey)) ||
        signed.signatures.some(item => item.publicKey.equals(wallet)) ||
        transfers.length !== 1 || BigInt(transfers[0].lamports) !== BigInt(claim.amount)) {
      fail('Stored discovery payout does not match the authorized claim')
    }
    return payer
  }

  async function settle(db, claim, market) {
    if (claim.status === 'prepared') {
      if (isLegacy(claim)) {
        // An unsigned legacy wallet offer has no partner signature and can never land.
        if (await connection.getBlockHeight('finalized') > Number(claim.last_valid_block_height)) {
          return abort(db, claim, 'Unsigned wallet offer expired')
        }
      } else if (messageExpired(claim)) return abort(db, claim, 'Wallet confirmation expired')
      return { id: claim.id, status: 'prepared' }
    }
    const signed = decode(claim.transaction)
    if (!signed.verifySignatures() || bs58.encode(signed.signature) !== claim.signature) {
      fail('Stored discovery transaction requires settlement review')
    }
    const payer = isLegacy(claim) ? null : checkPayoutShape(signed, claim)
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
      if (payer) {
        // Server-paid payouts: the launcher gains exactly the reward; the fee payer spends exactly the network fee
        // (every temporary deposit is refunded inside the transaction).
        const delta = address => {
          const i = keys.findIndex(key => key.equals(address))
          if (i < 0) fail('Discovery payout receipt needs settlement review')
          return BigInt(chainTx.meta.postBalances[i]) - BigInt(chainTx.meta.preBalances[i])
        }
        if (delta(new PublicKey(claim.wallet)) !== BigInt(claim.amount) || delta(payer) !== -BigInt(chainTx.meta.fee)) {
          fail('Discovery payout receipt needs settlement review')
        }
      }
      await db.query(`update discovery_claims set status = 'settled', settled_at = now() where id = $1 and status = 'pending'`, [claim.id])
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
    const market = await discoverySummary(db, repoId, { earlyAccess: Boolean(earlyAccess) })
    if (!market) fail('This market is not enrolled in discovery rewards')
    const configKey = resolveConfig(market)
    if (!deriveDbcPoolAddress(NATIVE_MINT, new PublicKey(market.mint), configKey).equals(new PublicKey(market.pool))) {
      fail('Discovery market does not match the canonical DBC config')
    }
    return market
  }

  // The canonical pool must be able to pay `amount` from its partner quote fees, to the SOL quote side only.
  async function requirePartnerFees(market, amount) {
    const configKey = resolveConfig(market)
    const [state, fixed] = await Promise.all([dbc.state.getPool(market.pool), dbc.state.getPoolConfig(configKey)])
    if (!state || !fixed || !state.poolState.config.equals(configKey) ||
        !state.poolState.baseMint.equals(new PublicKey(market.mint)) ||
        !state.poolState.creator.equals(new PublicKey(market.creatorWallet)) ||
        !fixed.feeClaimer.equals(partner.publicKey) || !fixed.quoteMint.equals(NATIVE_MINT) ||
        fixed.collectFeeMode !== CollectFeeMode.QuoteToken || fixed.tokenType !== (isEarlyAccessMarket(market) ? 1 : 0)) fail('Canonical partner fee authority needs review')
    if (BigInt(state.poolState.partnerQuoteFee.toString()) < amount) {
      fail('Partner fees need reconciliation before this reward can be paid. Your recorded reward is preserved.')
    }
  }

  const offer = claim => claim.status === 'prepared'
    ? { id: claim.id, status: 'prepared', amount: String(claim.amount), message: claim.auth_message,
        expiresAt: new Date(claim.auth_expires_at).toISOString() }
    : { id: claim.id, status: claim.status, amount: String(claim.amount), signature: claim.signature }

  async function prepare({ repoId, wallet }) {
    if (!partner) fail('Discovery payouts are temporarily unavailable. Your rewards remain accrued.')
    return withLock(repoId, async db => {
      let market = await requireMarket(db, repoId)
      if (wallet !== market.wallet) fail('Connect the wallet that launched this repository to claim its discovery rewards')
      const active = await activeClaim(db, repoId)
      if (active) {
        const result = await settle(db, active, market)
        if (result.status === 'pending') return result
        if (result.status === 'prepared') {
          // Concurrent or repeated preparations reuse one unexpired message.
          if (!isLegacy(active)) return offer(active)
          await abort(db, active, 'Replaced by a message-confirmed claim')
        }
        market = await requireMarket(db, repoId)
      }
      const amount = BigInt(market.remaining)
      if (amount <= 0n) fail('No discovery rewards are available to claim yet')
      if (amount < BigInt(minClaimLamports)) {
        fail(`Reward too small to claim yet. At least ${formatLamportsAsSol(minClaimLamports)} SOL must accrue first.`)
      }
      if (new PublicKey(market.wallet).equals(partner.publicKey)) fail('The platform fee authority cannot claim discovery rewards')
      await requirePartnerFees(market, amount)
      const { rows: [repository] } = await db.query('select full_name from repositories where github_repo_id = $1', [String(repoId)])
      if (!repository) fail('Repository record is missing')
      const id = randomUUID()
      const expiresAt = new Date(now() + DISCOVERY_CLAIM_MESSAGE_MS)
      const message = discoveryClaimMessage({ repoId, market: repository.full_name, wallet: market.wallet, amount,
        claimId: id, genesis: await connection.getGenesisHash(), expiresAt })
      const { rows } = await db.query(`insert into discovery_claims
        (id, github_repo_id, wallet, amount, status, auth_message, auth_expires_at)
        values ($1,$2,$3,$4,'prepared',$5,$6) returning *`,
      [id, String(repoId), market.wallet, amount.toString(), message, expiresAt])
      return offer(rows[0])
    })
  }

  // The payout: claim the partner quote fee to the temporary authority (fresh base + WSOL accounts it owns), then
  // send exactly `amount` to the launcher, return the WSOL deposit to the partner and close the empty base account
  // to the partner. Every signer is a server key. An early access market's claim is claim_trading_fee2 from its hook
  // pool, checked before signing (src/dbc-hook-claims.mjs); its base account is the temporary authority's Token-2022 one.
  async function buildPayout(claim, market) {
    const temporary = temporaryAuthority(claim.id)
    const wallet = new PublicKey(claim.wallet), amount = BigInt(claim.amount), mint = new PublicKey(market.mint), pool = new PublicKey(market.pool)
    const hook = isEarlyAccessMarket(market)
    const claimTx = new Transaction()
    if (hook) {
      const expected = { kind: 'partner', authority: partner.publicKey, payer: partner.publicKey, pool, config: resolveConfig(market), mint,
        maxQuoteAmount: amount, receiver: temporary.publicKey, temporary: temporary.publicKey }
      const instructions = await hookClaimInstructions(dbc, expected)
      assertHookClaimInstructions(instructions, expected)
      claimTx.add(...instructions)
    } else {
      claimTx.add(await dbc.partner.claimPartnerTradingFee({ feeClaimer: partner.publicKey, payer: partner.publicKey,
        receiver: temporary.publicKey, tempWSolAcc: temporary.publicKey, pool,
        maxBaseAmount: new BN(0), maxQuoteAmount: new BN(amount.toString()) }))
    }
    const rent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)
    // The base account's deposit, which its close returns to the partner: a Token-2022 account is sized by its mint's extensions.
    const baseRent = hook ? await connection.getMinimumBalanceForRentExemption(associatedAccountLength(unpackMint(mint,
      await connection.getAccountInfo(mint, 'confirmed'), TOKEN_2022_PROGRAM_ID))) : rent
    claimTx.add(
      SystemProgram.transfer({ fromPubkey: temporary.publicKey, toPubkey: wallet, lamports: amount }),
      SystemProgram.transfer({ fromPubkey: temporary.publicKey, toPubkey: partner.publicKey, lamports: rent }),
      hook ? createCloseAccountInstruction(getAssociatedTokenAddressSync(mint, temporary.publicKey, true, TOKEN_2022_PROGRAM_ID),
        partner.publicKey, temporary.publicKey, [], TOKEN_2022_PROGRAM_ID)
        : createCloseAccountInstruction(getAssociatedTokenAddressSync(mint, temporary.publicKey), partner.publicKey, temporary.publicKey),
      new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(
        `repo.ing discovery reward v2 claim ${claim.id} repo ${claim.github_repo_id} lamports ${amount}`) }))
    const latest = await connection.getLatestBlockhash('confirmed')
    const { transaction } = await signedWithPriorityFee(connection, claimTx, { feePayer: partner.publicKey,
      blockhash: latest.blockhash, signers: [partner, temporary] })
    return { transaction, latest, rent, baseRent }
  }

  async function submit({ repoId, id, signature: walletSignature, transaction: legacyTransaction }) {
    if (!partner) fail('Discovery payouts are temporarily unavailable')
    if (!isClaimId(id)) fail('Discovery claim was not found')
    return withLock(repoId, async db => {
      const claim = (await db.query('select * from discovery_claims where id = $1 and github_repo_id = $2',
        [id, String(repoId)])).rows[0]
      if (!claim) fail('Discovery claim was not found')
      if (claim.status === 'settled') return offer(claim)
      if (claim.status === 'aborted') fail('This claim expired or failed. Start the claim again.')
      if (claim.status === 'pending') return settle(db, claim, await requireMarket(db, repoId))
      if (isLegacy(claim)) {
        await abort(db, claim, 'Replaced by a message-confirmed claim')
        fail('This claim offer is out of date. Reload the page and claim again.')
      }
      if (legacyTransaction !== undefined && walletSignature === undefined) fail('Reload the page and claim again.')
      // Nothing is read from the chain or signed for a request that does not carry the launcher's signature.
      if (!verifyDiscoveryClaimSignature({ message: claim.auth_message, signature: walletSignature, wallet: claim.wallet })) {
        fail('Wallet signature does not match this claim. Sign the claim message from the launcher wallet.')
      }
      if (messageExpired(claim)) {
        await abort(db, claim, 'Wallet confirmation expired')
        fail('Wallet confirmation expired. Start the claim again.')
      }
      const market = await requireMarket(db, repoId)
      const amount = BigInt(claim.amount)
      if (claim.wallet !== market.wallet) fail('Wallet signature does not match this claim')
      if (BigInt(market.remaining) < amount) fail('This reward changed. Start the claim again.')
      await requirePartnerFees(market, amount)
      const { transaction, latest, rent, baseRent } = await buildPayout(claim, market)
      const fee = (await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value
      if (fee === null || BigInt(fee) > DISCOVERY_MAX_NETWORK_FEE_LAMPORTS || isDustPayout(amount, fee)) {
        fail('Solana network fees are unusually high right now. Try again shortly; your signature stays valid until it expires.')
      }
      if (await connection.getBalance(partner.publicKey, 'confirmed') < rent + baseRent + fee) {
        console.error('discovery payout signer needs operating SOL', { repo: String(repoId) })
        fail('Discovery payouts are temporarily unavailable. Your rewards remain accrued.')
      }
      const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(transaction.serialize()),
        { sigVerify: true, commitment: 'confirmed' })
      if (simulation.value.err) fail('The payout could not be simulated. Your reward remains available; try again shortly.')
      const signature = bs58.encode(transaction.signature)
      const raw = transaction.serialize()
      // Durable intent: these exact bytes are committed before the first broadcast.
      const { rowCount } = await db.query(`update discovery_claims set status = 'pending', signature = $2, transaction = $3,
        last_valid_block_height = $4, auth_signature = $5 where id = $1 and status = 'prepared'`,
      [claim.id, signature, raw.toString('base64'), String(latest.lastValidBlockHeight), walletSignature])
      if (rowCount !== 1) fail('Discovery claim changed; check its status before retrying')
      // Network errors leave the intent pending. Recovery rebroadcasts these exact
      // bytes; it never constructs another payout for this claim.
      try {
        await broadcastUntilSettled(connection, raw, { signature, lastValidBlockHeight: latest.lastValidBlockHeight,
          maxMs: submitBroadcastMs })
      } catch { /* Claim-status polling and the worker resume this same signed transaction. */ }
      return { id: claim.id, status: 'pending', signature, amount: String(claim.amount) }
    })
  }

  async function recover(repoId) {
    return withLock(repoId, async db => {
      const claim = await activeClaim(db, repoId)
      if (!claim) return null
      const market = await requireMarket(db, repoId)
      const result = await settle(db, claim, market)
      if (result.status === 'pending') {
        try {
          await connection.sendRawTransaction(Buffer.from(claim.transaction, 'base64'),
            { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 })
        } catch { /* Retain pending status until finality or proven expiry. */ }
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
