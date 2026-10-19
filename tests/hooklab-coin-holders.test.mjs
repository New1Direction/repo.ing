// A Hooks coin's holders from the token program's holdings (getProgramAccounts, read-only fixture of the canary), with
// the curve and launch reserve labelled and every listed account checked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { hookActivityRpc, hookHolderLabels, readHookCoinHolders } from '../src/hooklab-coin-activity.mjs'
import { hookCoinAddresses } from '../src/hooklab-inclusive-max-wallet-swap.mjs'
import { PROGRAMS, QUOTE_MINT, holdingAddress } from '../src/hooklab-owner-driver/pins.mjs'
import { canary, canaryConnection, clone } from './fixtures/hooklab-canary-trades.mjs'

const mint = canary.mint, supply = '1000000000000000'
const addresses = hookCoinAddresses({ programs: PROGRAMS, quoteMint: QUOTE_MINT }, mint)
const trader = 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9', other = 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i'
// A holding row as the RPC returns it (first 82 bytes, base64), built from a real one with another owner and amount.
function holdingRow(owner, amount, { holding = holdingAddress(mint, owner), edit = bytes => bytes } = {}) {
  const template = canary.holdings.value.find(row => row.pubkey === addresses.baseVault)
  const bytes = Buffer.from(template.account.data[0], 'base64')
  new PublicKey(owner).toBuffer().copy(bytes, 42); bytes.writeBigUInt64LE(BigInt(amount), 74)
  return { pubkey: holding, account: { ...template.account, data: [edit(bytes).toString('base64'), 'base64'] } }
}
const holdersOf = (rows, options = {}) => {
  const holdings = clone(canary.holdings); holdings.value.push(...rows)
  const calls = []
  return { calls, read: readHookCoinHolders({ rpc: hookActivityRpc(canaryConnection({ holdings, calls })), mint, supply, labels: hookHolderLabels(addresses), ...options }) }
}

test('the canary: the curve and the launch reserve, labelled; empty holdings left out', async () => {
  const { calls, read } = holdersOf([])
  assert.deepEqual(await read, { observedSlot: 458763266, supply, holderCount: 0, holders: [
    { rank: null, owner: addresses.pool, holding: addresses.baseVault, amount: '750000000000000', percent: 75, label: 'Bonding curve' },
    { rank: null, owner: addresses.launch, holding: addresses.launchReserve, amount: '250000000000000', percent: 25, label: 'Launch reserve' }] })
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'getProgramAccounts')
  assert.deepEqual(calls[0].params, [PROGRAMS.token, { commitment: 'confirmed', encoding: 'base64', withContext: true,
    dataSlice: { offset: 0, length: 82 }, filters: [{ dataSize: 204 }, { memcmp: { offset: 10, bytes: mint, encoding: 'base58' } }] }])
})

test('traders are ranked by balance with their share of supply; after graduation the pool reads as the pool', async () => {
  const { read } = holdersOf([holdingRow(other, '5000000000'), holdingRow(trader, '12345678000000')], { limit: 1 })
  const result = await read
  assert.equal(result.holderCount, 2, 'every holder with a balance counts')
  assert.deepEqual(result.holders.map(h => [h.rank, h.label ?? h.owner, h.percent]), [[null, 'Bonding curve', 75], [null, 'Launch reserve', 25], [1, trader, 1.2345]])
  const graduated = await readHookCoinHolders({ rpc: hookActivityRpc(canaryConnection()), mint, supply, labels: hookHolderLabels(addresses, { graduated: true }) })
  assert.equal(graduated.holders[0].label, 'Liquidity pool')
})

test('accounts that are not this coin’s holdings stop the read', async () => {
  for (const row of [
    holdingRow(trader, '1', { holding: holdingAddress(QUOTE_MINT, trader) }),
    holdingRow(trader, '1', { edit: bytes => { bytes[0] ^= 1; return bytes } }),
    holdingRow(trader, '1', { edit: bytes => { new PublicKey(QUOTE_MINT).toBuffer().copy(bytes, 10); return bytes } }),
    { ...holdingRow(trader, '1'), account: { ...holdingRow(trader, '1').account, owner: PROGRAMS.swap } },
    { ...holdingRow(trader, '1'), account: { ...holdingRow(trader, '1').account, data: [Buffer.alloc(204).toString('base64'), 'base64'] } },
  ]) await assert.rejects(holdersOf([row]).read, /HOOK_HOLDERS_ACCOUNT_INVALID/)
  await assert.rejects(readHookCoinHolders({ rpc: hookActivityRpc(canaryConnection()), mint, supply: '0' }), /HOOK_HOLDERS_SUPPLY_INVALID/)
})
