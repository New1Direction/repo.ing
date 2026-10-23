import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { readGraduationState } from '../src/graduation-state.mjs'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/recovered-curve-public-accounts.json', import.meta.url)))
const { binding } = fixture
const rpc = rpcEndpoint => ({ rpcEndpoint,
  getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  getMultipleAccountsInfoAndContext: async () => ({ context: { slot: fixture.slot }, value: fixture.accounts.map(a => ({ owner: new PublicKey(a.owner), data: Buffer.from(a.data, 'base64') })) }),
  getBlockTime: async () => Math.floor(Date.now() / 1000),
})
test('fresh public progress accepts only the exact approved recovered curve owner', async () => {
  const input = { connection: rpc('https://primary.invalid'), verification: rpc('https://secondary.invalid'), config: binding.config,
    market: { repoId: binding.repoId, mint: binding.mint, pool: binding.curve, creatorWallet: binding.previousOwner }, env: { NODE_ENV: 'production' } }
  await assert.rejects(readGraduationState(input), /CONFIG_OR_POOL_MISMATCH/)
  const manifest = { version: 1, poolCreators: [binding], positions: [] }
  const state = await readGraduationState({ ...input, custodyRecovery: manifest })
  assert.equal(state.phase, 'CURVE')
  assert.equal(state.curve, binding.curve)
  assert(BigInt(state.reserveLamports) < BigInt(state.thresholdLamports))
  await assert.rejects(readGraduationState({ ...input, custodyRecovery: { ...manifest, poolCreators: [{ ...binding, repoId: '1' }] } }), /custody binding/)
  await assert.rejects(readGraduationState({ ...input, custodyRecovery: { ...manifest, poolCreators: [{ ...binding, owner: binding.mint }] } }), /CONFIG_OR_POOL_MISMATCH/)
})
