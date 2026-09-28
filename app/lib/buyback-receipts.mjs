import { OFFICIAL_TOKEN } from './official-token.mjs'

// Finalized canonical-pool buys verified against two RPCs on 2026-09-28.
// Gross SOL includes trading fees; network fees and launch purchases are excluded.
// These disclosures do not debit the platform revenue ledger or enable spending.
export const BUYBACK_RECEIPTS = Object.freeze([
  Object.freeze({
    signature: 'aDZJpjckNwe537CKSPvaGihm9HjeqUUCpP9UjPa7JFKuwNyySygh1vCVmHnubp2tTMitoDzjBbLYF9q2g7rCtmR',
    wallet: OFFICIAL_TOKEN.teamWallet, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '1500000000', tokenBaseUnits: '12408804843551',
    at: '2026-09-27T22:39:51.000Z',
  }),
  Object.freeze({
    signature: '539hWepPqppnXDeWVzcief83jizi7RFgzap2opdJHxAmESvUjHbB5xX9jdNUfQUNNGfunYeUKr83HdhUQrLWZtVL',
    wallet: OFFICIAL_TOKEN.teamWallet, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '400000000', tokenBaseUnits: '3872583786447',
    at: '2026-09-28T00:58:27.000Z',
  }),
])

export function totalBuybackLamports(receipts = BUYBACK_RECEIPTS) {
  const seen = new Set()
  return receipts.reduce((total, receipt) => {
    if (receipt.wallet !== OFFICIAL_TOKEN.teamWallet || receipt.mint !== OFFICIAL_TOKEN.mint ||
        !/^[1-9]\d*$/.test(receipt.spentLamports) || !receipt.signature) throw Error('Invalid buyback receipt')
    if (seen.has(receipt.signature)) throw Error('Duplicate buyback receipt')
    seen.add(receipt.signature)
    return total + BigInt(receipt.spentLamports)
  }, 0n).toString()
}
