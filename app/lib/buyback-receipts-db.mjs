import { OFFICIAL_TOKEN } from './official-token.mjs'
import { BUYBACK_RECEIPTS, isBuybackWallet } from './buyback-receipts.mjs'

const AMOUNT = /^[1-9]\d*$/
const valid = receipt => isBuybackWallet(receipt.source, receipt.wallet) && receipt.mint === OFFICIAL_TOKEN.mint &&
  AMOUNT.test(receipt.spentLamports) && AMOUNT.test(receipt.tokenBaseUnits) && !!receipt.signature && !Number.isNaN(Date.parse(receipt.at))

// Hand-verified receipts win over a detected row with the same signature. A detected row that fails
// validation is left out rather than breaking the public total.
export function mergeBuybackReceipts(detected, known = BUYBACK_RECEIPTS) {
  const bySignature = new Map(known.map(receipt => [receipt.signature, receipt]))
  for (const receipt of detected) {
    const existing = bySignature.get(receipt.signature)
    if (existing) {
      if (existing.spentLamports !== receipt.spentLamports || existing.tokenBaseUnits !== receipt.tokenBaseUnits ||
          existing.source !== receipt.source) console.error('buyback receipt differs from verified list', receipt.signature)
      continue
    }
    if (!valid(receipt)) { console.error('invalid detected buyback receipt skipped', receipt.signature); continue }
    bySignature.set(receipt.signature, Object.freeze({ ...receipt }))
  }
  return Object.freeze([...bySignature.values()].sort((a, b) => a.at.localeCompare(b.at)))
}

let warned = false
// Static receipts plus worker-detected ones. Any database failure (including a missing table
// before migration 0025) falls back to the static list so /stats always renders.
export async function loadBuybackReceipts(db) {
  if (!db) return mergeBuybackReceipts([])
  try {
    const { rows } = await db.query(`select signature, source, wallet, mint, spent_lamports::text as "spentLamports",
      token_base_units::text as "tokenBaseUnits", slot::text as slot, block_time as "blockTime" from buyback_receipts order by block_time limit 5000`)
    return mergeBuybackReceipts(rows.map(({ blockTime, ...row }) => ({ ...row, at: new Date(blockTime).toISOString() })))
  } catch (error) {
    if (!warned) { warned = true; console.error('buyback receipts unavailable; using verified list', error?.code ?? 'error') }
    return mergeBuybackReceipts([])
  }
}
