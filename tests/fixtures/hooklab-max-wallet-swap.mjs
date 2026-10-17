// Actual persistent LiteSVM state/quote exports. Entirely synthetic; no signatures or RPC proof.
import { readFileSync } from 'node:fs'
import { generatedMaxWalletArtifact } from './hooklab-generated-artifact.mjs'
import { maxWalletProfileEnvelope, maxWalletPreparationRequest, sha } from './hooklab-max-wallet-preparation.mjs'
import { maxWalletSwapInventory, maxWalletSwapRequestSchema } from '../../src/hooklab-max-wallet-swap.mjs'
export function maxWalletSwapRustVector(side = 'buy') { return JSON.parse(readFileSync(generatedMaxWalletArtifact(`hooklab-max-wallet-${side}-rust-vector.json`, import.meta.url))) }
export function maxWalletSwapFixture(side = 'buy') {
  const state = maxWalletSwapRustVector(side), profile = maxWalletProfileEnvelope(), p = JSON.parse(profile.json), prep = maxWalletPreparationRequest()
  const request = maxWalletSwapRequestSchema.parse({ schema: 'repoing/max-wallet-swap-request/1', policyKind: 'max-wallet', policyVersion: 1,
    capBps: prep.capBps, side, trader: prep.creator, recipient: prep.creator, feePayer: prep.feePayer, mint: prep.mint, selectedConfig: prep.selectedConfig,
    amountIn: state.quote.amountIn, minAmountOut: state.quote.minAmountOut, maxInput: state.quote.amountIn, maxPriceImpactBps: 1000 })
  return maxWalletSwapFixtureFromVmState(state, request)
}
export function maxWalletSwapFixtureFromVmState(state, requestInput) {
  if (!state.synthetic || state.signaturesVerified || state.canSign || state.canSubmit || state.artifactAdopted || state.publicExecutionEnabled) throw Error('Fixture-only VM state required')
  const profile = maxWalletProfileEnvelope(), p = JSON.parse(profile.json), request = maxWalletSwapRequestSchema.parse(requestInput)
  const map = new Map(state.accounts.map(({ pubkey: address, account }) => [address, account && { address, owner: account.owner, executable: account.executable, dataBase64: account.dataBase64, lamports: account.lamports }]))
  const accounts = maxWalletSwapInventory(p, request).map(address => {
    if (!map.has(address)) throw Error(`VM snapshot omitted requested account ${address}`)
    return { address, account: map.get(address) }
  })
  const slot = Number(state.slot), providers = profile.providers
  return { profile, request, provenance: 'disposable-litesvm-synthetic-fixture-not-rpc-evidence',
    observations: providers.map(provider => ({ provider, genesisHash: p.genesisHash, commitment: 'finalized', slot, observedAtMs: 1000, accounts: structuredClone(accounts) })),
    recentBlockhash: { blockhash: state.blockhash, genesisHash: p.genesisHash, providers, observedAtMs: 1000, currentBlockHeight: Number(state.blockHeight),
      blockhashValid: true, lastValidBlockHeight: Number(state.blockHeight) + 150, observedSlot: slot, networkFeeLamports: request.trader === request.feePayer ? '5000' : '10000', lamportsPerSignature: '5000' },
    lookupTable: null, limits: { nowMs: 1000, maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: slot + 50, reviewExpiresAtMs: 6000,
      maxNetworkFeeLamports: request.trader === request.feePayer ? '5000' : '10000', maxTotalDebitLamports: request.trader === request.feePayer ? '5000' : '10000',
      computeUnitLimit: 600000, computeUnitPriceMicroLamports: '0' } }
}
