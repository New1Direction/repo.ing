// Frozen executed SBF state. Synthetic fixtures only; no generated keys, signatures or RPC.
import { readFileSync } from 'node:fs'
import { generatedMaxWalletArtifact } from './hooklab-generated-artifact.mjs'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { maxWalletPreparationRequestSchema } from '../../src/hooklab-max-wallet-preparation.mjs'
export const sha = b => createHash('sha256').update(b).digest('hex')
const read = path => readFileSync(new URL(path, import.meta.url))
const bytes = readFileSync(generatedMaxWalletArtifact('hooklab-max-wallet-rust-vector.json', import.meta.url)), vector = JSON.parse(bytes)
const profileJson = read('../../vendor/hooklab-event-abi/max-wallet-candidate/offline-builder-profile.json').toString()
const profile = JSON.parse(profileJson)
const idls = Object.fromEntries([['launch', 'bordrless_launch'], ['swap', 'bordrless_swap'], ['gate', 'hook_max_wallet']]
  .map(([role, name]) => [role, read(`../../vendor/hooklab-event-abi/max-wallet-candidate/${name}.json`).toString('base64')]))
export const pk = value => new PublicKey(value)
export const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[0].toBase58()
export const maxWalletRustVector = () => structuredClone(vector)
export const maxWalletFrozenPins = Object.freeze({ vectorSha256: '1c7b0bbd26faab7246f0e5c0ef3f58b0f56d93313c4dd368ed9861a1f23a2962',
  profileSha256: 'f366d222e7257e86ac23d8350741b3c20c08ea084a4445c7b0d2d913593b5ea0', sourcePatchSha256: 'd1c5447d6e4c0400ad641679cb0e409425f2ce1ef9aaf6500611215f3491c13f' })
if (sha(bytes) !== maxWalletFrozenPins.vectorSha256 || sha(profileJson) !== maxWalletFrozenPins.profileSha256) throw Error('Retained max-wallet fixture pin differs')
export const maxWalletProfileEnvelope = () => ({ json: profileJson, expectedSha256: maxWalletFrozenPins.profileSha256, idls: { ...idls },
  elfLengths: { launch: 736344, swap: 528696, gate: 169824 }, providers: ['fixture-a', 'fixture-b'] })
export function maxWalletPreparationRequest() {
  return maxWalletPreparationRequestSchema.parse({ schema: 'repoing/max-wallet-preparation-request/1', policyKind: 'max-wallet', policyVersion: 1,
    creator: vector.request.creator, feePayer: vector.request.payer, mint: vector.request.futureMint, selectedConfig: vector.request.selectedConfig,
    capBps: vector.request.capBps, label: vector.request.label, creatorFeeBps: 0, rules: 'none', hookFlags: 1 })
}
export const maxWalletSnapshot = stage => vector[stage].accountsBefore.map(({ pubkey: address, account }) => ({ address,
  account: account && { address, owner: account.owner, executable: account.executable, lamports: account.lamports, dataBase64: account.dataBase64 } }))
export function maxWalletPreparationFixture() {
  const request = maxWalletPreparationRequest(), { launch: L, gate: G } = profile.programs, loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
  const policy = pda(G, 'policy', pk(request.mint).toBuffer()), registry = pda(G, 'bordrless-hook-accounts', pk(request.mint).toBuffer())
  const pre = new Map(maxWalletSnapshot('preparation').map(a => [a.address, a.account])), post = new Map(maxWalletSnapshot('launch').map(a => [a.address, a.account]))
  const inventory = [L, G, pda(loader, pk(L).toBuffer()), pda(loader, pk(G).toBuffer()), pda(L, 'config'), policy, registry,
    request.mint, request.selectedConfig, request.creator, request.feePayer, pda(L, 'launch', pk(request.mint).toBuffer())]
  const rentExemptionLamports = { policy: post.get(policy).lamports, registry: post.get(registry).lamports, selectedConfig: post.get(request.selectedConfig).lamports }
  const rent = Object.values(rentExemptionLamports).reduce((n, x) => n + BigInt(x), 0n), slot = Number(vector.slot), envelope = maxWalletProfileEnvelope()
  delete envelope.idls.swap; delete envelope.elfLengths.swap
  return { profile: envelope, request, observations: envelope.providers.map(provider => ({ provider, genesisHash: profile.genesisHash, commitment: 'finalized',
    slot, observedAtMs: 1000, accounts: inventory.map(address => ({ address, account: structuredClone(pre.get(address) ?? null) })), rentExemptionLamports: { ...rentExemptionLamports } })),
    recentBlockhash: { blockhash: vector.blockhash, genesisHash: profile.genesisHash, providers: envelope.providers, observedAtMs: 1000,
      currentBlockHeight: slot, blockhashValid: true, lastValidBlockHeight: slot + 150, observedSlot: slot, networkFeeLamports: '15000', lamportsPerSignature: '5000' },
    lookupTable: null, limits: { nowMs: 1000, maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: slot + 50, reviewExpiresAtMs: 6000,
      maxRentLamports: String(rent), maxNetworkFeeLamports: '15000', maxTotalDebitLamports: String(rent + 15000n), computeUnitLimit: 600000, computeUnitPriceMicroLamports: '0' } }
}
