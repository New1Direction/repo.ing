import { readTipWallet } from '../../src/tips.mjs'
import { TIP_TOKENS, tipTokenPrices, tipUsdValue } from '../../src/tip-tokens.mjs'
import { database } from './server.mjs'

// The tip wallet signer stays in this module and the transfer routes; pages only ever see its public address.
let cached = { value: undefined, source: undefined }
export function tipSigner() {
  const source = process.env.TIP_WALLET_SECRET_KEY ?? ''
  if (cached.source === source && cached.value !== undefined) return cached.value
  let value = null
  try { value = readTipWallet() }
  catch (error) { console.error('tips disabled:', error.message) }
  cached = { value, source }
  return value
}
export const tipsEnabled = () => Boolean(database() && tipSigner())
export const tipWalletAddress = () => tipSigner()?.publicKey.toBase58() ?? null

const tokenMeta = mint => TIP_TOKENS.find(t => t.mint === mint)
const usdTotal = rows => rows.every(r => r.usd === null) ? null : rows.reduce((sum, r) => sum + (r.usd ?? 0), 0)

// Confirmed tips not yet paid out, per token, with a USD estimate at current prices.
export async function repoTipSummary(repoId, db = database()) {
  const wallet = tipWalletAddress()
  if (!db || !wallet || !/^\d+$/.test(String(repoId))) return null
  try {
    const [{ rows }, prices] = await Promise.all([db.query(`select mint, symbol, decimals, coalesce(sum(received_amount),0)::text as amount,
      count(*)::int as tips, bool_or(transfer_id is not null) as "inFlight" from repo_tips
      where github_repo_id=$1 and tip_wallet=$2 and status='confirmed' group by mint, symbol, decimals order by mint`, [String(repoId), wallet]), tipTokenPrices()])
    const waiting = rows.map(row => ({ ...row, name: tokenMeta(row.mint)?.name ?? row.symbol,
      usd: tipUsdValue(row, BigInt(row.amount), prices[row.mint]) }))
    return { waiting, count: waiting.reduce((n, r) => n + r.tips, 0), usd: usdTotal(waiting) }
  } catch { return null }
}

export async function tipStats(db = database()) {
  const wallet = tipWalletAddress()
  if (!db || !wallet) return null
  const [{ rows: totals }, { rows: recent }, prices] = await Promise.all([
    db.query(`select mint, symbol, decimals, count(*) filter (where status in ('confirmed','paid','refunded'))::int as tips,
      coalesce(sum(received_amount) filter (where status in ('confirmed','paid','refunded')),0)::text as received,
      coalesce(sum(received_amount) filter (where status='paid'),0)::text as paid,
      coalesce(sum(received_amount) filter (where status='refunded'),0)::text as refunded,
      coalesce(sum(received_amount) filter (where status='confirmed'),0)::text as waiting
      from repo_tips where tip_wallet=$1 group by mint, symbol, decimals having count(*) filter (where status in ('confirmed','paid','refunded')) > 0
      order by mint`, [wallet]),
    db.query(`(select 'tip' as kind, t.signature, t.received_amount::text as amount, t.mint, t.symbol, t.decimals, t.confirmed_at as at, r.full_name as "fullName", m.mint as "marketMint", t.donor_wallet as wallet
        from repo_tips t join repositories r on r.github_repo_id=t.github_repo_id left join markets m on m.github_repo_id=t.github_repo_id
        where t.tip_wallet=$1 and t.status in ('confirmed','paid','refunded') order by t.confirmed_at desc limit 12)
      union all
      (select x.kind, x.signature, x.amount::text, x.mint, null as symbol, x.decimals, x.settled_at as at, r.full_name as "fullName", m.mint as "marketMint", null as wallet
        from tip_transfers x join repositories r on r.github_repo_id=x.github_repo_id left join markets m on m.github_repo_id=x.github_repo_id
        where x.source_wallet=$1 and x.status='settled' order by x.settled_at desc limit 12)
      order by at desc limit 12`, [wallet]),
    tipTokenPrices(),
  ])
  const byToken = totals.map(row => ({ ...row, name: tokenMeta(row.mint)?.name ?? row.symbol,
    usdWaiting: tipUsdValue(row, BigInt(row.waiting), prices[row.mint]), usdReceived: tipUsdValue(row, BigInt(row.received), prices[row.mint]) }))
  return { wallet, byToken, recent: recent.map(row => ({ ...row, symbol: row.symbol ?? tokenMeta(row.mint)?.symbol ?? '' })),
    usdReceived: byToken.length ? usdTotal(byToken.map(r => ({ usd: r.usdReceived }))) : 0,
    usdWaiting: byToken.length ? usdTotal(byToken.map(r => ({ usd: r.usdWaiting }))) : 0 }
}

// A donor's own tips (newest first), for the wallet page's refund section.
export async function donorTips(wallet, db = database(), now = Date.now()) {
  if (!db || !tipSigner()) return null
  const { rows } = await db.query(`select t.id, t.status, t.symbol, t.decimals, t.mint, coalesce(t.received_amount, t.requested_amount)::text as amount,
    t.signature, t.created_at as "createdAt", t.refund_after as "refundAfter", t.transfer_id is not null as "inFlight",
    r.full_name as "fullName", m.mint as "marketMint" from repo_tips t join repositories r on r.github_repo_id=t.github_repo_id
    left join markets m on m.github_repo_id=t.github_repo_id
    where t.donor_wallet=$1 and t.status in ('confirmed','paid','refunded','submitted') order by t.created_at desc limit 50`, [wallet])
  return rows.map(row => ({ ...row, refundable: row.status === 'confirmed' && !row.inFlight && new Date(row.refundAfter).getTime() <= now }))
}
