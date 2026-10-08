import bs58 from 'bs58'
import { PublicKey, Transaction } from '@solana/web3.js'
import { ACCOUNT_SIZE } from '@solana/spl-token'
import { chain, database, partnerSigner } from '../../lib/server.mjs'
import { publicError } from '../../lib/public-error.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
import { initializedWsolAccount } from '../../../src/referral.mjs'
import { assertWsolSetupTransaction, createWsolAtaInstruction } from '../../../src/wsol-account.mjs'
import { ReferralSponsorError, createReferralSponsorship } from '../../../src/referral-sponsorship.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { clientKey } from '../../lib/holder-notes.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const SAFE = /^(Invalid wallet|Referral payout setup|Setup transaction|Free referral setup)/
const headers = { 'Cache-Control': 'private, no-store' }
const fail = message => { throw new ReferralSponsorError(message) }

function walletKey(value) {
  if (typeof value !== 'string' || value.length > 44) throw Error('Invalid wallet address')
  try {
    const key = new PublicKey(value)
    if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw Error()
    return key
  } catch { throw Error('Invalid wallet address') }
}

// Free setups (src/referral-sponsorship.mjs): null without a database, the partner key or valid settings, so the paid
// setup stays whatever happens here.
function sponsorship(connection) {
  try {
    const pool = database(), sponsor = partnerSigner()
    return pool && sponsor ? createReferralSponsorship({ pool, connection, sponsor }) : null
  } catch (error) {
    console.error(JSON.stringify({ event: 'referral_free_setup_config_failed', error: String(error?.message ?? error).slice(0, 200) }))
    return null
  }
}
// Shared across every web replica (agent_request_limits): a person needs two requests per setup.
const FREE_QUOTA = { global: [120, 60], client: [6, 60] }

// Payout status: whether the wallet's WSOL ATA exists, its wrapped-SOL balance (accumulated referral earnings), and
// whether repo.ing pays the setup for it right now (free).
export async function GET(request) {
  try {
    const wallet = walletKey(new URL(request.url).searchParams.get('wallet'))
    const connection = chain()
    const [account, rent] = await Promise.all([initializedWsolAccount(connection, wallet), connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed')])
    let free = false
    if (!account) free = await sponsorship(connection)?.available(wallet.toBase58()).catch(error => {
      console.error(JSON.stringify({ event: 'referral_free_setup_status_failed', error: String(error?.message ?? error).slice(0, 200) }))
      return false
    }) ?? false
    return Response.json({ enabled: Boolean(account), earningsLamports: account ? account.amount.toString() : '0',
      setupLamports: String(rent), free }, { headers })
  } catch (error) {
    return Response.json({ error: publicError(error, SAFE, 'Referral status is temporarily unavailable', 'referral status') }, { status: 400, headers })
  }
}

// setup: an unsigned tx holding only the wallet's own idempotent WSOL ATA creation. submit: relays exactly that tx once signed.
// free-prepare: a message to sign for a free setup. free-submit: the signed message; the partner wallet creates the account.
export async function POST(request) {
  try {
    if (Number(request.headers.get('content-length') || 0) > 8192) throw Error('Referral payout setup request is too large')
    const body = await request.json()
    const wallet = walletKey(body.wallet)
    const connection = chain()
    if (body.action === 'free-prepare' || body.action === 'free-submit') {
      if (request.headers.get('origin') !== publicOrigin(request.url)) throw new ReferralSponsorError('Free referral setup works on repo.ing only')
      const free = sponsorship(connection) ?? fail('Free referral setup is not available right now')
      if (!await takeQuota(database(), [['referral-free:global', ...FREE_QUOTA.global], [`referral-free:client:${clientKey(request)}`, ...FREE_QUOTA.client]])) {
        return Response.json({ error: 'Too many free setup requests. Try again in a minute.' }, { status: 429, headers })
      }
      if (body.action === 'free-prepare') return Response.json(await free.prepare(wallet.toBase58()), { headers })
      return Response.json(await free.submit({ wallet: wallet.toBase58(), message: body.message, seal: body.seal, signature: body.signature }), { headers })
    }
    if (body.action === 'setup') {
      const tx = new Transaction().add(createWsolAtaInstruction(wallet))
      const latest = await connection.getLatestBlockhash('confirmed')
      tx.feePayer = wallet
      tx.recentBlockhash = latest.blockhash
      assertWsolSetupTransaction(tx, wallet)
      return Response.json({ transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        lastValidBlockHeight: latest.lastValidBlockHeight }, { headers })
    }
    if (body.action === 'submit') {
      const signed = Transaction.from(Buffer.from(String(body.transaction), 'base64'))
      assertWsolSetupTransaction(signed, wallet)
      if (!signed.signature || !signed.verifySignatures()) throw Error('Setup transaction is not signed by the wallet')
      if (!Number.isSafeInteger(body.lastValidBlockHeight)) throw Error('Setup transaction expired; try again')
      const signature = bs58.encode(signed.signature)
      await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false })
      const result = await connection.confirmTransaction({ signature, blockhash: signed.recentBlockhash,
        lastValidBlockHeight: body.lastValidBlockHeight }, 'confirmed')
      if (result.value.err) throw Error('Setup transaction failed on chain')
      return Response.json({ signature, enabled: true }, { headers })
    }
    throw Error('Referral payout setup action is not supported')
  } catch (error) {
    const message = error instanceof ReferralSponsorError ? error.message : publicError(error, SAFE, 'Referral payout setup failed. Try again.', 'referral setup')
    return Response.json({ error: message }, { status: 400, headers })
  }
}
