// Inert, source-independent evidence boundary. No active profile, RPC, SDK defaults or execution.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

const sha = data => createHash('sha256').update(data).digest('hex')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const key = z.string().max(44).refine(v => { try { return new PublicKey(v).toBase58() === v } catch { return false } })
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const mainnetGenesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const role = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const accountPin = z.object({ role, address: key, owner: key, executable: z.boolean(), dataSha256: hash }).strict()
const dossierSchema = z.object({
  schema: z.literal('repoing/production-observation/1'), genesisHash: z.literal(mainnetGenesis),
  artifacts: z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), profileSha256: hash,
    sdkSha256: hash, idlSha256: hash, provenanceSha256: hash }).strict(),
  // Distinct trust domains must be selected/reviewed by operators, not inferred from URL spelling.
  providers: z.array(role).length(2), minSlot: integer, maxSlotLag: integer.max(150),
  maxAgeMs: integer.positive().max(60000),
  programs: z.array(z.object({ role, address: key, programData: key, upgradeAuthority: key.nullable(),
    deploySlot: integer, programDataSha256: hash, elfLength: integer.positive().max(10485760), elfSha256: hash,
  }).strict()).min(3).max(20),
  accounts: z.array(accountPin).min(4).max(80),
}).strict()
const observationSchema = z.object({ provider: role, genesisHash: key, commitment: z.literal('finalized'),
  slot: integer, observedAtMs: integer,
  accounts: z.array(z.object({ address: key, owner: key, executable: z.boolean(),
    dataBase64: z.string().max(14000000),
  }).strict()).max(120),
}).strict()
class EvidenceMismatch extends Error {}
const check = (ok, message) => { if (!ok) throw new EvidenceMismatch(message) }
function rawAccount(account) {
  const raw = Buffer.from(account.dataBase64, 'base64')
  check(raw.toString('base64') === account.dataBase64, 'Noncanonical account bytes')
  return raw
}

export function productionReadiness() {
  return { schema: 'repoing/production-readiness/1', status: 'unavailable', network: 'mainnet-beta',
    activeProfile: null, observedSlot: null, deploymentVerified: false, policyVerified: false,
    actions: { observe: false, recover: false, create: false, quote: false, simulate: false,
      review: false, sign: false, submit: false, buy: false, sell: false, addLiquidity: false,
      removeLiquidity: false, claimFees: false, index: false },
    blockers: ['No adopted frozen source/profile/SDK/IDL/provenance package.',
      'No finalized two-provider production account bindings or operation receipts.',
      'No approved creator, operation contracts, budgets or activation.'],
  }
}

/** Offline verification of a retained operator dossier, NOT public JSON supplied as authority.
 * expectedSha256 must be independently reviewed; matching a caller's own hash proves nothing.
 * Exact bytes bind dependencies and configuration, but do not decode/approve their semantics.
 * No result enables execution, asserts custody, or marks a token operation settled.
 */
export function inspectProductionEvidence({ dossierJson, expectedSha256, observations, nowMs } = {}) {
  const out = { status: 'unavailable', reason: 'Reviewed dossier and two independent observations required',
    observedSlots: [], accountBindingsMatched: false, policyVerified: false, provenanceVerified: false,
    canSign: false, canSubmit: false, canRetry: false }
  if (dossierJson == null || observations == null) return out
  try {
    check(typeof dossierJson === 'string' && Buffer.byteLength(dossierJson) <= 65536, 'Invalid dossier size')
    check(hash.parse(expectedSha256) === sha(dossierJson), 'Dossier digest mismatch')
    const d = dossierSchema.parse(JSON.parse(dossierJson))
    const now = integer.parse(nowMs)
    check(new Set(d.providers).size === 2, 'Independent provider bindings required')
    check(['launch', 'swap', 'token'].every(r => d.programs.some(p => p.role === r)), 'Missing executable dependency')
    check(['launch-config', 'swap-config', 'quote-mint', 'creation-control'].every(r => d.accounts.some(a => a.role === r)), 'Missing config/control/quote binding')
    const roles = [...d.programs, ...d.accounts].map(a => a.role)
    check(new Set(roles).size === roles.length, 'Duplicate evidence role')
    const addresses = [...d.programs.flatMap(p => [p.address, p.programData]), ...d.accounts.map(a => a.address)]
    check(new Set(addresses).size === addresses.length, 'Duplicate evidence address')
    check(Array.isArray(observations) && observations.length === 2, 'Two observations required')
    const obs = observations.map(o => observationSchema.parse(o))
    check(new Set(obs.map(o => o.provider)).size === 2 && obs.every(o => d.providers.includes(o.provider)), 'Provider binding differs')
    check(Math.abs(obs[0].slot - obs[1].slot) <= d.maxSlotLag, 'Provider slots diverge')
    for (const o of obs) {
      check(o.genesisHash === d.genesisHash && o.slot >= d.minSlot, 'Network or minimum slot differs')
      check(now >= o.observedAtMs && now - o.observedAtMs <= d.maxAgeMs, 'Observation stale or in future')
      const accounts = new Map(o.accounts.map(a => [a.address, a]))
      check(accounts.size === addresses.length && o.accounts.length === addresses.length
        && addresses.every(a => accounts.has(a)), 'Incomplete or duplicate account inventory')
      for (const p of d.programs) {
        const program = accounts.get(p.address), pd = accounts.get(p.programData)
        const programBytes = rawAccount(program), data = rawAccount(pd)
        const derived = PublicKey.findProgramAddressSync([new PublicKey(p.address).toBuffer()], new PublicKey(loader))[0].toBase58()
        check(p.programData === derived && program.owner === loader && program.executable && programBytes.length === 36
          && programBytes.readUInt32LE(0) === 2 && new PublicKey(programBytes.subarray(4)).toBase58() === p.programData, 'Program/loader/ProgramData linkage differs')
        check(pd.owner === loader && !pd.executable && data.length >= 45 + p.elfLength && data.readUInt32LE(0) === 3, 'Invalid ProgramData')
        check(data.readBigUInt64LE(4) === BigInt(p.deploySlot) && p.deploySlot <= o.slot, 'Deployment slot differs')
        check(data[12] === (p.upgradeAuthority === null ? 0 : 1), 'Authority option differs')
        if (p.upgradeAuthority !== null) check(new PublicKey(data.subarray(13, 45)).toBase58() === p.upgradeAuthority, 'Upgrade authority differs')
        const elf = data.subarray(45, 45 + p.elfLength)
        check(elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && sha(elf) === p.elfSha256
          && data.subarray(45 + p.elfLength).every(b => b === 0), 'ELF bytes or trailing allocation differ')
        check(sha(data) === p.programDataSha256, 'ProgramData bytes/allocation drift')
      }
      for (const a of d.accounts) {
        const observed = accounts.get(a.address)
        check(observed.owner === a.owner && observed.executable === a.executable
          && sha(rawAccount(observed)) === a.dataSha256, 'Config/control/quote account drift')
      }
    }
    return { ...out, status: 'account-bindings-matched', reason: 'Retained bytes match; policy semantics, provenance signatures and operation receipts remain unverified',
      observedSlots: obs.map(o => o.slot), accountBindingsMatched: true }
  } catch (error) {
    // Never return arbitrary RPC errors, provider URLs, account data or caller text.
    return { ...out, status: 'mismatch', reason: error instanceof EvidenceMismatch
      ? error.message : 'Invalid production evidence shape or bytes; do not infer readiness' }
  }
}
