// Open creation (launch Config byte 187 and its menus) steers new launches only: an existing native coin keeps trading on
// the website once it is on, under an operator bundle that pins both configs as production does (config-counters-v1): the
// governed switch and menu bytes may move, nothing else in the Config may. Isolated SBF bank on the reviewed native ELFs
// (HOOKLAB_NATIVE_ELF_DIR); the open-creation bytes are written into the bank's launch Config as the governed stage will
// leave them. Synthetic keys, no RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { nativeTradeResolver } from '../src/hooklab-native-trade-resolver.mjs'
import { encodeOpenCreationReserved, parseLaunchConfigReserved, LAUNCH_CONFIG_RESERVED_AT } from '../src/hooklab-launch-config-reserved.mjs'
import { nativeWorld, NATIVE_SKIP } from './fixtures/hooklab-native-world.mjs'

const LIMITS = { maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: 0, reviewExpiresAtMs: 0, maxNetworkFeeLamports: '10000', maxTotalDebitLamports: '10000', computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' }
const CAP_BPS = 5000
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
// Both config pins as a production bundle binds them: the approved bytes, monotonic counters, the IDL that decodes them.
function productionConfigBindings(bindings, state) {
  const dossier = JSON.parse(bindings.dossierJson)
  dossier.accounts = dossier.accounts.map(pin => ['launch-config', 'swap-config'].includes(pin.role) ? { ...pin, binding: 'config-counters-v1',
    approvedDataBase64: state.accounts.get(pin.address).dataBase64, idlSha256: sha(Buffer.from(bindings.profile.idls[pin.role.split('-')[0]], 'base64')) } : pin)
  const dossierJson = JSON.stringify(dossier)
  return { ...bindings, dossierJson, config: { ...bindings.config, dossierSha256: sha(dossierJson) } }
}

test('a native coin keeps trading on the website once open creation is on', { skip: NATIVE_SKIP, timeout: 300000 }, async t => {
  const w = await nativeWorld({ capBps: CAP_BPS }); t.after(w.close)
  const { roles, addresses: a, state } = w, bindings = productionConfigBindings(w.bindings, state)
  const config = state.accounts.get(a.launchConfig)
  const setReserved = async reserved => { const bytes = Buffer.from(config.dataBase64, 'base64'); Buffer.from(reserved).copy(bytes, LAUNCH_CONFIG_RESERVED_AT)
    await w.svm.call('set', { accounts: [{ address: a.launchConfig, account: { ...config, dataBase64: bytes.toString('base64') } }] }); await w.sync([a.launchConfig]) }
  await setReserved(encodeOpenCreationReserved({ native: true, open: true, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] }))
  assert.deepEqual(parseLaunchConfigReserved(Buffer.from(state.accounts.get(a.launchConfig).dataBase64, 'base64').subarray(LAUNCH_CONFIG_RESERVED_AT)),
    { native: true, open: true, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] })
  const resolver = nativeTradeResolver({ ...bindings, connections: w.connections(), limits: { ...LIMITS, nowMs: 1800000000000 }, clock: () => 1000 })
  const amount = 1000003, minAmountOut = await w.minimumOut('buy', amount, roles.creator)
  const buy = () => resolver.prepare({ owner: roles.creator, stage: 'native-buy', intent: { side: 'buy', creatorFeeBps: 100, capBps: CAP_BPS, mint: roles.mint, selectedConfig: roles.config,
    amountIn: String(amount), minAmountOut, maxInput: String(amount), maxPriceImpactBps: 1000, graduate: false } })
  const sent = await w.send((await buy()).review.messageBase64)
  assert.equal(sent.error, null, `the bank executes the buy: ${sent.logs?.slice(-6).join(' | ')}`)
  // Open creation off again (the menus kept): still trading. A reserved state the programs never write: refused.
  await setReserved(encodeOpenCreationReserved({ native: true, open: false, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] }))
  assert.ok(await buy())
  await setReserved([1, 2, ...Array(62).fill(0)])
  await assert.rejects(buy(), /operator pins changed/)
})
