// Deterministic synthetic evidence only. No private artifacts or network connections.
import assert from 'node:assert/strict'
import { Keypair, VersionedTransaction, VersionedMessage } from '@solana/web3.js'
import bs58 from 'bs58'
import { fixture, key, pk } from './selected-hook-preparation.mjs'
import { deriveCustomPreparationRecord } from '../../src/hooklab-custom-preparation-receipts.mjs'

export function selectedHookPreparationReceiptFixture(input = fixture()) {
  const record = deriveCustomPreparationRecord(input, input.profile.expectedSha256)
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(record.plan.review.messageBase64, 'base64')))
  tx.sign([31, 33].map(n => Keypair.fromSeed(Buffer.alloc(32, n))))
  const signedTransactionBase64 = Buffer.from(tx.serialize()).toString('base64')
  const preBalances = record.plan.review.accounts.map(a => a.address === input.request.selectedConfig ? '0' : '10000000')
  const postBalances = record.plan.review.accounts.map((a, i) => a.address === input.request.selectedConfig ? '2000' : a.address === input.request.creator ? '9988000' : preBalances[i])
  const config = Buffer.from(record.expectedAccounts.selectedConfig.canonicalTemplateBase64, 'base64')
  config.writeBigInt64LE(1700000001n, 8 + 1 + 32 + 22 + 2 + 33 + 2 + 4 + Buffer.byteLength(input.request.label))
  const state = (role, e, dataBase64 = e.dataBase64) => ({ role, address: e.address, owner: e.owner, executable: e.executable, dataBase64, lamports: '2000' })
  const observations = input.profile.providers.map(provider => ({ provider, genesisHash: input.recentBlockhash.genesisHash,
    transactionCommitment: 'finalized', blockCommitment: 'finalized', errorCode: null,
    transaction: { slot: 110, blockTime: 1700000000, signedTransactionBase64, loadedAddresses: { writable: [], readonly: [] }, feeLamports: '10000', err: null, preBalances: [...preBalances], postBalances: [...postBalances] },
    block: { slot: 110, blockhash: key(80), previousBlockhash: key(81), parentSlot: 109, blockHeight: 110, blockTime: 1700000000, signatures: [bs58.encode(tx.signatures[0])] },
    snapshot: { slot: 120, commitment: 'finalized', accounts: [state('selectedConfig', record.expectedAccounts.selectedConfig, config.toString('base64')), state('registry', record.committedAccounts.registry)] },
    programSnapshot: { slot: 120, commitment: 'finalized', accounts: ['launch', 'hook', 'launchProgramData', 'hookProgramData'].map(role => {
      const e = input.observations[0].accounts.find(a => a.address === record.plan.addresses[role]).account
      return state(role, e)
    }).concat(input.selectedAuthorityEvidence?.authority.kind==='timelocked'?['timelock','executor','executorProgramData'].map(role=>state(role,input.selectedAuthorityEvidence.authority[role])):[]) }, absenceSnapshot: { slot: 120, commitment: 'finalized', accounts: record.expectedAbsent.map(address => ({ address, exists: false })) } }))
  return { preparationInput: input, expectedProfileSha256: input.profile.expectedSha256, expectedProviders: input.profile.providers,
    evidenceMode: 'synthetic-fixture', signedTransactionBase64, observations }
}

export function selectedHookPreparationRpcProviders(f, { beforeRead = async () => {} } = {}) {
  const calls = []
  const providers = f.expectedProviders.map((provider, i) => {
    const read = async method => { calls.push({ provider, method }); await beforeRead(method) }
    const connection = {
      rpcEndpoint: `https://${provider}.example.invalid`,
      async getGenesisHash() { await read('getGenesisHash'); return f.observations[i].genesisHash },
      async getTransaction() {
        await read('getTransaction')
        const o = f.observations[i].transaction
        if (!o) return null
        const tx = VersionedTransaction.deserialize(Buffer.from(o.signedTransactionBase64, 'base64'))
        return { slot: o.slot, blockTime: o.blockTime, transaction: { message: tx.message, signatures: tx.signatures.map(s => bs58.encode(s)) },
          meta: { fee: Number(o.feeLamports), err: o.err, loadedAddresses: { writable: [], readonly: [] }, preBalances: o.preBalances.map(Number), postBalances: o.postBalances.map(Number) } }
      },
      async getBlockSignatures() { await read('getBlockSignatures'); return f.observations[i].block },
      async getMultipleAccountsInfoAndContext(keys) {
        await read('getMultipleAccountsInfoAndContext'); assert.equal(keys.length, 4+f.observations[i].programSnapshot.accounts.length)
        const o = f.observations[i], accounts = [...o.snapshot.accounts, ...o.programSnapshot.accounts]
        return { context: { slot: 120 }, value: keys.map(k => {
          const a = accounts.find(a => a.address === k.toBase58())
          return a ? { owner: pk(a.owner), executable: a.executable, data: Buffer.from(a.dataBase64, 'base64'), lamports: Number(a.lamports) } : null
        }) }
      },
    }
    // Any capability beyond the four read-only methods fails immediately.
    return { provider, connection: new Proxy(connection, { get(target, name) {
      if (!(name in target)) throw Error(`Unexpected RPC capability: ${String(name)}`)
      return target[name]
    } }) }
  })
  return { providers, calls }
}
