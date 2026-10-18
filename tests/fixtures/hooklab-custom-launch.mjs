// Retained SBF/LiteSVM state only. Never production evidence, a receipt, or an ALT for live use.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey } from '@solana/web3.js'
import { customPreparationRequestSchema } from '../../src/hooklab-custom-preparation.mjs'
import { generatedCustomArtifact } from './hooklab-generated-artifact.mjs'
const sha = b => createHash('sha256').update(b).digest('hex')
const read = path => readFileSync(new URL(path, import.meta.url))
const idls = { launch: read('../../vendor/hooklab-event-abi/custom-preparation-reuse/bordrless_launch.json'),
  swap: read('../../vendor/hooklab-event-abi/bordrless_swap.json'), gate: read('../../vendor/hooklab-event-abi/custom-production/hook_gate.json') }
// Read lazily: the generated vector is private (HOOKLAB_GENERATED_FIXTURE_DIR), so importing this module never needs it.
let retained
const retainedVector = () => retained ??= JSON.parse(readFileSync(generatedCustomArtifact('hooklab-custom-launch-rust-vector.json', import.meta.url)))
const pk = value => new PublicKey(value)
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[0].toBase58()
const launch = new BorshCoder(JSON.parse(idls.launch))
export const customLaunchRustVector = () => structuredClone(retainedVector())
export function customLaunchFixture() {
  const vector = retainedVector(), profile = JSON.parse(vector.profileJson)
  const decoded = launch.instruction.decode(Buffer.from(vector.expectedInstruction.dataHex, 'hex')).data
  const prep = customPreparationRequestSchema.parse({ schema: 'repoing/custom-preparation-request/1', creator: vector.request.creator, feePayer: vector.request.payer,
    mint: vector.request.futureMint, selectedConfig: vector.request.selectedConfig, blockedOwner: vector.request.blockedOwner, label: vector.request.label,
    creatorFeeBps: 0, rules: 'none', hookFlags: 1 })
  const accounts = structuredClone(vector.accounts), accountMap = new Map(accounts.map(a => [a.address, a.account]))
  const L = profile.programs.launch, S = profile.programs.swap, G = profile.programs.gate
  const config = launch.accounts.decode('Config', Buffer.from(accountMap.get(pda(L, 'config')).dataBase64, 'base64'))
  const request = { ...prep, schema: 'repoing/custom-launch-request/1', reviewer: config.admin.toBase58(), name: decoded.args.name, symbol: decoded.args.symbol,
    uri: decoded.args.uri, virtualQuote: decoded.args.virtual_quote.toString(10) }
  const hashAccount = address => sha(Buffer.from(accountMap.get(address).dataBase64, 'base64'))
  const preparedAccountHashes = { policy: hashAccount(pda(G, 'policy', pk(prep.mint).toBuffer())), registry: hashAccount(pda(G, 'bordrless-hook-accounts', pk(prep.mint).toBuffer())), selectedConfig: hashAccount(prep.selectedConfig) }
  const state = { launchConfig: pda(L, 'config'), swapConfig: pda(S, 'config'), launchGovernance: pda(L, 'governance'), swapGovernance: pda(S, 'governance'), authorization: pda(L, 'creator-authorization', pk(prep.creator).toBuffer()), quoteMint: profile.quoteMint }
  const slot = Number(vector.slot), providers = ['fixture-a', 'fixture-b']
  // This table is deliberately manufactured for offline compilation; never an observed live ALT.
  const addresses = [...new Set(vector.expectedInstruction.keys.filter(k => !k.isSigner).map(k => k.pubkey))]
  const table = Buffer.alloc(56 + 32 * addresses.length)
  table.writeUInt32LE(1); table.writeBigUInt64LE(0xffffffffffffffffn, 4); table.writeBigUInt64LE(BigInt(slot - 1), 12)
  addresses.forEach((a, i) => pk(a).toBuffer().copy(table, 56 + i * 32))
  return { profile: { json: vector.profileJson, expectedSha256: vector.profileSha256,
    idls: Object.fromEntries(Object.entries(idls).map(([k, b]) => [k, b.toString('base64')])),
    elfLengths: { launch: 725544, swap: 528696, gate: 143848 }, providers }, request,
    preparationEvidence: { schema: 'hooklab/synthetic-prepared-state/1', provenance: vector.provenance, status: 'synthetic-prepared',
      productionPreparationReceipt: null, profileSha256: vector.profileSha256, preparationIntentSha256: sha(JSON.stringify(prep)), executionSlot: slot, preparedAccountHashes },
    reviewedStateHashes: Object.fromEntries(Object.entries(state).map(([name, address]) => [name, hashAccount(address)])),
    observations: providers.map(provider => ({ provider, genesisHash: profile.genesisHash, commitment: 'finalized', slot, observedAtMs: 1000, accounts: structuredClone(accounts) })),
    recentBlockhash: { blockhash: vector.blockhash, genesisHash: profile.genesisHash, providers, observedAtMs: 1000, currentBlockHeight: slot, blockhashValid: true,
      lastValidBlockHeight: slot + 150, observedSlot: slot, networkFeeLamports: '15000', lamportsPerSignature: '5000' },
    lookupTable: { address: pk(Buffer.alloc(32, 211)).toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: table.toString('base64'), sha256: sha(table) },
    limits: { nowMs: 1000, maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: Number(decoded.guard.deadline_slot.toString(10)), reviewExpiresAtMs: 6000,
      maxLaunchFeeLamports: decoded.guard.max_launch_fee_lamports.toString(10), maxPoolCreationFeeLamports: decoded.guard.max_pool_creation_fee_lamports.toString(10),
      maxRentLamports: decoded.guard.max_rent_lamports.toString(10), maxInstructionDebitLamports: decoded.guard.max_total_debit_lamports.toString(10),
      maxNetworkFeeLamports: '15000', maxTotalDebitLamports: String(BigInt(decoded.guard.max_total_debit_lamports.toString(10)) + 15000n),
      computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' } }
}
