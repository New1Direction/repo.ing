import { ImageResponse } from 'next/og'
import bs58 from 'bs58'
import { database, chain, marketByMint } from '../../../../lib/server.mjs'
import { MarketShareArtwork } from '../../../../components/market-share-artwork'
import { graduationShare, noPayoutYet, payoutShare, shareCardKinds, shareCardNotOffered } from '../../../../../src/market-share.mjs'
import { verifyClaimReceipt } from '../../../../../src/claim-settlement.mjs'
import { HF_DISCLAIMER_SHORT, isModelMarket } from '../../../../lib/hf-model-display.mjs'
import { hfMarketsEnabled } from '../../../../lib/hf-markets.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// kind: 'graduation', 'payout', or 'auto' (the default): the first card this market offers (src/market-share.mjs shareCardKinds).
// Every answer names the cards the market offers (X-Repoing-Share-Kinds on a card, `kinds` on a refusal), so the dialog shows
// only tabs that can work. A card the market does not offer (409) and a payout card before any payout (404) are final, with a
// `code`; anything else is a 503 to retry.
const KINDS = ['auto', 'graduation', 'payout']
export async function GET(request, { params }) {
  const headers = { 'Cache-Control': 'no-store' }
  let kinds
  try {
    const { mint } = await params
    if (typeof mint !== 'string' || mint.length > 44 || bs58.decode(mint).length !== 32) return Response.json({ error: 'Invalid market' }, { status: 400, headers })
    const { market } = await marketByMint(mint)
    const model = Boolean(market) && isModelMarket(market)
    if (!market || (model && !hfMarketsEnabled())) return Response.json({ error: 'Market not found' }, { status: 404, headers })
    const query = new URL(request.url).searchParams, requested = query.get('kind') || 'auto', signature = query.get('signature')
    if (!KINDS.includes(requested)) return Response.json({ error: 'Unsupported card type' }, { status: 400, headers })
    kinds = shareCardKinds(market)
    const kind = requested !== 'auto' ? requested : signature ? 'payout' : kinds[0]
    if (!kinds.includes(kind)) return Response.json(shareCardNotOffered(market, kind), { status: 409, headers })
    let snapshot
    if (kind === 'graduation') {
      const { rows: [row] } = await database().query(`select o.*,e.evidence_hash as migration_evidence_hash from graduation_observations o
        left join graduation_events e on e.github_repo_id=o.github_repo_id where o.github_repo_id=$1`, [market.repoId])
      snapshot = graduationShare(market, row)
    } else {
      if (signature && (signature.length > 88 || bs58.decode(signature).length !== 64)) throw Error('Invalid payout receipt')
      // The newest settled payout, or the one this signature names: one receipt, verified on chain, never a total.
      const { rows: [row] } = await database().query(`select github_repo_id::text as "repoId",status,settled_at as "settledAt",
        claim_signature as "claimSignature",signed_transaction as "signedTransaction",beneficiary_wallet as "beneficiaryWallet",
        amount_base_units::text as "amountBaseUnits",damm_amount_base_units::text as "dammAmountBaseUnits"
        from repo_claims where github_repo_id=$1 and status='settled' and ($2::text is null or claim_signature=$2)
        order by settled_at desc,id desc limit 1`, [market.repoId, signature])
      // No settled payout at all is final; a named receipt not settled yet (a claim just sent) is worth a retry.
      if (!row && !signature) return Response.json(noPayoutYet(market, { model }), { status: 404, headers })
      if (!row?.signedTransaction) throw Error('No verified builder payout is available for this market yet')
      snapshot = payoutShare(market, row, await verifyClaimReceipt(chain(), row), { latest: !signature, model })
    }
    // A Hugging Face model market's caption carries the disclaimer under its own lines.
    if (model) snapshot = { ...snapshot, caption: `${snapshot.caption}\n${HF_DISCLAIMER_SHORT}` }
    const result = new ImageResponse(<MarketShareArtwork market={market} snapshot={snapshot}/>, { width: 1200, height: 630 })
    // Materialize before responding so a renderer failure cannot masquerade as a PNG.
    return new Response(await result.arrayBuffer(), { headers: { ...headers, 'Content-Type': 'image/png',
      'Content-Disposition': `inline; filename="repoing-${kind}-${market.repoId}.png"`,
      'X-Repoing-Share-Text': encodeURIComponent(snapshot.caption), 'X-Repoing-Share-Kind': kind, 'X-Repoing-Share-Kinds': kinds.join(',') } })
  } catch {
    return Response.json({ error: 'This card is not ready: current graduation proof or a finalized builder payout is required. Please retry shortly.',
      ...kinds ? { kinds } : {} }, { status: 503, headers })
  }
}
