import { PARTS_DISABLED, PARTS_MIN_PLEDGE_USD, PARTS_TOKENS, validUuid } from '../../../src/parts-fund.mjs'
import { pledgeStatus, preparePledge, submitPledge } from '../../../src/parts-pledges.mjs'
import { minimumTipBaseUnits, tipTokenPrices } from '../../../src/tip-tokens.mjs'
import { chain, database } from '../../lib/server.mjs'
import { tipSigner } from '../../lib/tips.mjs'
import { partsFundById } from '../../lib/parts-fund.mjs'
import { takeQuota } from '../../../src/request-quota.mjs'
import { clientKey } from '../../lib/holder-notes.mjs'
import { publicError } from '../../lib/public-error.mjs'
export const runtime = 'nodejs'

const SAFE = /^(Parts funds are not enabled|Parts funds accept|Parts list not found|This parts list is|The parts list changed|Only \$|Finish or wait|Choose a part|Invalid (pledge|tip) amount|Invalid parts action|Connect a Solana wallet|The tip wallet|Pledges start at|Token (price|mint|has|accounts|transfers|is non)|This repository has no market|Your wallet does not hold|Pledge (simulation|was not prepared)|Wallet returned an altered|This pledge already|Too many pledge)/
const headers = { 'Cache-Control': 'no-store' }
// Prepare builds and simulates a transaction, so it is the one action worth throttling hard. The quotas live in
// PostgreSQL so they hold across replicas: 240/min overall, 12/min per client and 6/min per wallet.
const pledgeQuota = (pool, request, wallet) => takeQuota(pool, [['parts-pledge:global', 240, 60],
  [`parts-pledge:client:${clientKey(request)}`, 12, 60], [`parts-pledge:wallet:${String(wallet ?? '').slice(0, 44)}`, 6, 60]])

async function tokenOptions() {
  const prices = await tipTokenPrices()
  return PARTS_TOKENS.map(t => {
    let minimum = null
    try { minimum = minimumTipBaseUnits(t, prices[t.mint]).toString() } catch { /* No price: pledges in this token are paused. */ }
    return { symbol: t.symbol, name: t.name, mint: t.mint, decimals: t.decimals, usdPrice: prices[t.mint] ?? null, minimumBaseUnits: minimum }
  })
}

export async function POST(request) {
  try {
    const signer = tipSigner(), pool = database()
    if (!signer || !pool) throw Error(PARTS_DISABLED)
    const body = await request.json()
    if (body.action === 'view') {
      if (!validUuid(body.fundId)) throw Error('Parts list not found')
      const [fund, tokens] = await Promise.all([partsFundById(body.fundId, pool), tokenOptions()])
      if (!fund) throw Error('Parts list not found')
      const { backerWallets, ...publicFund } = fund
      return Response.json({ fund: publicFund, tokens, minimumUsd: PARTS_MIN_PLEDGE_USD }, { headers })
    }
    if (body.action === 'prepare') {
      if (!await pledgeQuota(pool, request, body.wallet)) throw Error('Too many pledge attempts. Try again in a minute.')
      const prepared = await preparePledge({ pool, connection: chain(), tipWallet: signer.publicKey, prices: await tipTokenPrices(),
        fundId: body.fundId, revision: body.revision, itemId: body.itemId ?? null, wallet: body.wallet, mint: body.mint, amountBaseUnits: body.amountBaseUnits })
      return Response.json(prepared, { headers })
    }
    if (body.action === 'submit') return Response.json(await submitPledge({ pool, connection: chain(), id: body.id, transaction: body.transaction }), { headers })
    if (body.action === 'status') return Response.json(await pledgeStatus({ pool, connection: chain(), id: body.id }), { headers })
    throw Error('Invalid parts action')
  } catch (error) {
    const disabled = error?.message === PARTS_DISABLED
    const limited = /^Too many pledge/.test(error?.message ?? '')
    return Response.json({ error: publicError(error, SAFE, 'Pledge failed. Refresh and try again.', 'parts pledge') },
      { status: disabled ? 503 : limited ? 429 : 400, headers })
  }
}
