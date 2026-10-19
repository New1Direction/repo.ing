// Turning open creation on (launch Config byte 187 and its menus) must not stop any existing compiler: the bridged (v3)
// and native (v4) launch compilers still compile the same message for the same review. Synthetic canary state over the
// pinned ELFs (HOOKLAB_CANARY_ELF_DIR, HOOKLAB_NATIVE_ELF_DIR); no RPC, no bank. Preparation: tests/hooklab-launch-config-
// reserved.test.mjs (F1a); bridged trades: tests/hooklab-inclusive-trade-settlement.test.mjs; native trades:
// tests/hooklab-native-open-creation-svm.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { compileCanaryMaxWalletLaunchReview, compileMaxWalletLaunchReview } from '../src/hooklab-max-wallet-launch.mjs'
import { encodeOpenCreationReserved } from '../src/hooklab-launch-config-reserved.mjs'
import { makeCanaryState, localTestEnvironment } from './fixtures/hooklab-canary.mjs'
import { missingArtifactEnv } from './fixtures/hooklab-generated-artifact.mjs'

const ROLES = ['creator', 'admin', 'upgrade', 'guardian', 'treasury', 'outsider', 'buyer', 'mint', 'config', 'table']
const roles = () => Object.fromEntries(ROLES.map(r => [r, Keypair.generate().publicKey.toBase58()]))
const OWNER_MENUS = { creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] }
function withLocalAcceptance(run) {
  const env = localTestEnvironment(), saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  try { return run() } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v }
}
// The launch Config's reserved bytes set in the state, so the next launch input reads (and pins) them.
function setReserved(state, reserved) {
  const config = [...state.accounts.values()].find(a => a.owner === JSON.parse(state.profile.json).programs.launch && Buffer.from(a.dataBase64, 'base64').length === 250)
  const bytes = Buffer.from(config.dataBase64, 'base64'); reserved.copy(bytes, 186); config.dataBase64 = bytes.toString('base64')
}

test('the bridged canary launch compiles the same message with open creation on', { skip: missingArtifactEnv(['HOOKLAB_CANARY_ELF_DIR'], 'the pinned bundle-2 ELFs') }, () => withLocalAcceptance(() => {
  const state = makeCanaryState({ elfDirectory: process.env.HOOKLAB_CANARY_ELF_DIR, roles: roles(), blockhash: bs58.encode(Keypair.generate().publicKey.toBuffer()) })
  const before = compileCanaryMaxWalletLaunchReview(state.launchInputNow()).review.messageBase64
  setReserved(state, encodeOpenCreationReserved({ native: false, open: true, ...OWNER_MENUS }))
  assert.equal(compileCanaryMaxWalletLaunchReview(state.launchInputNow()).review.messageBase64, before)
  setReserved(state, Buffer.from([0, 2, ...Array(62).fill(0)]))
  assert.throws(() => compileCanaryMaxWalletLaunchReview(state.launchInputNow()), /reserved/)
}))

test('the native v4 launch compiles the same message with open creation on', { skip: missingArtifactEnv(['HOOKLAB_NATIVE_ELF_DIR'], 'the reviewed native ELFs') }, () => withLocalAcceptance(() => {
  const state = makeCanaryState({ elfDirectory: process.env.HOOKLAB_NATIVE_ELF_DIR, roles: roles(), blockhash: bs58.encode(Keypair.generate().publicKey.toBuffer()), native: true })
  setReserved(state, encodeOpenCreationReserved({ native: true, open: false, creatorFeeBps: [], capBps: [] }))
  const before = compileMaxWalletLaunchReview({ ...state.launchInputNow(), nativeLaunches: true }).review.messageBase64
  setReserved(state, encodeOpenCreationReserved({ native: true, open: true, ...OWNER_MENUS }))
  assert.equal(compileMaxWalletLaunchReview({ ...state.launchInputNow(), nativeLaunches: true }).review.messageBase64, before)
}))
