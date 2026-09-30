import { PublicKey } from '@solana/web3.js'
import { NoteError } from '../../../../src/holder-notes.mjs'
import { marketByMint } from '../../../lib/server.mjs'
import { assertSameOrigin, seal, unseal } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { publicError } from '../../../lib/public-error.mjs'
import { clientKey, holderNotesPage, holderNotesService, publicNote } from '../../../lib/holder-notes.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }
const SAFE = error => error instanceof NoteError || /^Open the claim page/.test(error?.message ?? '')
const fail = (error, fallback) => Response.json({ error: publicError(error, SAFE, fallback, 'holder note') }, { status: error?.status ?? 400, headers })

async function loadMarket(params) {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  if (!market) throw new NoteError('Market not found', 404)
  return market
}

// ?offset=N → a page of public notes; ?wallet=… → that wallet's own note, so its composer can edit it.
export async function GET(request, { params }) {
  try {
    const market = await loadMarket(params), query = new URL(request.url).searchParams
    const wallet = query.get('wallet')
    if (wallet) {
      const service = holderNotesService()
      if (!service) throw new NoteError('Notes are temporarily unavailable', 503)
      if (wallet.length > 44 || new PublicKey(wallet).toBase58() !== wallet) throw new NoteError('Invalid wallet address')
      const note = await service.store.own(market.mint, wallet)
      // A hidden note's text is never served again, not even here (anyone can pass any wallet).
      return Response.json({ note: !note ? null : note.hidden ? { hidden: true } : { ...publicNote(note, null), hidden: false } }, { headers })
    }
    return Response.json(await holderNotesPage(market.mint, query.get('offset')), { headers })
  } catch (error) { return fail(error, 'Notes are temporarily unavailable.') }
}

export async function POST(request, { params }) {
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const market = await loadMarket(params), service = holderNotesService()
    if (!service) throw new NoteError('Notes are temporarily unavailable', 503)
    const body = await request.json(), ip = clientKey(request)
    if (body?.action === 'challenge') {
      const { terms, message } = await service.notes.challenge({ market, wallet: body.wallet, action: body.intent, text: body.text, ip })
      return Response.json({ challenge: seal(terms), message }, { headers })
    }
    if (body?.action === 'submit') {
      const terms = unseal(body.challenge)
      if (!terms) throw new NoteError('Signature request expired. Try again.')
      const result = await service.notes.submit({ market, terms, signature: body.signature, text: body.text, ip })
      return Response.json(result.note ? { note: { ...publicNote(result.note, result.note.balanceAtPost ? BigInt(result.note.balanceAtPost) : null), hidden: result.note.hidden } } : { deleted: result.deleted }, { headers })
    }
    throw new NoteError('Invalid note action')
  } catch (error) { return fail(error, 'Your note could not be saved. Refresh and try again.') }
}
