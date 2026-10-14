// Deliberately synthetic, fixed-clock data. NOT a recorded market or an AMM execution model.
export const mint = 'So11111111111111111111111111111111111111112';
export const start = Date.parse('2026-10-14T00:00:00Z');
export function snapshot(tick = 0) {
  return {
    market: { repoId: '1', mint, symbol: 'PAPER' },
    liquidity: {
      version: 1, venue: 'curve', pool: mint, sqrtPrice: '18446744073709551616',
      lamportsPerToken: '1000000', feeBps: 100, quoteReserveLamports: '5000000000', thresholdLamports: '10000000000',
      depth: [{ impactPercent: 2, buyLamports: '1000000000', buyTokens: '990000000', sellTokens: '800000000', sellLamports: '792000000' }],
      spreads: [{ sizeLamports: '100000000', askToSpotPpm: '1010101', bidToSpotPpm: '990000', spreadBps: 201 }],
      summary: { buyDepthLamports: '1000000000', sellDepthLamports: '792000000', spreadBps: 201, twoSided: true, feeBps: 100 },
      checkedAt: new Date(start + tick * 15_000).toISOString(),
    },
    note: 'Synthetic paper-only fixture; not executable liquidity.',
  };
}
