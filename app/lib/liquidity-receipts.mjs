import { OFFICIAL_TOKEN } from './official-token.mjs'

// Protocol liquidity added to the canonical $REPOING DAMM v2 pool (the 20% policy share), verified
// on-chain: amounts are what the pool vaults received; position rent is excluded. `locked` flips
// once the position is permanently locked (add lockSignature then).
export const REPOING_POOL = 'FHw49kTEEjzBhRuMff9F1Xw1bLcBpwvsaSboaAWpAcaT'
export const LIQUIDITY_RECEIPTS = Object.freeze([
  Object.freeze({
    signature: '5ozYatwfvS1PNwWtAdXjBbWYtDAph4eCm5yHjrzwpn2MLvEemjLZwCijfQoP993X8M5AF9CQkYdDKrqR5PM7NRgn',
    wallet: OFFICIAL_TOKEN.teamWallet, pool: REPOING_POOL, positionNft: '4Lf4xKDeCQAYBaYsvxYMFwTTdSs4T5PMMvStJ3cZgjzG',
    solLamports: '1711400001', tokenBaseUnits: '3011505954141', at: '2026-09-29T06:44:33.000Z', locked: false,
  }),
])

export function liquidityTotals(receipts = LIQUIDITY_RECEIPTS) {
  const seen = new Set()
  return receipts.reduce((total, receipt) => {
    if (receipt.pool !== REPOING_POOL || !/^[1-9]\d*$/.test(receipt.solLamports) || !/^[1-9]\d*$/.test(receipt.tokenBaseUnits)) throw Error('Invalid liquidity receipt')
    if (seen.has(receipt.signature)) throw Error('Duplicate liquidity receipt')
    seen.add(receipt.signature)
    return { solLamports: total.solLamports + BigInt(receipt.solLamports), tokenBaseUnits: total.tokenBaseUnits + BigInt(receipt.tokenBaseUnits),
      allLocked: total.allLocked && receipt.locked === true }
  }, { solLamports: 0n, tokenBaseUnits: 0n, allLocked: true })
}
