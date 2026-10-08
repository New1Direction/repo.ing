import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import bs58 from 'bs58'
import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js'
import { ACCOUNT_SIZE } from '@solana/spl-token'
import { initializedWsolAccount } from './referral.mjs'
import { createWsolAtaInstruction, isCreateWsolAta, wsolAta } from './wsol-account.mjs'
import { SOLANA_MAINNET_GENESIS, verifyDiscoveryClaimSignature } from './discovery-claim-message.mjs'
import { broadcastUntilSettled, maxPayoutNetworkFee, signedWithPriorityFee } from './trade-landing.mjs'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'

// Free referral payout setup (owner decision 2026-10-08, "for right now"): repo.ing's partner wallet creates a wallet's
// wrapped-SOL payout account and pays its rent and network fee. The wallet only signs a plain-text message, never a
// transaction. Limits: one free setup per wallet (a settled one is final, even if the account is closed later), at most
// REFERRAL_FREE_SETUP_DAILY a UTC day (default 50), and never below the partner wallet's reserve. Anything else falls
// back to the paid setup in app/api/referral/route.js. REFERRAL_FREE_SETUP=off turns it off.
// prepare stores nothing: the message carries a seal (HMAC under the partner key), so unsigned requests hold no place.
// A place is taken only by a signed message, under one lock that counts the day and checks the reserve.
export const SPONSOR_MESSAGE_MS = 5 * 60 * 1000
export const DEFAULT_DAILY_FREE_SETUPS = 50
// The partner wallet also pays discovery rewards and signs the sweep: free setups stop before it would hold less than this.
export const SPONSOR_RESERVE_LAMPORTS = 50_000_000n
const SUBMIT_BROADCAST_MS = 12_000
const BALANCE_CACHE_MS = 30_000
const RECOVER_BATCH = 5
const LOCK = 'repoing referral sponsorships'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export class ReferralSponsorError extends Error {}
const fail = message => { throw new ReferralSponsorError(message) }
// One chain and one partner wallet per process: the genesis hash and a recent balance are shared by every request.
const genesisByEndpoint = new Map(), balances = new Map()

// REFERRAL_FREE_SETUP (default on) and REFERRAL_FREE_SETUP_DAILY (0 to 1000, default 50).
export function freeSetupSettings(env = process.env) {
  const enabled = (env.REFERRAL_FREE_SETUP ?? 'on').trim().toLowerCase() !== 'off'
  const raw = env.REFERRAL_FREE_SETUP_DAILY?.trim()
  const daily = raw ? Number(raw) : DEFAULT_DAILY_FREE_SETUPS
  if (!Number.isInteger(daily) || daily < 0 || daily > 1000) throw Error('REFERRAL_FREE_SETUP_DAILY must be a whole number from 0 to 1000')
  return { enabled: enabled && daily > 0, daily }
}

export function freeSetupMessage({ wallet, sponsor, id, genesis, expiresAt }) {
  if (!UUID.test(id)) throw Error('Valid request ID required')
  const owner = new PublicKey(wallet)
  return [
    'repo.ing wants you to confirm free referral payouts.',
    '',
    `Wallet: ${owner.toBase58()}`,
    `Payout account: ${wsolAta(owner).toBase58()} (wrapped SOL)`,
    `Paid by: repo.ing ${new PublicKey(sponsor).toBase58()}`,
    `Request: ${id}`,
    `Chain: Solana ${genesis === SOLANA_MAINNET_GENESIS ? 'mainnet' : 'cluster'} ${genesis}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    '',
    'This does not authorize any transaction from your wallet.',
  ].join('\n')
}
const field = (message, name) => message.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)

// The sponsored transaction: the budget instructions and exactly one creation of this wallet's payout account, paid by
// the sponsor. The wallet is neither the fee payer nor a signer.
export function assertSponsoredSetup(tx, wallet, sponsor) {
  const rest = tx.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId))
  if (!tx.feePayer?.equals(sponsor) || rest.length !== 1 || !isCreateWsolAta(rest[0], wallet, sponsor) ||
      tx.signatures.some(item => item.publicKey.equals(wallet))) {
    fail('Free referral setup transaction is not the expected account creation')
  }
}

export function createReferralSponsorship({ pool, connection, sponsor, settings = freeSetupSettings(), now = Date.now,
  submitBroadcastMs = SUBMIT_BROADCAST_MS }) {
  const genesis = async () => {
    const key = connection.rpcEndpoint ?? ''
    if (!genesisByEndpoint.has(key)) genesisByEndpoint.set(key, await connection.getGenesisHash())
    return genesisByEndpoint.get(key)
  }
  const seal = message => createHmac('sha256', Buffer.from(sponsor.secretKey)).update(`repo.ing referral free setup v1\n${message}`).digest()
  const ownerKey = wallet => {
    try { return new PublicKey(wallet) } catch { return fail('Invalid wallet address') }
  }
  const balance = async ({ fresh = false } = {}) => {
    const key = sponsor.publicKey.toBase58(), cached = balances.get(key)
    if (!fresh && cached && now() - cached.at < BALANCE_CACHE_MS) return cached.lamports
    const lamports = BigInt(await connection.getBalance(sponsor.publicKey, 'confirmed'))
    balances.set(key, { at: now(), lamports })
    return lamports
  }
  const locked = async work => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [LOCK])
      const result = await work(client)
      await client.query('commit')
      return result
    } catch (error) { await client.query('rollback').catch(() => {}); throw error }
    finally { client.release() }
  }
  const walletRow = async (db, wallet) => (await db.query(`select * from referral_sponsorships
    where wallet = $1 and status in ('pending','settled') limit 1`, [wallet])).rows[0]
  // Today's free setups (UTC day of the database clock): every signed one that was sent, landed or not yet decided.
  const usedToday = async db => Number((await db.query(`select count(*)::int as n from referral_sponsorships
    where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc' and status in ('pending','settled')`)).rows[0].n)
  const abort = (row, reason) => pool.query(`update referral_sponsorships set status = 'aborted', resolution_reason = $2
    where id = $1 and status = 'pending'`, [row.id, reason])

  // A pending setup settles from finalized evidence only; it is abandoned only when provably expired and unlanded.
  async function settle(row) {
    if (row.status !== 'pending') return row.status
    const chainTx = await connection.getTransaction(row.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (chainTx?.meta) {
      if (chainTx.meta.err) { await abort(row, 'Transaction finalized with an error'); return 'aborted' }
      const keys = chainTx.transaction.message.accountKeys
      const i = keys.findIndex(key => key.equals(sponsor.publicKey))
      const spent = i < 0 ? null : BigInt(chainTx.meta.preBalances[i]) - BigInt(chainTx.meta.postBalances[i])
      await pool.query(`update referral_sponsorships set status = 'settled', settled_at = now(), fee_lamports = $2, rent_lamports = $3
        where id = $1 and status = 'pending'`, [row.id, String(chainTx.meta.fee), spent === null ? null : String(spent - BigInt(chainTx.meta.fee))])
      return 'settled'
    }
    const status = (await connection.getSignatureStatuses([row.signature], { searchTransactionHistory: true })).value[0]
    if (!status && await provablyExpiredUnlanded(connection, row.signature, row.last_valid_block_height)) {
      await abort(row, 'Blockhash expired with no transaction in finalized history')
      return 'aborted'
    }
    return 'pending'
  }
  // Pending setups of one wallet, or else the oldest few of all wallets (bounded work per request).
  async function recover(wallet = null) {
    const rows = wallet
      ? (await pool.query(`select * from referral_sponsorships where wallet = $1 and status = 'pending'`, [wallet])).rows
      : (await pool.query(`select * from referral_sponsorships where status = 'pending' order by created_at limit ${RECOVER_BATCH}`)).rows
    for (const row of rows) await settle(row).catch(() => null)
  }

  // Whether this wallet can get a free setup now (for GET /api/referral): two cheap reads and a cached balance.
  async function available(wallet) {
    if (!settings.enabled || !sponsor) return false
    const owner = ownerKey(wallet).toBase58()
    if (await walletRow(pool, owner)) return false
    return await usedToday(pool) < settings.daily && await balance() >= SPONSOR_RESERVE_LAMPORTS
  }

  // A message to sign and its seal. Stores nothing and holds no place.
  async function prepare(wallet) {
    if (!settings.enabled || !sponsor) fail('Free referral setup is not available right now')
    const owner = ownerKey(wallet)
    await recover()
    const row = await walletRow(pool, owner.toBase58())
    if (row?.status === 'settled') fail('This wallet already had its free referral setup')
    if (row) fail('Your free referral setup is in progress. Check again in a minute.')
    if (await initializedWsolAccount(connection, owner)) fail('Referral payouts are already enabled for this wallet')
    if (await usedToday(pool) >= settings.daily) fail('Today’s free referral setups are used up')
    if (await balance() < SPONSOR_RESERVE_LAMPORTS) fail('Free referral setup is not available right now')
    const id = randomUUID(), expiresAt = new Date(now() + SPONSOR_MESSAGE_MS)
    const message = freeSetupMessage({ wallet: owner, sponsor: sponsor.publicKey, id, genesis: await genesis(), expiresAt })
    return { message, seal: seal(message).toString('base64url'), expiresAt: expiresAt.toISOString() }
  }

  // The signed message in, the account created by the partner wallet out. The place is taken, the reserve checked and
  // the fully signed transaction stored as 'pending' in one locked step, before any broadcast.
  async function submit({ wallet, message, seal: sealed, signature }) {
    if (!settings.enabled || !sponsor) fail('Free referral setup is not available right now')
    const owner = ownerKey(wallet), address = owner.toBase58()
    if (typeof message !== 'string' || message.length > 2000 || typeof sealed !== 'string' || sealed.length > 64) fail('Free referral setup request is not valid')
    const expected = seal(message), given = Buffer.from(sealed, 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) fail('Free referral setup request was not issued by repo.ing')
    if (field(message, 'Wallet') !== address) fail('Free referral setup request is for another wallet')
    if (!(now() < new Date(field(message, 'Expires')).getTime())) fail('The confirmation expired. Try again.')
    if (!verifyDiscoveryClaimSignature({ message, signature, wallet: address })) fail('The wallet signature does not match. Try again.')
    // Confirmed but not yet finalized also counts as done for the person: the account is there for new trades.
    const outcome = async row => {
      const status = await settle(row)
      const enabled = status === 'settled' || (status === 'pending' && Boolean(await initializedWsolAccount(connection, owner).catch(() => null)))
      return { status: enabled ? 'settled' : status, signature: row.signature }
    }
    const existing = await walletRow(pool, address)
    if (existing) return outcome(existing)
    if (await initializedWsolAccount(connection, owner)) return { status: 'settled', alreadyEnabled: true }

    const latest = await connection.getLatestBlockhash('confirmed')
    const { transaction } = await signedWithPriorityFee(connection, new Transaction().add(createWsolAtaInstruction(owner, sponsor.publicKey)),
      { feePayer: sponsor.publicKey, blockhash: latest.blockhash, signers: [sponsor] })
    assertSponsoredSetup(transaction, owner, sponsor.publicKey)
    const rent = BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed'))
    const raw = transaction.serialize(), txSignature = bs58.encode(transaction.signature), id = randomUUID()
    const taken = await locked(async db => {
      const row = await walletRow(db, address)
      if (row) return row
      if (await usedToday(db) >= settings.daily) fail('Today’s free referral setups are used up')
      if (await balance({ fresh: true }) < SPONSOR_RESERVE_LAMPORTS + rent + maxPayoutNetworkFee(1)) fail('Free referral setup is not available right now')
      await db.query(`insert into referral_sponsorships (id, wallet, status, auth_message, auth_expires_at, transaction, signature,
        last_valid_block_height, rent_lamports) values ($1, $2, 'pending', $3, $4, $5, $6, $7, $8)`,
      [id, address, message, new Date(field(message, 'Expires')), raw.toString('base64'), txSignature, latest.lastValidBlockHeight, String(rent)])
      return null
    })
    // Another request for this wallet took the place first: its transaction is the one, this one is never sent.
    if (taken) return outcome(taken)
    balances.delete(sponsor.publicKey.toBase58())
    await broadcastUntilSettled(connection, raw, { signature: txSignature, lastValidBlockHeight: latest.lastValidBlockHeight, maxMs: submitBroadcastMs })
      .catch(error => console.warn(JSON.stringify({ event: 'referral_free_setup_broadcast_failed', id, signature: txSignature,
        error: String(error?.message ?? error).slice(0, 200) })))
    return outcome({ id, status: 'pending', signature: txSignature, last_valid_block_height: latest.lastValidBlockHeight })
  }

  return { available, prepare, submit, recover }
}
