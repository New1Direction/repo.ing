// A review's blockhash lifetime needs both providers: the second must hold the same blockhash at the same slot, and its
// height + 150 must be the lastValidBlockHeight the first gave (src/hooklab-blockhash-proof.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { provenLatestBlockhash } from '../src/hooklab-blockhash-proof.mjs'

const hash = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn', other = '8sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn'
function providers({ lastValid = 1250, blockhash = hash, blockHeight = 1100, block = true } = {}) {
  const asked = []
  const first = { getLatestBlockhashAndContext: async config => { asked.push(['first', config]); return { context: { slot: 1234 }, value: { blockhash: hash, lastValidBlockHeight: lastValid } } },
    getBlock: async () => { throw Error('the first provider never proves its own answer') } }
  const second = { getLatestBlockhashAndContext: async () => { throw Error('the second provider only proves') },
    getBlock: async (slot, config) => { asked.push(['second', slot, config]); return block ? { blockhash, blockHeight, parentSlot: slot - 1 } : null } }
  return { asked, connections: [{ provider: 'a', connection: first }, { provider: 'b', connection: second }] }
}

test('the first provider names the blockhash; the second proves its block and lifetime', async () => {
  const { asked, connections } = providers()
  assert.deepEqual(await provenLatestBlockhash(connections, { minContextSlot: 1200 }), { context: { slot: 1234 }, value: { blockhash: hash, lastValidBlockHeight: 1250 } })
  assert.deepEqual(asked, [['first', { commitment: 'finalized', minContextSlot: 1200 }],
    ['second', 1234, { commitment: 'finalized', maxSupportedTransactionVersion: 0, transactionDetails: 'none', rewards: false }]])
})

test('a shortened or stretched lifetime, another block or no block is refused', async () => {
  for (const change of [{ lastValid: 1110 }, { lastValid: 1251 }, { blockhash: other }, { blockHeight: 1099 }, { block: false }, { blockHeight: -1 }])
    await assert.rejects(provenLatestBlockhash(providers(change).connections, { minContextSlot: 0 }), /not proven/, JSON.stringify(change))
  await assert.rejects(provenLatestBlockhash(providers().connections.slice(0, 1), { minContextSlot: 0 }), /Two providers/)
})
