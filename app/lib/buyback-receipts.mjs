import { OFFICIAL_TOKEN } from './official-token.mjs'

// Platform revenue custody (claimed partner fees under the 60/20/20 policy) and the team wallet.
export const BUYBACK_WALLETS = Object.freeze({ custody: 'FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy', team: OFFICIAL_TOKEN.teamWallet })

// Finalized buys into the canonical $REPOING pools (DBC quote vault HM9dEZ… before graduation, then the
// DAMM SOL vault 9gu44z…), verified on-chain. Later buys are detected by the worker (src/buyback-detection.mjs).
// spentLamports is the swap input: trading and route fees included; network fees and refundable
// token-account rent excluded. The launch buy and early team purchases are excluded.
// These disclosures do not debit the platform revenue ledger or enable spending.
export const BUYBACK_RECEIPTS = Object.freeze([
  Object.freeze({
    signature: 'aDZJpjckNwe537CKSPvaGihm9HjeqUUCpP9UjPa7JFKuwNyySygh1vCVmHnubp2tTMitoDzjBbLYF9q2g7rCtmR',
    source: 'team', wallet: BUYBACK_WALLETS.team, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '1500000000', tokenBaseUnits: '12408804843551',
    at: '2026-09-27T22:39:51.000Z',
  }),
  Object.freeze({
    signature: '539hWepPqppnXDeWVzcief83jizi7RFgzap2opdJHxAmESvUjHbB5xX9jdNUfQUNNGfunYeUKr83HdhUQrLWZtVL',
    source: 'team', wallet: BUYBACK_WALLETS.team, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '400000000', tokenBaseUnits: '3872583786447',
    at: '2026-09-28T00:58:27.000Z',
  }),
  Object.freeze({
    signature: 'QBN3zUaopUVHXvf5nTGCveF1Un8ouNaw27AD9etkr9uWj3Zm6djFasY9zdTLWpyFFg2AaiCagvTHUF7MW362DBT',
    source: 'team', wallet: BUYBACK_WALLETS.team, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '1591296661', tokenBaseUnits: '8986019777763',
    at: '2026-09-29T01:04:41.000Z',
  }),
  Object.freeze({
    signature: 'bPqkvqm63KD9FsaL1Kx1HnrWroDA9mtZqG5ESyq9yXNcDpnriVDgX91kpkZqznTcDXY7Kf43Y1ugM3EzY14PbLF',
    source: 'team', wallet: BUYBACK_WALLETS.team, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '2671035258', tokenBaseUnits: '11626420013839',
    at: '2026-09-29T02:19:32.000Z',
  }),
  Object.freeze({
    signature: 'phvkmtXFAud5gipNBrRqkN3FhbxeczKRUSCzABuTJwvTBskbE4f56tBAapDXKqADcW9qEbw1EQkkUKDV2uUSAR3',
    source: 'custody', wallet: BUYBACK_WALLETS.custody, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '5000000000', tokenBaseUnits: '30840544235259',
    at: '2026-09-28T21:52:43.000Z',
  }),
  Object.freeze({
    signature: '47AfWMTNz2cWsZRsCEaZJQ7ahf6PAY14Vz626pB97u8Vu3XKYnzP5chEC4Wv6HSvG4KArUBqR1aF1qkNihnKr7Wz',
    source: 'custody', wallet: BUYBACK_WALLETS.custody, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '1000000000', tokenBaseUnits: '7101917895131',
    at: '2026-09-28T22:27:17.000Z',
  }),
  Object.freeze({
    signature: '5nPJVAuRcmWKiaigHhg2E8L9YFEubyBDbh4c1wzHouGswwwzhenEbU8m5dr22oYk4pBG3z4XxS1k4h7bY9dqHfn2',
    source: 'custody', wallet: BUYBACK_WALLETS.custody, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '1000000000', tokenBaseUnits: '10463649551801',
    at: '2026-09-29T00:11:40.000Z',
  }),
  Object.freeze({
    signature: '4sM8EMrKN63Gu3YwkWvPjRMabANJKmq18J8yA5Qu3Phb6AqBxqMgrRkgAa56bRmNM4bmA2xnap9Fd2jqi5UQToWQ',
    source: 'custody', wallet: BUYBACK_WALLETS.custody, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '469505712', tokenBaseUnits: '2166645566321',
    at: '2026-09-29T01:35:02.000Z',
  }),
  Object.freeze({
    signature: '4rVhDPzQsMsCZddBhmKw3Zjpb9jGN4Ridi9LCM8N5fzmzw7CxmCYidvNRGpYbLStCv2pMag7xfg1fznUro3MbmmQ',
    source: 'team', wallet: BUYBACK_WALLETS.team, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '2003273897', tokenBaseUnits: '8499743083899',
    at: '2026-09-29T02:43:12.000Z',
  }),
  Object.freeze({
    signature: '3TCQDMr8QVWAHwg54RB9xxktb5FQ2dL171yqsWy7DfZACPTwEFMXXEnUdrgtXSCiUFYVaFrq4MsZUhYiCjacHo27',
    source: 'team', wallet: BUYBACK_WALLETS.team, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '1003273897', tokenBaseUnits: '1291556927314',
    at: '2026-09-29T03:49:56.000Z',
  }),
  Object.freeze({
    signature: '5VvriUmCGJ8PoMP6GWuhDLMvNbhRQC9HX7nVQAuVoQyeVgBULad8HMztuRQU1zq1KLxUB8i54MwsuborwUPDR9XX',
    source: 'team', wallet: BUYBACK_WALLETS.team, mint: OFFICIAL_TOKEN.mint,
    spentLamports: '1003273897', tokenBaseUnits: '2090101678713',
    at: '2026-09-29T04:17:36.000Z',
  }),
])

export const BUYBACK_RECEIPTS_BY_TIME = Object.freeze([...BUYBACK_RECEIPTS].sort((a, b) => a.at.localeCompare(b.at)))

export function totalBuybackLamports(receipts = BUYBACK_RECEIPTS, source = null) {
  const seen = new Set()
  return receipts.reduce((total, receipt) => {
    if (BUYBACK_WALLETS[receipt.source] !== receipt.wallet || receipt.mint !== OFFICIAL_TOKEN.mint ||
        !/^[1-9]\d*$/.test(receipt.spentLamports) || !receipt.signature) throw Error('Invalid buyback receipt')
    if (seen.has(receipt.signature)) throw Error('Duplicate buyback receipt')
    seen.add(receipt.signature)
    return source && receipt.source !== source ? total : total + BigInt(receipt.spentLamports)
  }, 0n).toString()
}
