import { ImageResponse } from 'next/og'
import bs58 from 'bs58'
import { database, chain, marketByMint } from '../../../../lib/server.mjs'
import { MarketShareArtwork } from '../../../../components/market-share-artwork'
import { graduationShare, payoutShare } from '../../../../../src/market-share.mjs'
import { verifyClaimReceipt } from '../../../../../src/claim-settlement.mjs'
import { HF_DISCLAIMER_SHORT, isModelMarket } from '../../../../lib/hf-model-display.mjs'
import { hfMarketsEnabled } from '../../../../lib/hf-markets.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request, { params }) {
  const headers = { 'Cache-Control': 'no-store' }
  try {
    const { mint } = await params
    if (typeof mint !== 'string' || mint.length > 44 || bs58.decode(mint).length !== 32) return Response.json({ error: 'Invalid market' }, { status: 400, headers })
    const { market } = await marketByMint(mint)
    const model = Boolean(market) && isModelMarket(market)
    if (!market || (model && !hfMarketsEnabled())) return Response.json({ error: 'Market not found' }, { status: 404, headers })
    const query = new URL(request.url).searchParams, kind = query.get('kind') || 'graduation'
    let snapshot
    if (kind === 'graduation') {
      const { rows: [row] } = await database().query(`select o.*,e.evidence_hash as migration_evidence_hash from graduation_observations o
        left join graduation_events e on e.github_repo_id=o.github_repo_id where o.github_repo_id=$1`, [market.repoId])
      snapshot = graduationShare(market, row)
    } else if (kind === 'payout') {
      const signature = query.get('signature')
      if (signature && (signature.length > 88 || bs58.decode(signature).length !== 64)) throw Error('Invalid payout receipt')
      const { rows: [row] } = await database().query(`select github_repo_id::text as "repoId",status,settled_at as "settledAt",
        claim_signature as "claimSignature",signed_transaction as "signedTransaction",beneficiary_wallet as "beneficiaryWallet",
        amount_base_units::text as "amountBaseUnits",damm_amount_base_units::text as "dammAmountBaseUnits"
        from repo_claims where github_repo_id=$1 and status='settled' and ($2::text is null or claim_signature=$2)
        order by settled_at desc,id desc limit 1`, [market.repoId, signature])
      if (!row?.signedTransaction) throw Error('No verified builder payout is available for this market yet')
      snapshot = payoutShare(market, row, await verifyClaimReceipt(chain(), row))
    } else return Response.json({ error: 'Unsupported card type' }, { status: 400, headers })
    // A Hugging Face model market's card names who was paid, and its caption carries the disclaimer under its own lines.
    if (model) snapshot = { ...snapshot, caption: `${snapshot.caption}\n${HF_DISCLAIMER_SHORT}`,
      ...(snapshot.kind === 'payout' ? { headline: 'Model owner paid.', detail: 'Fees paid to the model owner’s verified payout wallet' } : {}) }
    const result = new ImageResponse(<MarketShareArtwork market={market} snapshot={snapshot}/>, { width: 1200, height: 630 })
    // Materialize before responding so a renderer failure cannot masquerade as a PNG.
    return new Response(await result.arrayBuffer(), { headers: { ...headers, 'Content-Type': 'image/png',
      'Content-Disposition': `inline; filename="repoing-${kind}-${market.repoId}.png"`,
      'X-Repoing-Share-Text': encodeURIComponent(snapshot.caption) } })
  } catch {
    return Response.json({ error: 'This card is not ready: current graduation proof or a finalized builder payout is required. Please retry shortly.' }, { status: 503, headers })
  }
}
