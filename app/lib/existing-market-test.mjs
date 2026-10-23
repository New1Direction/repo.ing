import { createTestRun, TEST_PLAN } from '../../src/existing-market-test-run.mjs'
import { createTestTradingHandler } from '../../src/existing-market-test-trading.mjs'
import { readTestDammCheckpoint } from '../../src/existing-market-test-accounting.mjs'
import { createFeeAccrual } from '../../src/fee-accrual.mjs'
import { chain, configAddress } from './server.mjs'
import { tradeRouter } from './trader.mjs'
import { tradingCustodyRecovery, tradingDatabase, tradingMarketLoader } from './trading-recovery.mjs'

export function existingMarketTest() {
  const db = tradingDatabase(), connection = chain(), config = configAddress(), custodyRecovery = tradingCustodyRecovery()
  const loadMarket = tradingMarketLoader(db, config, custodyRecovery)
  if (!loadMarket || process.env.EXISTING_MARKET_TEST_PLAN !== TEST_PLAN.id || process.env.EXISTING_MARKET_TRADING_STAGE !== 'test') {
    throw Error('Test bindings disabled')
  }
  return createTestTradingHandler({ run: createTestRun({ db }), connection, router: tradeRouter(),
    submissionEnabled: process.env.EXISTING_MARKET_TEST_SUBMISSION === 'true',
    checkpoint: async repoId => readTestDammCheckpoint({ connection, db, config, custodyRecovery, market: await loadMarket(repoId) }),
    recordCurve: args => createFeeAccrual({ pool: db, connection, config, custodyRecovery }).recordTradeFees(args) })
}
