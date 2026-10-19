// Regression for the native-launch review's F1b (feat/hooks-native-launch): turning on the native-launches switch (launch
// Config byte 186) steers new launches only. A coin launched bridged before the switch keeps trading on the website after
// it: the bridged trade compiler accepts the switched-on Config, and the chain executes the buy it builds. Isolated
// LiteSVM bank on the reviewed native ELFs (HOOKLAB_NATIVE_ELF_DIR); synthetic keys, no RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileInclusiveMaxWalletSwapReview } from '../src/hooklab-inclusive-max-wallet-swap.mjs'
import { LAUNCH_CONFIG_RESERVED_AT } from '../src/hooklab-launch-config-reserved.mjs'
import { nativeWorld, NATIVE_SKIP } from './fixtures/hooklab-native-world.mjs'

test('website trading of an existing bridged coin continues after the native-launches switch is turned on', { skip: NATIVE_SKIP, timeout: 180000 }, async t => {
  const w = await nativeWorld({ coin: 'bridged' }); t.after(w.close)
  const { state, roles, svm, addresses: a } = w, profile = JSON.parse(state.profile.json)
  const switchByte = () => Buffer.from(state.accounts.get(a.launchConfig).dataBase64, 'base64')[LAUNCH_CONFIG_RESERVED_AT]
  // The creator holds bridged SOL and an empty coin holding, as after Add SOL.
  const holdings = [state.holding(roles.mint, roles.creator, 0), state.holding(profile.quoteMint, roles.creator, 10000000)]
  await svm.call('set', { accounts: holdings.map(address => ({ address, account: state.accounts.get(address) })) }); await w.sync()
  // A production (non-canary) buy has one signer: its network fee basis is one signature.
  const buy = () => { const x = state.tradeInput('buy', '1000200'); x.recentBlockhash = { ...x.recentBlockhash, networkFeeLamports: '5000' }; return x }
  assert.equal(switchByte(), 0); assert.ok(compileInclusiveMaxWalletSwapReview(buy()), 'switch off: the bridged buy compiles')

  await w.switchNativeLaunches()
  assert.equal(switchByte(), 1)
  const plan = compileInclusiveMaxWalletSwapReview(buy())
  assert.ok(plan, 'switch on: the website still compiles the bridged buy')
  const bought = await w.send(plan.review.messageBase64)
  assert.equal(bought.error, null, `and the chain executes it: ${bought.logs?.slice(-6).join(' | ')}`)
})
