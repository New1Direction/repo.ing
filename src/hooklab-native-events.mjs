// Read-only decoder, deliberately separate from deployment/economic acceptance.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { BorshCoder, BN } from '@anchor-lang/core'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'

const sha = value => createHash('sha256').update(value).digest('hex')
const check = (ok, message) => { if (!ok) throw Error(message) }
const tag = Buffer.from('e445a52e51cb9a1d', 'hex') // Anchor EVENT_IX_TAG_LE; self-CPI, not log strings.
const plainSource = 'b3dc4297735fe2e061fca7b6563d69cf81e0911c'
const maxWalletSource = 'a33957a3f4285351949852ce5fb49cb3616ef496'
const maxWalletPatch = 'd1c5447d6e4c0400ad641679cb0e409425f2ce1ef9aaf6500611215f3491c13f'
const profiles = {
  // Same program IDs are not a capability identifier: this candidate requires its patch pin.
  [maxWalletSource]: { sourcePatchSha256: maxWalletPatch, artifacts: {
    bordrless_launch: new URL('../vendor/hooklab-event-abi/max-wallet-reuse/bordrless_launch.json', import.meta.url),
    bordrless_swap: new URL('../vendor/hooklab-event-abi/bordrless_swap.json', import.meta.url),
  }, pins: [
    ['bordrless_launch', 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft', 'b1f564880120eac65ba7f35031260b74f93c9b5004edb55ce0543884fa6b5f8f'],
    ['bordrless_swap', 'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk', 'ba5409de62f8d56f3500a72f5b7d11cfdefd85027d2ec3bd56e2137ae76bc414'],
  ] },
  [plainSource]: { artifacts: {
    bordrless_launch: new URL('../vendor/hooklab-event-abi/bordrless_launch.json', import.meta.url),
    bordrless_swap: new URL('../vendor/hooklab-event-abi/bordrless_swap.json', import.meta.url),
  }, pins: [
    ['bordrless_launch', 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft', '929403a199c9cb411d25980a49667f531612efcdb7e449b13af9258b638869fb'],
    ['bordrless_swap', 'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk', 'ba5409de62f8d56f3500a72f5b7d11cfdefd85027d2ec3bd56e2137ae76bc414'],
  ] },
  // Pinned source candidate, NOT a deployed/adopted capability. No runtime ABI override.
  '823442c7a7c3572ddf8ecf82c8084591ebb170c9': { artifacts: {
    bordrless_launch: new URL('../vendor/hooklab-event-abi/custom-production/bordrless_launch.json', import.meta.url),
    bordrless_swap: new URL('../vendor/hooklab-event-abi/custom-production/bordrless_swap.json', import.meta.url),
  }, pins: [
    ['bordrless_launch', 'Ky5HeYrE3HK3oh5x2kGzHFpkxnQXHcXQLFAZPzkcvSG', '9240ff013753c9ab893663f7b89279f1e5f1baade080f8fbf61f4f07a6a15c57'],
    ['bordrless_swap', '4MsvuuDtsAsdGcSz7NWfSRtMZYcXXLrU4LNeT9MKeiKE', '93a6721f59989c30423d7ad5a99cfd4592a9fd001160429bc063d74085fe2e13'],
  ] },
}
const normalize = value => {
  if (BN.isBN(value)) return value.toString(10)
  if (value instanceof PublicKey) return value.toBase58()
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]))
  return value
}

export function productionHookEventDecoder(options = {}) {
  check(options && Object.getPrototypeOf(options) === Object.prototype
    && Reflect.ownKeys(options).every(key => key === 'sourceCommit' || key === 'sourcePatchSha256'), 'Unknown event decoder options')
  const { sourceCommit = plainSource } = options
  check(Object.hasOwn(profiles, sourceCommit), 'Unpinned event ABI source')
  const { pins, artifacts, sourcePatchSha256 } = profiles[sourceCommit]
  check(options.sourcePatchSha256 === sourcePatchSha256, 'Event ABI source patch binding differs')
  const bindings = new Map(pins.map(([name, program, hash]) => {
    // Explicit URLs preserve each exact artifact through Next/Turbopack server bundling.
    const bytes = readFileSync(artifacts[name])
    check(sha(bytes) === hash, 'Event ABI artifact drift')
    const idl = JSON.parse(bytes)
    check(idl.address === program, 'Event ABI program mismatch')
    return [program, { coder: new BorshCoder(idl), idl,
      authority: PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(program))[0].toBase58() }]
  }))
  return {
    sourceCommit,
    ...(sourcePatchSha256 ? { sourcePatchSha256 } : {}),
    idlSha256: sha(JSON.stringify(pins)),
    programs: pins.map(p => p[1]),
    decode(raw) {
      const { transaction: tx, meta } = raw
      check(tx?.message && meta && Array.isArray(meta.innerInstructions), 'Missing invocation evidence')
      const keys = [...tx.message.accountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])]
      const resolve = index => { check(Number.isInteger(index) && typeof keys[index] === 'string', 'Invalid account index'); return keys[index] }
      const events = [], groups = new Set()
      for (const group of meta.innerInstructions) {
        check(Number.isInteger(group.index) && tx.message.instructions[group.index] && !groups.has(group.index), 'Invalid inner instruction group')
        groups.add(group.index)
        const stack = [null, resolve(tx.message.instructions[group.index].programIdIndex)]
        for (const [innerIndex, ix] of group.instructions.entries()) {
          const program = resolve(ix.programIdIndex), height = ix.stackHeight
          // Missing historical stack heights cannot authenticate a self-CPI parent.
          check(Number.isInteger(height) && height >= 2 && height <= stack.length, 'Missing or invalid CPI ancestry')
          stack.length = height
          const parent = stack[height - 1]
          stack[height] = program
          const binding = bindings.get(program)
          if (!binding) continue
          const bytes = bs58.decode(ix.data)
          if (!Buffer.from(bytes).subarray(0, 8).equals(tag)) continue
          check(parent === program && ix.accounts.length === 1 && resolve(ix.accounts[0]) === binding.authority,
            'Unauthenticated event invocation')
          const payload = Buffer.from(bytes).subarray(8), decoded = binding.coder.events.decode(payload.toString('base64'))
          check(decoded, 'Unknown event discriminator')
          const definition = binding.idl.events.find(e => e.name === decoded.name)
          const canonical = Buffer.concat([Buffer.from(definition.discriminator), binding.coder.types.encode(decoded.name, decoded.data)])
          check(canonical.equals(payload), 'Noncanonical event bytes')
          events.push({ program, outerIndex: group.index, innerIndex, name: decoded.name, data: normalize(decoded.data),
            transactionFailed: meta.err !== null }) // Outer success does not rule out a caught inner failure.
        }
      }
      return { eventStatus: 'decoded-self-cpi', events, economicPostconditions: false, deploymentAdopted: false }
    },
  }
}
