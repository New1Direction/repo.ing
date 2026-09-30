import { prepareTip, submitTip, tipStatus, TIPS_DISABLED } from '../../../src/tips.mjs'
import { TIP_MIN_USD, TIP_TOKENS, minimumTipBaseUnits, tipTokenPrices } from '../../../src/tip-tokens.mjs'
import { chain, database } from '../../lib/server.mjs'
import { donorTips, repoTipSummary, tipSigner } from '../../lib/tips.mjs'
import { publicError } from '../../lib/public-error.mjs'
import { PublicKey } from '@solana/web3.js'
export const runtime = 'nodejs'

const SAFE = /^(Tips are not enabled|Invalid (repository|tip amount|tip action)|Connect a Solana wallet|The tip wallet|This token is not accepted|Tips start at|Token (price|mint|has|accounts|transfers|is non)|This repository has no market|Your wallet does not hold|Tip (simulation|was not prepared)|Wallet returned an altered|This tip already)/
const headers = { 'Cache-Control': 'no-store' }

async function tokenOptions() {
  const prices = await tipTokenPrices()
  return TIP_TOKENS.map(t => {
    let minimum = null
    try { minimum = minimumTipBaseUnits(t, prices[t.mint]).toString() } catch { /* No price: this token is paused. */ }
    return { symbol: t.symbol, name: t.name, mint: t.mint, decimals: t.decimals, kind: t.kind, usdPrice: prices[t.mint] ?? null, minimumBaseUnits: minimum }
  })
}

export async function POST(request) {
  try {
    const signer = tipSigner(), pool = database()
    if (!signer || !pool) throw Error(TIPS_DISABLED)
    const body = await request.json()
    if (body.action === 'options') {
      if (!/^[1-9]\d{0,18}$/.test(String(body.githubRepoId ?? ''))) throw Error('Invalid repository')
      const [tokens, summary] = await Promise.all([tokenOptions(), repoTipSummary(body.githubRepoId, pool)])
      return Response.json({ tokens, minimumUsd: TIP_MIN_USD, tipWallet: signer.publicKey.toBase58(), summary }, { headers })
    }
    if (body.action === 'prepare') {
      const prepared = await prepareTip({ pool, connection: chain(), tipWallet: signer.publicKey, prices: await tipTokenPrices(),
        githubRepoId: body.githubRepoId, wallet: body.wallet, mint: body.mint, amountBaseUnits: body.amountBaseUnits })
      return Response.json(prepared, { headers })
    }
    if (body.action === 'submit') return Response.json(await submitTip({ pool, connection: chain(), id: body.id, transaction: body.transaction }), { headers })
    if (body.action === 'status') return Response.json(await tipStatus({ pool, connection: chain(), id: body.id }), { headers })
    if (body.action === 'mine') {
      let wallet
      try { wallet = new PublicKey(body.wallet).toBase58() } catch { throw Error('Connect a Solana wallet to see your tips') }
      return Response.json({ tips: await donorTips(wallet, pool) }, { headers })
    }
    throw Error('Invalid tip action')
  } catch (error) {
    const disabled = error?.message === TIPS_DISABLED
    return Response.json({ error: publicError(error, SAFE, 'Tip failed. Refresh and try again.', 'tip') }, { status: disabled ? 503 : 400, headers })
  }
}
