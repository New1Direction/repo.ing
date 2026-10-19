// Hooks program stacks. The LEGACY stack is bundle 2 as deployed (launch E73c, swap B2cr, gate BdAa, token 2XoE, bridge
// CtLk, bridged-SOL quote mint A49o): the canary and the bridged flows, Add SOL and Withdraw for its holders. New coins
// launch on a stack of our own: our token, gate, launch and swap at their own program IDs, and our own quote MARKER mint
// (the pool's quote-side identity; a native coin's SOL never touches it, and no customer ever sees it). No bridge.
//
// A stack's builder profile is bundle 2's reviewed profile with the stack's programs, marker, ELF and IDL pins and no
// bridge, plus `stack` (its id, the kit program its launch code names, its token ELF length, its build). Every address
// the native and open lifecycle uses comes from that profile, so the same code serves any stack and every check stays
// exact per stack. A leaf module: schemas and pure functions only (no RPC, keys or other Hook Lab modules).
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw Object.assign(Error(`Hooks stack refused: ${message}`), { code: 'HOOKS_STACK_REFUSED' }) }
const key = z.string().refine(value => { try { return new PublicKey(value).toBase58() === value } catch { return false } }, 'Expected a canonical address')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const length = z.number().int().positive().max(10485760)

export const LEGACY_KIT = 'AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm'
export const LEGACY_TOKEN_ELF_LENGTH = 326504
// Bundle 2 as deployed on mainnet. Only the legacy (bridged) paths read this.
export const LEGACY_STACK = Object.freeze({ id: 'legacy',
  programs: Object.freeze({ launch: 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft', swap: 'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk',
    gate: 'BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb', token: '2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22', bridge: 'CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7' }),
  quoteMint: 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i', kitProgram: LEGACY_KIT, tokenElfLength: LEGACY_TOKEN_ELF_LENGTH })

const ROLES = Object.freeze(['launch', 'swap', 'gate', 'token'])
const stackPrograms = z.object({ launch: key, swap: key, gate: key, token: key }).strict()
const elfPin = z.object({ trimmedSha256: hash, trimmedLength: length }).strict()
// A stack's build: the trimmed ELF bytes each deployed ProgramData holds (program IDs are compiled in, so pins are per
// stack) and the exact IDL bytes, whose `address` names the stack's program. open: the launch program has self-serve
// launches (create_launch_open_v1).
export const stackBuildSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,47}$/),
  source: z.object({ repo: z.string().min(1).max(100), branch: z.string().min(1).max(100), commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  elf: z.object({ launch: elfPin, swap: elfPin, gate: elfPin, token: elfPin }).strict(),
  idlSha256: z.object({ launch: hash, swap: hash, gate: hash }).strict(), open: z.boolean() }).strict()
// The six fields of hook-lab's ids/independent.json (schema hook-lab/independent-ids/1): the four programs, the quote
// marker mint and the programs' upgrade authority; every other address is derived from them as the programs derive it.
// kitProgram: the kit program ID the launch code names (its PDAs are always absent on a Hooks coin; the token program's
// signer for it is derived under our token). status: 'placeholder' until the final program IDs exist; production
// refuses a placeholder stack.
export const stackSchema = z.object({ schema: z.literal('repoing/hooks-stack/1'), id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).refine(id => id !== 'legacy'),
  status: z.enum(['placeholder', 'reviewed']), programs: stackPrograms, quoteMint: key, upgradeAuthority: key, kitProgram: key, build: stackBuildSchema }).strict()
  .superRefine((s, ctx) => {
    const ids = [...Object.values(s.programs), s.quoteMint, s.upgradeAuthority, s.kitProgram]
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Stack programs, marker and kit must be distinct' })
  })
// The `stack` member of a stack profile.
export const stackProfileFieldSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/), build: z.string().min(1).max(48),
  upgradeAuthority: key, kitProgram: key, tokenElfLength: length, open: z.boolean() }).strict()

export const parseStack = value => stackSchema.parse(value)
export const isStackProfile = profile => !!profile?.stack
// The kit program the launch and swap code name (its "kit" PDAs are always absent on a Hooks coin). A stack profile names
// it; a legacy profile has the bridge and bundle 2's kit. Anything else is refused.
export function kitOf(profile) {
  const stack = !!profile?.stack, bridged = !!profile?.programs?.bridge
  if (stack === bridged) fail('a profile is either a stack (no bridge) or legacy (with its bridge)')
  return stack ? profile.stack.kitProgram : LEGACY_STACK.kitProgram
}
export const tokenElfLengthOf = profile => { kitOf(profile); return profile.stack ? profile.stack.tokenElfLength : LEGACY_STACK.tokenElfLength }
// The four Hooks programs of a profile (never the bridge).
export const hookPrograms = profile => Object.freeze(Object.fromEntries(ROLES.map(role => [role, profile.programs[role]])))
export const isLegacyPrograms = programs => ROLES.every(role => programs?.[role] === LEGACY_STACK.programs[role])

// A stack's builder profile from bundle 2's reviewed base profile: the stack's programs (no bridge), marker, pins and
// identity. The IDL bytes must be the build's and name the stack's programs.
export function stackProfile(base, stackInput, idls) {
  const stack = parseStack(stackInput), build = stack.build
  for (const role of ['launch', 'swap', 'gate']) {
    const bytes = Buffer.from(idls?.[role] ?? '')
    if (sha(bytes) !== build.idlSha256[role]) fail(`${role} IDL differs from the stack build's pin`)
    if (JSON.parse(bytes).address !== stack.programs[role]) fail(`${role} IDL names another program than the stack's`)
  }
  const pick = field => Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, build.elf[role][field]]))
  return Object.freeze({ ...base, profileId: `stack-${stack.id}-${build.name}`.slice(0, 64), sourceCommit: build.source.commit, sourcePatchSha256: sha(''),
    programs: { ...stack.programs }, quoteMint: stack.quoteMint, idlSha256: { ...build.idlSha256 }, elfSha256: pick('trimmedSha256'),
    dependencyObservation: { ...base.dependencyObservation, tokenElfSha256: build.elf.token.trimmedSha256 },
    stack: { id: stack.id, build: build.name, upgradeAuthority: stack.upgradeAuthority, kitProgram: stack.kitProgram, tokenElfLength: build.elf.token.trimmedLength, open: build.open } })
}
export const stackElfLengths = stackInput => { const { build } = parseStack(stackInput); return Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, build.elf[role].trimmedLength])) }

// Which stack a coin record belongs to: self-serve (open) launches are on our own stack; owner-invited launches (the
// canary and earlier coins) on the legacy stack.
export const coinStack = record => record?.source === 'open' ? 'own' : 'legacy'

const ZERO = '11111111111111111111111111111111'
// The profile's programs, marker, kit and the system program are all distinct (no role aliases another).
export const profileRolesDistinct = profile => { const ids = [...Object.values(profile.programs), profile.quoteMint, ZERO, kitOf(profile)]; return new Set(ids).size === ids.length }
// The programs a launch preparation does not call, which must still not alias any of its roles.
export const otherPrograms = profile => ['swap', 'token', 'bridge'].map(role => profile.programs[role]).filter(Boolean)
