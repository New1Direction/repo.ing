// Adapter for actual exported LiteSVM snapshots only; never fabricates account state or release pins.
import { inclusiveMaxWalletSwapInventory, inclusiveMaxWalletSwapRequestSchema } from '../../src/hooklab-inclusive-max-wallet-swap.mjs'
export function inclusiveMaxWalletSwapFixtureFromVmState(state, profile, requestInput) {
  if (state.synthetic !== true || state.signaturesVerified !== false || state.canSign !== false || state.canSubmit !== false
    || state.artifactAdopted !== false || state.publicExecutionEnabled !== false) throw Error('Explicit fixture-only VM state required')
  const p = JSON.parse(profile.json), request = inclusiveMaxWalletSwapRequestSchema.parse(requestInput)
  const map = new Map(state.accounts.map(({ pubkey: address, account }) => [address, account && { address, owner: account.owner,
    executable: account.executable, dataBase64: account.dataBase64, lamports: account.lamports }]))
  if (map.size !== state.accounts.length) throw Error('Duplicate VM account')
  const accounts = inclusiveMaxWalletSwapInventory(p, request).map(address => {
    if (!map.has(address)) throw Error(`VM snapshot omitted requested account ${address}`)
    return { address, account: map.get(address) }
  })
  const slot = Number(state.slot), providers = profile.providers, networkFee = request.trader === request.feePayer ? '5000' : '10000'
  return { profile, request, provenance: 'disposable-litesvm-synthetic-fixture-not-rpc-evidence',
    observations: providers.map(provider => ({ provider, genesisHash: p.genesisHash, commitment: 'finalized', slot, observedAtMs: 1000, accounts: structuredClone(accounts) })),
    recentBlockhash: { blockhash: state.blockhash, genesisHash: p.genesisHash, providers, observedAtMs: 1000, currentBlockHeight: Number(state.blockHeight),
      blockhashValid: true, lastValidBlockHeight: Number(state.blockHeight) + 150, observedSlot: slot, networkFeeLamports: networkFee, lamportsPerSignature: '5000' },
    lookupTable: null, limits: { nowMs: 1000, maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: slot + 50, reviewExpiresAtMs: 6000,
      maxNetworkFeeLamports: networkFee, maxTotalDebitLamports: networkFee, computeUnitLimit: 600000, computeUnitPriceMicroLamports: '0' } }
}
