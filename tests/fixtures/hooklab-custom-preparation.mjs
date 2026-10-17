// Synthetic public addresses/ELF-shaped bytes only. No key generation or signatures.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { accountBytes } from './hooklab-plain.mjs'
const sha = b => createHash('sha256').update(b).digest('hex')
const address = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const signer = n => { while (!PublicKey.isOnCurve(new PublicKey(address(n)).toBytes())) n++; return address(n) }
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), new PublicKey(program))[0].toBase58()
export function customPreparationFixture({ samePayer = false } = {}) {
  const idl = role => readFileSync(new URL(`../../vendor/hooklab-event-abi/custom-production/${role}.json`, import.meta.url))
  const launchBytes = idl('bordrless_launch'), gateBytes = idl('hook_gate')
  const elf = Buffer.from('7f454c4600010203040506070809', 'hex')
  const programs = { launch: JSON.parse(launchBytes).address, swap: '4MsvuuDtsAsdGcSz7NWfSRtMZYcXXLrU4LNeT9MKeiKE',
    gate: JSON.parse(gateBytes).address, token: address(120), bridge: address(121) }
  const profileData = { schema: 'hook-lab/offline-custom-builder-profile/1', profileId: 'synthetic-test-profile',
    status: 'offline-candidate-not-adopted', sourceCommit: 'a33957a3f4285351949852ce5fb49cb3616ef496', sourcePatchSha256: null,
    buildFeature: 'custom-hooks-production', genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', programs, quoteMint: address(122),
    idlSha256: { launch: sha(launchBytes), gate: sha(gateBytes), swap: 'a'.repeat(64) }, elfSha256: { launch: sha(elf), gate: sha(elf), swap: 'b'.repeat(64) },
    dependencyObservation: { tokenElfSha256: 'c'.repeat(64), sourceProvenanceVerified: false, ownerAcceptanceVerified: false },
    capability: { kind: 'immutable-canonical-single-blocked-owner', beforeTransferOnly: true, creatorFeeBps: 0, rules: 'none',
      atomicPrepareAndLaunch: false, prepareMintSignerRequired: true, launchAdminCosignerRequired: true },
    artifactAdopted: false, ownerApprovalVerified: false, executionAuthorized: false, publicExecutionEnabled: false, canSign: false, canSubmit: false }
  const json = JSON.stringify(profileData)
  const request = { schema: 'repoing/custom-preparation-request/1', creator: signer(10), feePayer: samePayer ? signer(10) : signer(30),
    mint: signer(50), selectedConfig: signer(70), blockedOwner: address(90), label: 'Local test only', creatorFeeBps: 0, rules: 'none', hookFlags: 1 }
  const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
  const a = { launch: programs.launch, gate: programs.gate,
    launchProgramData: pda(loader, new PublicKey(programs.launch).toBuffer()), gateProgramData: pda(loader, new PublicKey(programs.gate).toBuffer()),
    launchConfig: pda(programs.launch, 'config'), policy: pda(programs.gate, 'policy', new PublicKey(request.mint).toBuffer()),
    registry: pda(programs.gate, 'bordrless-hook-accounts', new PublicKey(request.mint).toBuffer()) }
  const entries = new Map(), add = (key, owner, executable, bytes, lamports = '10000000') => entries.set(key, { address: key, owner, executable, dataBase64: bytes.toString('base64'), lamports })
  for (const role of ['launch', 'gate']) {
    const program = a[role], data = a[role + 'ProgramData'], pb = Buffer.alloc(36), db = Buffer.alloc(45 + elf.length)
    pb.writeUInt32LE(2); new PublicKey(data).toBuffer().copy(pb, 4)
    db.writeUInt32LE(3); db.writeBigUInt64LE(1n, 4); db[12] = role === 'gate' ? 0 : 1; elf.copy(db, 45)
    add(program, loader, true, pb); add(data, loader, false, db)
  }
  add(a.launchConfig, a.launch, false, accountBytes('launch', 'Config', { version: 1, paused: true }, 250))
  for (const key of [request.creator, request.feePayer]) add(key, '11111111111111111111111111111111', false, Buffer.alloc(0))
  const inventory = [a.launch, a.gate, a.launchProgramData, a.gateProgramData, a.launchConfig, a.policy, a.registry,
    request.mint, request.selectedConfig, request.creator, request.feePayer]
  const observations = ['fixture-a', 'fixture-b'].map(provider => ({ provider, genesisHash: profileData.genesisHash, commitment: 'finalized',
    slot: 100, observedAtMs: 1000, accounts: inventory.map(address => ({ address, account: structuredClone(entries.get(address) ?? null) })),
    rentExemptionLamports: { policy: '1000', registry: '2000', selectedConfig: '3000' } }))
  return { profile: { json, expectedSha256: sha(json), idls: { launch: launchBytes.toString('base64'), gate: gateBytes.toString('base64') }, elfLengths: { launch: elf.length, gate: elf.length }, providers: ['fixture-a', 'fixture-b'] }, request, observations, lookupTable: null,
    recentBlockhash: { blockhash: address(110), genesisHash: profileData.genesisHash, providers: ['fixture-a', 'fixture-b'],
      observedAtMs: 1000, currentBlockHeight: 100, blockhashValid: true, lastValidBlockHeight: 250, observedSlot: 100, networkFeeLamports: samePayer ? '15000' : '20000', lamportsPerSignature: '5000' },
    limits: { nowMs: 1001, maxAgeMs: 10000, maxSlotLag: 5, validUntilSlot: 150, reviewExpiresAtMs: 5000,
      maxRentLamports: '6000', maxNetworkFeeLamports: '20000', maxTotalDebitLamports: '26000', computeUnitLimit: 400000, computeUnitPriceMicroLamports: '0' } }
}
