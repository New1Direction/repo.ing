import bs58 from 'bs58'
import { PublicKey, Transaction } from '@solana/web3.js'
import { ACCOUNT_SIZE } from '@solana/spl-token'
import { chain } from '../../lib/server.mjs'
import { publicError } from '../../lib/public-error.mjs'
import { initializedWsolAccount } from '../../../src/referral.mjs'
import { assertWsolSetupTransaction, createWsolAtaInstruction } from '../../../src/wsol-account.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const SAFE = /^(Invalid wallet|Referral payout setup|Setup transaction)/
const headers = { 'Cache-Control': 'private, no-store' }

function walletKey(value) {
  if (typeof value !== 'string' || value.length > 44) throw Error('Invalid wallet address')
  try {
    const key = new PublicKey(value)
    if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw Error()
    return key
  } catch { throw Error('Invalid wallet address') }
}

// Payout status: whether the wallet's WSOL ATA exists and its wrapped-SOL balance (accumulated referral earnings).
export async function GET(request) {
  try {
    const wallet = walletKey(new URL(request.url).searchParams.get('wallet'))
    const connection = chain()
    const [account, rent] = await Promise.all([initializedWsolAccount(connection, wallet), connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed')])
    return Response.json({ enabled: Boolean(account), earningsLamports: account ? account.amount.toString() : '0',
      setupLamports: String(rent) }, { headers })
  } catch (error) {
    return Response.json({ error: publicError(error, SAFE, 'Referral status is temporarily unavailable', 'referral status') }, { status: 400, headers })
  }
}

// setup: an unsigned tx holding only the wallet's own idempotent WSOL ATA creation. submit: relays exactly that tx once signed.
export async function POST(request) {
  try {
    const body = await request.json()
    const wallet = walletKey(body.wallet)
    const connection = chain()
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
    return Response.json({ error: publicError(error, SAFE, 'Referral payout setup failed. Try again.', 'referral setup') }, { status: 400, headers })
  }
}
