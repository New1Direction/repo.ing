// Synthetic RPC readers shared without importing any embedded ELF fixture.
import bs58 from 'bs58'
import { PublicKey,VersionedTransaction } from '@solana/web3.js'
const pk=value=>new PublicKey(value)
export function customPreparationRpcProviders(fixture) {
  const calls = []
  const providers = fixture.expectedProviders.map(provider => {
    const observation = fixture.observations.find(o => o.provider === provider)
    const record = (method, args) => calls.push({ provider, method, args })
    return { provider, connection: {
      rpcEndpoint: `https://${provider}.invalid/fixture-only`,
      async getGenesisHash(...args) { record('getGenesisHash', args); return observation.genesisHash },
      async getTransaction(...args) {
        record('getTransaction', args)
        const t = observation.transaction
        if (!t) return null
        const wire = VersionedTransaction.deserialize(Buffer.from(t.signedTransactionBase64, 'base64'))
        return { slot: t.slot, blockTime: t.blockTime, version: 0,
          transaction: { message: wire.message, signatures: wire.signatures.map(s => bs58.encode(s)) },
          meta: { fee: Number(t.feeLamports), err: structuredClone(t.err), preBalances: t.preBalances.map(Number), postBalances: t.postBalances.map(Number),
            loadedAddresses: { writable: t.loadedAddresses.writable.map(pk), readonly: t.loadedAddresses.readonly.map(pk) } } }
      },
      async getBlock(...args) { record('getBlock', args); if (!observation.block) return null; const { slot, ...block } = observation.block; return structuredClone(block) },
      async getMultipleAccountsInfoAndContext(...args) {
        record('getMultipleAccountsInfoAndContext', args)
        if (!observation.snapshot) return null
        return { context: { slot: observation.snapshot.slot }, value: [...observation.snapshot.accounts, ...observation.programSnapshot.accounts].map(a => ({ owner: pk(a.owner),
          executable: a.executable, data: Buffer.from(a.dataBase64, 'base64'), lamports: Number(a.lamports), rentEpoch: 0 })) }
      },
    } }
  })
  return { providers, calls }
}
