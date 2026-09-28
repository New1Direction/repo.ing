import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateReserveCoverage, readReserveCoverage } from '../src/reserve-coverage.mjs'

const platform = { status: 'MATCH', buybackReserve: '112601254', liquidityReserve: '37533745',
  unallocated: '0', custodyWallets: ['FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy'] }
const observation = (balance = '6990122') => ({ wallet: platform.custodyWallets[0],
  genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', slot: 451300000, balance })

test('ledger MATCH does not hide a receiving-wallet shortfall', () => {
  const result = evaluateReserveCoverage(platform, [observation(), observation()])
  assert.equal(result.status, 'SHORTFALL')
  assert.equal(result.required, '150134999')
  assert.equal(result.shortfall, '143144877')
  assert.equal(platform.buybackReserve, '112601254')
})

test('coverage includes unallocated funds, but never treats treasury allocation as a reserved liability', () => {
  const exact = evaluateReserveCoverage(platform, [observation('150134999'), observation('150134999')])
  assert.equal(exact.status, 'COVERED')
  const withUnallocated = evaluateReserveCoverage({ ...platform, unallocated: '1', treasuryAllocated: '99999999' },
    [observation('150134999'), observation('150134999')])
  assert.equal(withUnallocated.shortfall, '1')
})

test('disagreement, wrong network/wallet, multiple receivers and ledger review fail closed', () => {
  for (const changed of [{ balance: '1' }, { genesis: 'devnet' }, { wallet: 'wrong' }, { slot: 451299000 }])
    assert.equal(evaluateReserveCoverage(platform, [observation(), { ...observation(), ...changed }]).status, 'UNVERIFIED')
  assert.equal(evaluateReserveCoverage({ ...platform, custodyWallets: [...platform.custodyWallets, 'other'] }, [observation(), observation()]).status, 'UNVERIFIED')
  assert.equal(evaluateReserveCoverage({ ...platform, status: 'REVIEW' }, [observation(), observation()]).status, 'UNVERIFIED')
})

test('reader requests finalized balances on two mainnet RPCs and does not leak connection errors', async () => {
  const env = { SOLANA_RPC_URL: 'https://primary.invalid', GRADUATION_VERIFICATION_RPC_URL: 'https://independent.invalid' }
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(url)
    const requests = JSON.parse(options.body)
    assert.equal(requests[1].params[1].commitment, 'finalized')
    assert.equal(options.cache, 'no-store')
    return { ok: true, json: async () => [
      { id: 2, result: { context: { slot: observation().slot }, value: 6990122 } },
      { id: 1, result: observation().genesis },
    ] }
  }
  assert.equal((await readReserveCoverage(platform, { env, fetchImpl })).status, 'SHORTFALL')
  assert.equal(new Set(calls).size, 2)
  assert.deepEqual(await readReserveCoverage(platform, { env, fetchImpl: async () => { throw Error('secret endpoint') } }), { status: 'UNVERIFIED' })
  assert.deepEqual(await readReserveCoverage(platform, { env: { ...env, GRADUATION_VERIFICATION_RPC_URL: env.SOLANA_RPC_URL }, fetchImpl }), { status: 'UNVERIFIED' })
})
