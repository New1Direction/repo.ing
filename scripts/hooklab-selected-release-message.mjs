#!/usr/bin/env node
// Offline, public-input-only review candidate. Never produces a signed transaction.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { ComputeBudgetProgram, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } from '@solana/web3.js'

export const SELECTED_PROGRAMS = Object.freeze({
  launch: '9zzzPsLUsuu1XoGZ4TsHbghyXUPqXnHeJUpPRY7P5ZWu',
  swap: '72tDzM3mhFsYU1qecrLpScv1Bud6XaszkQtB4YVjJh9s',
})
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(message) }
const check = (condition, message) => { if (!condition) fail(message) }
const hash = value => { check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'full SHA256 required'); return value }
const key = value => { check(typeof value === 'string', 'public key required'); const k = new PublicKey(value); check(k.toBase58() === value && !k.equals(PublicKey.default), 'canonical non-placeholder public key required'); return k }
const uint = value => { check(Number.isSafeInteger(value) && value >= 0, 'safe nonnegative integer required'); return value }
const amount = value => { check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'decimal lamports required'); const n = BigInt(value); check(n <= 0xffffffffffffffffn, 'u64 overflow'); return n }
const bytes = value => { check(typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'canonical base64 required'); return Buffer.from(value, 'base64') }
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}
export const digestJson = value => sha256(JSON.stringify(canonical(value)))

export const UNMET_PUBLIC_INPUTS = Object.freeze([
  'Approved full source commit/tree, source manifest and feature manifest SHA256; exact candidate ELF bytes/length/hash and independent reproduction review',
  'Current owner-approved cluster/genesis, finalized slot-stamped public exports, provider identities and freshness policy',
  'Exact Program and derived ProgramData bytes/hashes, loader owner/link, capacity, lamports, deployment slot and upgrade authority',
  'Approved existing buffer identity, exact bytes/hash, authority, ELF length and explicit zero padding',
  'Approved payer/spill/authority public keys, signer order, rent minima, balances, CU/fee bounds and partial-failure sequencing decision',
  'Fresh approved recent blockhash, observed height, lastValidBlockHeight and expiry; durable nonce is deliberately unsupported',
  'Finalized candidate/application acceptance, owner adoption, independent exact-message decode/simulation and current pre-sign readback (outside this tool)',
])

export function prepareSelectedReleaseMessage(envelope, { nowMs = Date.now() } = {}) {
  const e = envelope
  check(e?.schema === 'hooklab-selected-upgrade-review-v1', 'explicit v1 public envelope required')
  // The separately supplied owner review digest binds every public input, not just ELF.
  check(hash(e.approvedInputsSha256) === digestJson(e.inputs), 'approved input digest mismatch')
  const i = e.inputs
  check(i && Object.hasOwn(SELECTED_PROGRAMS, i.programName), 'selected launch/swap only')
  check(i.program.address === SELECTED_PROGRAMS[i.programName], 'program identity mismatch')
  check(i.cluster === 'mainnet-beta' && i.genesisHash === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'cluster/genesis mismatch')
  check(/^[0-9a-f]{40}$/.test(i.source.commit) && /^[0-9a-f]{40}$/.test(i.source.tree) && i.source.clean === true, 'clean full source commit/tree required')
  for (const field of ['sourceManifest', 'features']) {
    check(i.source[field] && Object.keys(i.source[field]).length > 0, `${field} required`)
    check(hash(i.source[`${field}Sha256`]) === digestJson(i.source[field]), `${field} digest mismatch`)
  }
  for (const h of Object.values(i.source.sourceManifest)) hash(h)
  const expectedFeatures = ['inclusive-fees-candidate', ...(i.programName === 'swap' ? ['custom-hooks-reuse-candidate'] : []), 'repoing-independent'].sort()
  check(JSON.stringify([...i.source.features[i.programName]].sort()) === JSON.stringify(expectedFeatures), 'feature selection mismatch')
  uint(nowMs)
  check(i.snapshot.commitment === 'finalized' && Array.isArray(i.snapshot.providers) && i.snapshot.providers.length > 0 && i.snapshot.providers.every(p => typeof p === 'string' && p.length > 0), 'finalized provider exports required')
  const observed = uint(i.snapshot.observedAtMs), maxAge = uint(i.snapshot.maxAgeMs)
  check(maxAge > 0 && maxAge <= 300000 && observed <= nowMs && nowMs - observed <= maxAge, 'stale account export')
  uint(i.snapshot.slot)
  const payer = key(i.payer.address), spill = key(i.spill), authority = key(i.authority)
  const program = key(i.program.address)
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)
  const account = (a, address, executable) => {
    check(a.address === address.toBase58() && a.owner === LOADER.toBase58() && a.executable === executable, 'account identity/owner/executable mismatch')
    check(a.slot === i.snapshot.slot, 'account snapshot slot mismatch')
    amount(a.lamports)
    const data = bytes(a.dataBase64)
    check(sha256(data) === hash(a.sha256), 'account bytes hash mismatch')
    return data
  }
  const p = account(i.program, program, true)
  check(p.length === 36 && p.readUInt32LE(0) === 2 && p.subarray(4).equals(programData.toBuffer()), 'invalid Program link/state')
  const pd = account(i.programData, programData, false)
  check(pd.length >= 45 && pd.readUInt32LE(0) === 3 && pd[12] === 1 && pd.subarray(13, 45).equals(authority.toBuffer()), 'invalid ProgramData authority/state')
  check(pd.readBigUInt64LE(4) === BigInt(uint(i.deploymentSlot)) && i.deploymentSlot < i.snapshot.slot, 'deployment slot mismatch/not yet upgradeable')
  check(pd.length - 45 === uint(i.capacity), 'capacity mismatch')
  const elf = bytes(i.elf.dataBase64)
  check(elf.length === uint(i.elf.length) && elf.length >= 4 && elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && sha256(elf) === hash(i.elf.sha256), 'ELF bytes/length/hash mismatch')
  check(elf.length <= i.capacity, 'ProgramData capacity insufficient; extension prohibited')
  const bufferKey = key(i.approvedBuffer)
  const b = account(i.buffer, bufferKey, false)
  check(b.length >= 37 && b.readUInt32LE(0) === 1 && b[4] === 1 && b.subarray(5, 37).equals(authority.toBuffer()), 'invalid buffer authority/state')
  check(i.bufferPadding === 'zero' && b.length === 37 + elf.length + uint(i.bufferPaddingBytes) && b.subarray(37, 37 + elf.length).equals(elf) && b.subarray(37 + elf.length).every(v => v === 0), 'buffer ELF length/padding mismatch')
  check(b.length - 37 <= i.capacity, 'padded buffer exceeds ProgramData capacity')
  check(new Set([payer, spill, authority, program, programData, bufferKey, LOADER, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, ComputeBudgetProgram.programId].map(k => k.toBase58())).size === 10, 'account aliasing prohibited')
  const rent = amount(i.rent.programDataMinimumLamports)
  check(rent > 0n && amount(i.programData.lamports) + amount(i.buffer.lamports) >= rent && i.rent.programDataLength === pd.length, 'insufficient upgrade rent')
  check(i.rent.bufferLength === b.length && amount(i.rent.bufferMinimumLamports) > 0n && amount(i.buffer.lamports) >= amount(i.rent.bufferMinimumLamports), 'buffer rent mismatch')
  check(i.rent.additionalPayerDebitLamports === '0', 'implicit rent funding prohibited')
  const f = i.fees
  const units = uint(f.computeUnitLimit), price = amount(f.microLamportsPerUnit)
  check(units > 0 && units <= uint(f.maxComputeUnitLimit) && f.maxComputeUnitLimit <= 1400000 && price <= amount(f.maxMicroLamportsPerUnit), 'CU bounds exceeded')
  const fee = amount(f.lamportsPerSignature) * 2n + (BigInt(units) * price + 999999n) / 1000000n
  check(amount(f.lamportsPerSignature) > 0n && fee <= amount(f.maxTotalLamports) && amount(i.payer.lamports) >= fee, 'fee bounds/funds insufficient')
  const h = i.blockhash
  check(h.mode === 'recent' && h.approved === true, 'only approved recent blockhash supported; nonce unsupported')
  key(h.value)
  check(uint(h.observedBlockHeight) <= uint(h.currentBlockHeight) && h.currentBlockHeight <= uint(h.lastValidBlockHeight) && h.lastValidBlockHeight - h.observedBlockHeight <= 150, 'expired/invalid blockheight window')
  check(uint(h.observedAtMs) <= nowMs && nowMs - h.observedAtMs <= maxAge && uint(h.expiresAtMs) > nowMs && h.expiresAtMs <= observed + maxAge, 'expired/stale blockhash')
  check(i.sequencePolicy === 'one-upgrade-stop-and-reexport-before-next', 'explicit partial-failure policy required')
  const tx = new Transaction({ feePayer: payer, recentBlockhash: h.value })
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }))
  tx.add(new TransactionInstruction({ programId: LOADER, data: Buffer.from([3, 0, 0, 0]), keys: [
    { pubkey: programData, isWritable: true, isSigner: false },
    { pubkey: program, isWritable: true, isSigner: false },
    { pubkey: bufferKey, isWritable: true, isSigner: false },
    { pubkey: spill, isWritable: true, isSigner: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isWritable: false, isSigner: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isWritable: false, isSigner: false },
    { pubkey: authority, isWritable: false, isSigner: true },
  ] }))
  const message = tx.compileMessage()
  const signers = message.accountKeys.slice(0, message.header.numRequiredSignatures).map(k => k.toBase58())
  check(JSON.stringify(i.approvedSignerOrder) === JSON.stringify(signers), 'signer ordering mismatch')
  const wire = message.serialize()
  check(wire.length + 1 + signers.length * 64 <= 1232, 'transaction packet too large')
  return { schema: e.schema, status: 'UNSIGNED REVIEW CANDIDATE', signingGate: 'NOT SIGNABLE', canSign: false, canSubmit: false,
    messageBase64: wire.toString('base64'), messageSha256: sha256(wire), approvedInputsSha256: e.approvedInputsSha256,
    requiredSignerOrder: signers, estimatedFeeLamports: fee.toString(), unmetPublicInputs: [...UNMET_PUBLIC_INPUTS],
    warning: 'Exact message is not authorization. Offline exports and approval authenticity cannot be established here. Acceptance/adoption and fresh pre-sign review remain external gates.' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    check(process.argv.length === 2, 'No paths/options accepted; pipe explicit public JSON on stdin')
    let input = ''
    for await (const chunk of process.stdin) { input += chunk; check(input.length <= 20000000, 'public envelope too large') }
    console.log(JSON.stringify(prepareSelectedReleaseMessage(JSON.parse(input)), null, 2))
    process.exitCode = 2 // Review only, never signals signing readiness.
  } catch (error) {
    console.log(JSON.stringify({ signingGate: 'NOT SIGNABLE', canSign: false, canSubmit: false, messageBase64: null, error: error.message, unmetPublicInputs: UNMET_PUBLIC_INPUTS }, null, 2))
    process.exitCode = 2
  }
}
