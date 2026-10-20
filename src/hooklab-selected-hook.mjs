// Pure selected-hook ABI adapter. Supplied account bytes are NOT authenticated chain evidence.
// This does not produce a signing review, quote, or execution authorization.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { hookAddress } from './hooklab-execution-contract.mjs'
import { inclusivePolicyMeta } from './hooklab-inclusive-fee-abi.mjs'

const check = (ok, message) => { if (!ok) throw Error(message) }
const kb = value => new PublicKey(hookAddress.parse(value)).toBuffer()
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58()
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const zero = '11111111111111111111111111111111'
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const meta = (address, writable = false) => ({ address, writable, signer: false })
export const selectedHookSchema = z.object({ program: hookAddress.refine(v => v !== zero),
  // All eight known token flags, never pool flags or Kit modules.
  flags: z.number().int().min(1).max(255),
}).strict()

/** Decode the exact v1 registry bytes, resolving only explicit callback context.
 * Account indices refer to the token callback's accounts, NOT launch/swap outer metas.
 * Missing owner/context seeds fail rather than substitute upstream identities.
 */
export function resolveSelectedHookRegistry({ hook, mint, registry, callbackAccounts = [], sourceOwner, destinationOwner }) {
  kb(hook); kb(mint)
  check(registry?.address === pda(hook, Buffer.from('bordrless-hook-accounts'), kb(mint))
    && registry.owner === hook && registry.executable === false, 'Mint registry identity or owner differs')
  const b = Buffer.from(registry.dataBase64, 'base64')
  check(b.toString('base64') === registry.dataBase64 && b.length <= 16384, 'Registry bytes differ')
  let at = 0
  const take = n => { check(at + n <= b.length, 'Truncated registry'); const v = b.subarray(at, at + n); at += n; return v }
  const byte = () => take(1)[0], count = () => take(4).readUInt32LE(), key = () => new PublicKey(take(32)).toBase58()
  check(take(8).equals(Buffer.from('02daf6662c38c0cd', 'hex')) && byte() === 1, 'Registry magic or version differs')
  const size = count(); check(size <= 32, 'Too many registry extras')
  const extras = []
  for (let i = 0; i < size; i++) {
    const writable = byte(); check(writable <= 1, 'Noncanonical writable flag')
    const kind = byte(); let address
    if (kind === 0) address = key()
    else {
      check(kind === 1, 'Unknown registry source')
      const program = key(), seedCount = count(); check(seedCount <= 15, 'Too many PDA seeds')
      const seeds = []
      for (let j = 0; j < seedCount; j++) {
        const tag = byte(); let seed
        if (tag === 0) { const length = count(); check(length <= 32, 'PDA seed too long'); seed = take(length) }
        else if (tag === 1) { const index = byte(); check(index < callbackAccounts.length, 'Missing callback account'); seed = kb(callbackAccounts[index]) }
        else if (tag === 2) seed = kb(sourceOwner)
        else { check(tag === 3, 'Unknown registry seed'); seed = kb(destinationOwner) }
        seeds.push(seed)
      }
      address = pda(program, ...seeds)
    }
    extras.push(meta(address, writable === 1))
  }
  check(at === b.length, 'Trailing registry bytes')
  return extras
}

/** Borsh tuple required by create_launch_open_v1's nongate branch, fee policy excluded. */
export function selectedHookAccountsHash({ hook, registry, extras, feeModel = 2 }) {
  check(feeModel === 2 && extras.length <= 32, 'Only inclusive fee model 2 is supported')
  const raw = Buffer.from(registry.dataBase64, 'base64')
  check(raw.toString('base64') === registry.dataBase64 && raw.length <= 16384, 'Registry bytes differ')
  const bytes = [Buffer.from('hook-lab:selected-hook-accounts:v1'), kb(hook), kb(registry.address), kb(registry.owner), u32(raw.length), raw, u32(extras.length)]
  for (const extra of extras) {
    check(typeof extra.writable === 'boolean' && extra.signer === false, 'Extra privileges differ')
    bytes.push(kb(extra.address), Buffer.from([extra.writable ? 1 : 0]))
  }
  return createHash('sha256').update(Buffer.concat([...bytes, Buffer.from([feeModel])])).digest()
}

/** Resolve launch and transfer slices from immutable program evidence and registry bytes.
 * Hook ELF digest must be an independent operator pin, never inferred from these bytes.
 */
export function selectedHookAccountPlan({ programs, selectedHook, mint, registry, programAccount, programData, elfSha256, callbackAccounts, sourceOwner, destinationOwner }) {
  const { program: hook, flags } = selectedHookSchema.parse(selectedHook)
  const identities = ['token', 'swap', 'launch', 'gate'].map(role => { kb(programs[role]); return programs[role] })
  check(new Set(identities).size === identities.length && !identities.includes(zero)
    && !identities.includes(hook), 'Selected hook or program roles alias; gate uses PolicyV2 path')
  const dataAddress = pda(loader, kb(hook)), pb = Buffer.from(programAccount?.dataBase64 ?? '', 'base64'), db = Buffer.from(programData?.dataBase64 ?? '', 'base64')
  check(programAccount?.address === hook && programAccount.owner === loader && programAccount.executable === true
    && pb.length === 36 && pb.readUInt32LE() === 2 && pb.subarray(4).equals(kb(dataAddress)), 'Hook ProgramData linkage differs')
  check(programData?.address === dataAddress && programData.owner === loader && programData.executable === false
    && db.length >= 49 && db.readUInt32LE() === 3 && db[12] === 0 && db.subarray(45, 49).equals(Buffer.from([127, 69, 76, 70]))
    && /^[a-f0-9]{64}$/.test(elfSha256) && createHash('sha256').update(db.subarray(45)).digest('hex') === elfSha256, 'Hook must be immutable and ELF-pinned')
  const extras = resolveSelectedHookRegistry({ hook, mint, registry, callbackAccounts, sourceOwner, destinationOwner })
  const tokenSigner = pda(programs.token, Buffer.from('hook-authority'), kb(hook))
  return { hook, flags, registry: registry.address, extras, tokenSigner, programData: dataAddress,
    launchRemainingPrefix: [meta(pda(programs.launch, Buffer.from('governance'))), meta(dataAddress), meta(hook), meta(tokenSigner), meta(registry.address), ...extras],
    transferSlice: [meta(hook), meta(tokenSigner), ...extras],
    commitment: selectedHookAccountsHash({ hook, registry, extras }).toString('hex'),
    // No invented cap and no deterministic arbitrary-hook token-fee quote.
    capBps: 0, feeModel: 2, canSign: false, canSubmit: false }
}

export function refuseUnsupportedSelectedHook() {
  throw Object.assign(Error('Selected-hook signing requires a repaired, reviewed deployment and exact-message token-delta simulation; arbitrary token fees are not deterministically quotable.'), { code: 'SELECTED_HOOK_REVIEW_UNAVAILABLE' })
}

// Complete nongate remaining-account order. Derive the pool and policy from the independently
// pinned swap/launch/token identities; do not accept an arbitrary fee-policy address.
export function selectedHookOpenLaunchAccounts(input) {
  const plan = selectedHookAccountPlan(input), { programs, mint, quoteMint } = input
  const pool = pda(programs.swap, Buffer.from('pool'), kb(mint), kb(quoteMint), Buffer.alloc(2), kb(programs.launch))
  return { ...plan, pool, remaining: [...plan.launchRemainingPrefix, inclusivePolicyMeta(programs.swap, pool, 'create')] }
}
