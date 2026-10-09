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
  Object.freeze({
    signature: '25GKQ2s44RdrGtPkSkp5JSBpSKDbmgndhRjGLaD27jJeZe4zxstUpAsknf643KteiqHS7APzXX5xaXZXxS1e1pZZ',
    wallet: OFFICIAL_TOKEN.teamWallet, pool: REPOING_POOL, positionNft: '4Lf4xKDeCQAYBaYsvxYMFwTTdSs4T5PMMvStJ3cZgjzG',
    solLamports: '1741250001', tokenBaseUnits: '2222128769339', at: '2026-09-29T20:40:45.000Z', locked: false,
  }),
  Object.freeze({
    signature: '36wRuwKuVwWzAc5KGDdS5vgdtGuuVhWc2ZHd4tBMpZ1myuMJPZiJ9BSQb9VqPzc4Bp7UwRsuWiyW98gvoxJPXUSY',
    wallet: OFFICIAL_TOKEN.teamWallet, pool: REPOING_POOL, positionNft: '4Lf4xKDeCQAYBaYsvxYMFwTTdSs4T5PMMvStJ3cZgjzG',
    solLamports: '995000001', tokenBaseUnits: '1259651284748', at: '2026-09-29T23:14:23.000Z', locked: false,
  }),
  Object.freeze({
    signature: '26Gc9Z7Ddr7EyCWDzNyQ2n6hLR6KNNbUwAZVUxBhRBybkPc77qvwPJzjUiKzpHnsXdjDV7aWpBQ65RWnr2h67ny5',
    wallet: OFFICIAL_TOKEN.teamWallet, pool: REPOING_POOL, positionNft: '4Lf4xKDeCQAYBaYsvxYMFwTTdSs4T5PMMvStJ3cZgjzG',
    solLamports: '995000001', tokenBaseUnits: '613821656139', at: '2026-10-08T22:27:38.000Z', locked: false,
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

// What a graduated market's panel shows as protocol liquidity added: its settled protocol deployments (settled, verified by the
// graduation monitor, src/graduation-readiness.mjs), plus the manual deposits above for the canonical $REPOING pool. Any other
// pool's figure is returned as it is; for $REPOING's, lamports as text, or null when there is none.
export function protocolLiquidityAdded(pool, settled, receipts = LIQUIDITY_RECEIPTS) {
  if (pool !== REPOING_POOL) return settled
  const total = BigInt(settled ?? 0) + liquidityTotals(receipts).solLamports
  return total > 0n ? total.toString() : null
}
