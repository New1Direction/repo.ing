// The owner driver's activation stages refuse unless both configs route the platform's money to the configured treasury
// and quote with the stack's marker: launch Config treasury and quote_mint, swap Config treasury and fee_collector
// (owner blocker 3; hook-lab independent delta review L-3). No RPC: two fake providers serve the two Config accounts,
// encoded with hook-lab's independent build's own IDLs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BorshCoder } from '@anchor-lang/core'
import { Keypair, PublicKey } from '@solana/web3.js'
import { derivedAddresses } from '../src/hooklab-owner-driver/pins.mjs'
import { routingProblems, checkMoneyRouting } from '../src/hooklab-owner-driver/stages/money-routing.mjs'
import { nativeLaunches } from '../src/hooklab-owner-driver/stages/native-launches.mjs'
import { openCreation } from '../src/hooklab-owner-driver/stages/open-creation.mjs'
import { adminStages } from '../src/hooklab-owner-driver/stages/admin.mjs'
import { independentStack, INDEPENDENT_SKIP } from './fixtures/hooklab-independent-stack.mjs'

const key = () => Keypair.generate().publicKey
const treasury = key(), marker = key(), other = key()
const configs = (over = {}) => ({
  launch: { treasury: over.launchTreasury ?? treasury, quote_mint: over.quoteMint ?? marker },
  swap: { treasury: over.swapTreasury ?? treasury, fee_collector: over.feeCollector ?? treasury },
})
const ctxFor = () => ({ roles: { treasury: treasury.toBase58() }, quoteMint: marker.toBase58() })

test('routing: the configured treasury in all three places and the marker as the quote pass', () => {
  const c = configs()
  assert.deepEqual(routingProblems(ctxFor(), c.launch, c.swap), [])
})

test('routing: every mismatch is named, alone and together', () => {
  const cases = [['launchTreasury', /launch Config treasury/], ['quoteMint', /launch Config quote_mint/], ['swapTreasury', /swap Config treasury/],
    ['feeCollector', /swap Config fee_collector/]]
  for (const [field, message] of cases) {
    const c = configs({ [field]: other }), problems = routingProblems(ctxFor(), c.launch, c.swap)
    assert.equal(problems.length, 1, field)
    assert.match(problems[0], message)
  }
  const all = configs({ launchTreasury: other, quoteMint: other, swapTreasury: other, feeCollector: other })
  assert.equal(routingProblems(ctxFor(), all.launch, all.swap).length, 4)
})

// Fake providers: both answer the same finalized accounts at the same slot.
function readersFor(accounts) {
  const connection = {
    async getMultipleAccountsInfoAndContext(keys) {
      return { context: { slot: 1000 }, value: keys.map(k => accounts.get(k.toBase58()) ?? null) }
    },
  }
  return [{ provider: 'a', connection }, { provider: 'b', connection }]
}

// The two Config accounts as the independent programs write them (every other field zero), served by both providers.
async function contextWith({ launchTreasury = treasury, quoteMint = marker, swapTreasury = treasury, feeCollector = treasury } = {}) {
  const { stack, idls } = independentStack()
  const abi = { idls: { launch: JSON.parse(idls.launch), swap: JSON.parse(idls.swap) }, coders: {} }
  for (const role of ['launch', 'swap']) abi.coders[role] = new BorshCoder(abi.idls[role])
  const programs = { ...stack.programs }, d = derivedAddresses(programs, marker.toBase58())
  const config = async (role, fields) => {
    const coder = abi.coders[role].accounts, blank = coder.decodeUnchecked('Config', Buffer.alloc(1024))
    return { owner: new PublicKey(programs[role]), executable: false, lamports: 2_000_000, data: await coder.encode('Config', { ...blank, ...fields }) }
  }
  const accounts = new Map([
    [d.launchConfig, await config('launch', { treasury: launchTreasury, quote_mint: quoteMint })],
    [d.swapConfig, await config('swap', { treasury: swapTreasury, fee_collector: feeCollector })],
  ])
  return { programs, quoteMint: marker.toBase58(), roles: { treasury: treasury.toBase58(), admin: key().toBase58(), payer: key().toBase58() },
    readers: readersFor(accounts), genesis: 'localgenesis1111111111111111111111111111111', abi, options: {},
    stack: { build: { open: true, name: 'independent' } }, config: { decisions: {} } }
}

test('checkMoneyRouting reads both configs again and refuses a wrong treasury, fee collector or quote mint', { skip: INDEPENDENT_SKIP }, async () => {
  assert.equal(await checkMoneyRouting(await contextWith(), 'open-trading'), null)
  for (const over of [{ launchTreasury: other }, { swapTreasury: other }, { feeCollector: other }, { quoteMint: other }]) {
    const refusal = await checkMoneyRouting(await contextWith(over), 'open-trading')
    assert.match(refusal.blocked, /^open-trading: refusing to activate: /, JSON.stringify(Object.keys(over)))
  }
})

test('every activation stage refuses before compiling when the money is routed elsewhere', { skip: INDEPENDENT_SKIP }, async () => {
  const runs = [
    ['native-launches --to on', nativeLaunches, { to: 'on' }],
    ['open-creation --to on', openCreation, { to: 'on' }],
    ['open-launches', adminStages['open-launches'], {}],
    ['open-trading', adminStages['open-trading'], {}],
  ]
  for (const [label, stage, options] of runs) {
    const ctx = await contextWith({ feeCollector: other })
    const built = await stage.build({ ...ctx, options })
    assert.match(built.blocked ?? '', /refusing to activate: swap Config fee_collector/, label)
    assert.equal(built.review, undefined, `${label}: nothing compiled`)
  }
})

test('deactivation stages are not held back by the routing check (an emergency stop always works)', () => {
  assert.equal(adminStages['close-trading'].activates, false)
  assert.equal(adminStages['close-launches'].activates, false)
  assert.equal(adminStages['open-trading'].activates, true)
  assert.equal(adminStages['open-launches'].activates, true)
})
