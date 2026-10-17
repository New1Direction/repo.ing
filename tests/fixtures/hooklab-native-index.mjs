import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { HOOK_MAINNET_GENESIS } from '../../src/hooklab-execution-contract.mjs'

export const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
export function nativeIndexFixture() {
  const manifest = { schema: 'repoing/hook-index/1', genesisHash: HOOK_MAINNET_GENESIS,
    sourceCommit: 'a'.repeat(40), profileSha256: 'b'.repeat(64), idlSha256: 'c'.repeat(64),
    startSlot: 100, programs: [key(1)], providers: ['alpha', 'beta'] }
  const tx = (n, invoked, failed = false) => ({ version: 0,
    transaction: { signatures: [bs58.encode(Buffer.alloc(64, n))], message: {
      accountKeys: [key(2), key(3)], addressTableLookups: [{ accountKey: key(4), writableIndexes: [], readonlyIndexes: [0] }],
      instructions: [{ programIdIndex: 1, accounts: [], data: '' }],
    } }, meta: { fee: 5000, err: failed ? { InstructionError: [0, 'Custom'] } : null,
      preBalances: [10000, 1, 1], postBalances: [5000, 1, 1],
      loadedAddresses: { writable: [], readonly: [key(1)] },
      innerInstructions: invoked ? [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [], data: '' }] }] : [],
    } })
  const blocks = new Map([[100, { blockhash: key(10), previousBlockhash: key(9), parentSlot: 99,
    transactions: [tx(10, true), tx(11, false)] }],
  [102, { blockhash: key(12), previousBlockhash: key(10), parentSlot: 100, transactions: [tx(12, true, true)] }]])
  const read = async (method, params) => {
    if (method === 'getGenesisHash') return manifest.genesisHash
    if (method === 'getSlot') return 102
    if (method === 'getFirstAvailableBlock') return 1
    if (method === 'getBlocks') return [...blocks.keys()].filter(s => s >= params[0] && s <= params[1])
    if (method === 'getBlock') return structuredClone(blocks.get(params[0]) ?? null)
    throw Error('Forbidden method')
  }
  return { manifest, blocks, adapters: manifest.providers.map(provider => ({ provider, read: async (...args) => read(...args) })) }
}
