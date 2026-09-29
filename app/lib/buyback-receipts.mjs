import { OFFICIAL_TOKEN } from './official-token.mjs'

// Finalized canonical-pool buys (the first two verified against two RPCs on 2026-09-28; the Sep 29
// Jupiter-routed buys verified on 2026-09-29 to pay into the canonical DAMM pool's SOL vault).
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
  Object.freeze({
    signature: 'QBN3zUaopUVHXvf5nTGCveF1Un8ouNaw27AD9etkr9uWj3Zm6djFasY9zdTLWpyFFg2AaiCagvTHUF7MW362DBT',
    wallet: OFFICIAL_TOKEN.teamWallet, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '1591296661', tokenBaseUnits: '8986019777763',
    at: '2026-09-29T01:04:41.000Z',
  }),
  Object.freeze({
    signature: 'bPqkvqm63KD9FsaL1Kx1HnrWroDA9mtZqG5ESyq9yXNcDpnriVDgX91kpkZqznTcDXY7Kf43Y1ugM3EzY14PbLF',
    wallet: OFFICIAL_TOKEN.teamWallet, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '2671035258', tokenBaseUnits: '11626420013839',
    at: '2026-09-29T02:19:32.000Z',
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
