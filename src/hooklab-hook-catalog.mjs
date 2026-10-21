// Server-only declarative setup compiler and append-only publication store.
// Publication is a wallet's declaration, never author verification or execution approval.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { hookAddress } from './hooklab-execution-contract.mjs'
import { selectedHookSchema } from './hooklab-selected-hook.mjs'

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/)
const literal = z.object({ kind: z.literal('bytes'), hex: z.string().regex(/^(?:[a-f0-9]{2}){1,32}$/) }).strict()
const context = z.object({ kind: z.enum(['creator', 'mint']) }).strict()
const fixed = z.object({ kind: z.literal('fixed'), address: hookAddress }).strict()
const field = z.object({ kind: z.literal('field'), name }).strict()
const seed = z.union([literal, context, fixed, field])
const pda = z.object({ kind: z.literal('pda'), program: z.union([z.literal('selectedHook'), hookAddress]), seeds: z.array(seed).min(1).max(15) }).strict()
const source = z.union([context, fixed, field, pda])
const configField = z.object({ name, label: z.string().min(1).max(100), type: z.enum(['u8','u16','u32','u64','address','bool']),
  min: z.string().regex(/^\d+$/).max(20).optional(), max: z.string().regex(/^\d+$/).max(20).optional() }).strict()
export const hookSetupManifestSchema = z.object({ schema: z.literal('repoing/hook-setup-manifest/1'), selectedHook: selectedHookSchema,
  postMintHoldings: z.array(z.object({ owner: z.union([context, fixed, field]) }).strict()).min(1).max(2).optional(),
  fields: z.array(configField).max(32), instructions: z.array(z.object({
    data: z.array(z.union([z.object({ kind: z.literal('bytes'), hex: z.string().regex(/^(?:[a-f0-9]{2}){1,512}$/) }).strict(), field])).min(1).max(64),
    accounts: z.array(z.object({ source, signer: z.boolean(), writable: z.boolean() }).strict()).min(1).max(32),
  }).strict()).min(1).max(8),
}).strict().superRefine((m, ctx) => {
  const issue = message => ctx.addIssue({ code: 'custom', message }), fields = new Map(m.fields.map(f => [f.name, f]))
  if (fields.size !== m.fields.length) issue('Duplicate configuration field')
  for (const f of m.fields) {
    if (f.type.startsWith('u')) {
      const limit = (1n << BigInt(f.type.slice(1))) - 1n
      if (BigInt(f.min ?? '0') > BigInt(f.max ?? String(limit)) || BigInt(f.max ?? String(limit)) > limit) issue('Invalid integer bounds')
    } else if (f.min !== undefined || f.max !== undefined) issue('Only integers have bounds')
  }
  const reference = (s, account = false) => {
    if (s.kind === 'field' && (!fields.has(s.name) || (account && fields.get(s.name).type !== 'address'))) issue('Invalid field reference')
    if (s.kind === 'pda') s.seeds.forEach(s => reference(s))
  }
  for (const h of m.postMintHoldings ?? []) reference(h.owner, true)
  for (const ix of m.instructions) {
    ix.data.forEach(s => reference(s))
    for (const a of ix.accounts) {
      reference(a.source, true)
      if (a.signer && a.source.kind !== 'creator') issue('Only creator may sign')
      if (a.writable && (a.source.kind === 'mint' || (a.source.kind === 'fixed' && [m.selectedHook.program, '11111111111111111111111111111111'].includes(a.source.address)))) issue('Unsafe setup privileges')
    }
  }
})
export const hookConfigurationSchema = z.record(name, z.union([z.string().max(100), z.boolean()]))
export const hookPublicationSelectionSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), manifest: hookSetupManifestSchema, configuration: hookConfigurationSchema }).strict()
// Restricted token-only post-mint facility: no executable payload or program override.
export function materializePostMintHoldingOwners(selection, { creator, mint, selectedHook }) {
  const s = hookPublicationSelectionSchema.parse(selection)
  if (hookPublicationDigest(s.manifest.selectedHook) !== hookPublicationDigest(selectedHook)) throw Error('Post-mint hook differs')
  materializeHookSetup(s.manifest, s.configuration, { creator, mint })
  const owners = (s.manifest.postMintHoldings ?? []).map(({ owner }) => {
    if (owner.kind === 'field') return hookAddress.parse(s.configuration[owner.name])
    return owner.kind === 'fixed' ? owner.address : owner.kind === 'creator' ? creator : mint
  })
  if (new Set(owners).size !== owners.length) throw Error('Duplicate post-mint holding owner')
  return Object.freeze(owners)
}
const check = (ok, message) => { if (!ok) throw Error(message) }
const key = value => new PublicKey(hookAddress.parse(value))
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
export const hookPublicationDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

/** Run on the server against the retained manifest/config, never browser-supplied evidence.
 * No program overrides, arbitrary JS, external fetches, extra signers or floating encodings.
 */
export function materializeHookSetup(manifest, configuration, { creator, mint }) {
  const m = hookSetupManifestSchema.parse(manifest), c = hookConfigurationSchema.parse(configuration)
  key(creator); key(mint)
  check(Object.keys(c).length === m.fields.length && m.fields.every(f => Object.hasOwn(c, f.name)), 'Configuration fields differ')
  const values = new Map()
  for (const f of m.fields) {
    const value = c[f.name]; let bytes
    if (f.type === 'address') { check(f.min === undefined && f.max === undefined, 'Address bounds unavailable'); bytes = key(value).toBuffer() }
    else if (f.type === 'bool') { check(typeof value === 'boolean' && f.min === undefined && f.max === undefined, 'Boolean configuration required'); bytes = Buffer.from([value ? 1 : 0]) }
    else {
      check(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), 'Canonical integer string required')
      const n = BigInt(value), size = Number(f.type.slice(1)) / 8, limit = (1n << BigInt(size * 8)) - 1n
      const min = BigInt(f.min ?? '0'), max = BigInt(f.max ?? String(limit))
      check(min <= max && max <= limit && n >= min && n <= max, 'Configuration out of bounds')
      bytes = Buffer.alloc(size); let x = n
      for (let i = 0; i < size; i++) { bytes[i] = Number(x & 255n); x >>= 8n }
    }
    values.set(f.name, { bytes, type: f.type, value })
  }
  const encode = s => {
    if (s.kind === 'bytes') return Buffer.from(s.hex, 'hex')
    if (s.kind === 'field') { check(values.has(s.name), 'Unknown configuration field'); return values.get(s.name).bytes }
    return key(s.kind === 'fixed' ? s.address : s.kind === 'creator' ? creator : mint).toBuffer()
  }
  const address = s => {
    if (s.kind === 'pda') return PublicKey.findProgramAddressSync(s.seeds.map(encode), key(s.program === 'selectedHook' ? m.selectedHook.program : s.program))[0].toBase58()
    if (s.kind === 'field') check(values.get(s.name)?.type === 'address', 'Account field must be an address')
    return new PublicKey(encode(s)).toBase58()
  }
  const instructions = m.instructions.map(ix => {
    const data = Buffer.concat(ix.data.map(encode)); check(data.length > 0 && data.length <= 768, 'Setup data too large')
    const accounts = ix.accounts.map(a => ({ address: address(a.source), signer: a.signer, writable: a.writable }))
    check(new Set(accounts.map(a => a.address)).size === accounts.length, 'Duplicate setup accounts')
    check(accounts.every(a => (!a.signer || a.address === creator) && (!a.writable || ![mint, m.selectedHook.program, '11111111111111111111111111111111'].includes(a.address))), 'Unsafe setup privileges')
    return { dataBase64: data.toString('base64'), accounts }
  })
  return freeze({ schema: 'repoing/selected-hook-setup-request/1', creator, mint, selectedHook: m.selectedHook, instructions })
}

export const hookPublicationInputSchema = z.object({ name: z.string().trim().min(1).max(100), version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  selectedHook: selectedHookSchema, behavior: z.string().trim().min(1).max(4000), fees: z.string().trim().min(1).max(2000), risks: z.string().trim().min(1).max(4000), manifest: hookSetupManifestSchema,
}).strict().refine(p => p.selectedHook.program === p.manifest.selectedHook.program && p.selectedHook.flags === p.manifest.selectedHook.flags, 'Manifest hook differs')
export function hookCatalogStore(pool) {
  return {
    async publish(publisher, input, evidence) {
      hookAddress.parse(publisher); const parsed = hookPublicationInputSchema.parse(input)
      check(evidence?.hookPin?.program === parsed.selectedHook.program && ['immutable','timelocked'].includes(evidence?.authority?.kind), 'Executable evidence required')
      const publication = { schema: 'repoing/hook-publication/1', publisher, ...parsed, evidence }, digest = hookPublicationDigest(publication)
      const result = await pool.query(`insert into hook_lab_hook_publications(digest,publisher,program,version,publication) values($1,$2,$3,$4,$5::jsonb)
        on conflict(publisher,program,version) do nothing returning digest`, [digest, publisher, parsed.selectedHook.program, parsed.version, JSON.stringify(publication)])
      if (!result.rows.length) { const retained = await pool.query('select digest from hook_lab_hook_publications where publisher=$1 and program=$2 and version=$3', [publisher, parsed.selectedHook.program, parsed.version]); check(retained.rows[0]?.digest === digest, 'Version already published; use a new version') }
      return { digest, ...publication }
    },
    async list() {
      // Do not load every retained executable's multi-megabyte account bytes for discovery.
      const { rows } = await pool.query(`select digest,(publication-'evidence') || jsonb_build_object('evidence',jsonb_build_object(
        'hookPin',publication#>'{evidence,hookPin}',
        'authority',jsonb_build_object('kind',publication#>'{evidence,authority,kind}'),
        'observedSlot',publication#>'{evidence,observedSlot}')) as publication
        from hook_lab_hook_publications order by published_at desc,digest limit 100`)
      return rows.map(r => publicHookPublication({ digest: r.digest, ...r.publication }))
    },
    async get(digest) { check(/^[a-f0-9]{64}$/.test(digest), 'Invalid publication digest'); const { rows } = await pool.query('select publication from hook_lab_hook_publications where digest=$1', [digest]); check(rows[0], 'Publication not found'); const p = rows[0].publication; check(hookPublicationDigest(p) === digest, 'Publication commitment differs'); return { digest, ...p } },
  }
}
export function publicHookPublication(p) {
  const { evidence, ...rest } = p
  return { ...rest, executableSha256: evidence.hookPin.elfSha256, authority: evidence.authority.kind, observedSlot: evidence.observedSlot }
}
/** Selection AND execution must call this with the original digest and a server-owned observer.
 * The observer must forward expectedEvidence to observeSelectedHookCompatibility.
 */
export async function revalidateHookPublication({ store, digest, observe }) {
  const p = await store.get(digest)
  check(typeof observe === 'function', 'Compatibility observer unavailable')
  const current = await observe({ program: p.selectedHook.program, expectedEvidence: p.evidence })
  const identity = evidence => { const { observedSlot, providers, ...rest } = evidence; return rest }
  check(current && hookPublicationDigest(identity(current)) === hookPublicationDigest(identity(p.evidence)), 'Published executable or authority changed')
  return p
}

/** Bind browser selection to the retained publication before persisting creator intent.
 * Caller must durably retain this result/configuration and revalidate the digest at execution.
 */
export async function bindHookPublication({ store, observe, selection, selectedHook, creator, mint }) {
  const s = hookPublicationSelectionSchema.parse(selection), p = await revalidateHookPublication({ store, digest: s.digest, observe })
  check(hookPublicationDigest(p.manifest) === hookPublicationDigest(s.manifest)
    && hookPublicationDigest(p.selectedHook) === hookPublicationDigest(selectedHookSchema.parse(selectedHook)), 'Published manifest or hook differs')
  const request = materializeHookSetup(p.manifest, s.configuration, { creator, mint })
  if (p.manifest.postMintHoldings) materializePostMintHoldingOwners(s, { creator, mint, selectedHook: p.selectedHook })
  return freeze({ hookPublication: { digest: s.digest, manifest: p.manifest, configuration: structuredClone(s.configuration) }, selectedHook: p.selectedHook, request })
}

// Generic example of prepare in the pinned 7fde540 tax_hook; not an allowlist or deployment pin.
// The collector's token holding MUST be created after the mint exists, otherwise fees are zero.
export function taxHookSetupManifest(selectedHook) {
  const ctx = kind => ({ kind }), account = (source, writable = false, signer = false) => ({ source, writable, signer })
  const derived = text => ({ kind: 'pda', program: 'selectedHook', seeds: [{ kind: 'bytes', hex: Buffer.from(text).toString('hex') }, ctx('mint')] })
  return hookSetupManifestSchema.parse({ schema: 'repoing/hook-setup-manifest/1', selectedHook,
    postMintHoldings: [{ owner: { kind: 'field', name: 'collector' } }],
    fields: [{ name: 'feeBps', label: 'Transfer fee (basis points)', type: 'u16', min: '0', max: '2000' }, { name: 'maxWalletBps', label: 'Wallet cap (basis points; 0 disables)', type: 'u16', min: '0', max: '10000' }, { name: 'collector', label: 'Collector wallet', type: 'address' }],
    instructions: [{ data: [{ kind: 'bytes', hex: createHash('sha256').update('global:prepare').digest().subarray(0, 8).toString('hex') }, { kind: 'field', name: 'feeBps' }, { kind: 'field', name: 'maxWalletBps' }],
      accounts: [account(ctx('creator'), true, true), account(ctx('mint')), account({ kind: 'field', name: 'collector' }), account(derived('tax'), true), account(derived('bordrless-hook-accounts'), true), account({ kind: 'fixed', address: '11111111111111111111111111111111' })] }] })
}
