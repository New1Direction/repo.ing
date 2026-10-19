// Hooks program stacks: the legacy stack is bundle 2 as deployed; our own stack's addresses all come from its descriptor
// and profile, never from constants. No RPC; the relocated ELFs are only read when present.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LEGACY_STACK, coinStack, isStackProfile, kitOf, parseStack, profileRolesDistinct, stackProfile, tokenElfLengthOf } from '../src/hooklab-stack.mjs'
import { derivedAddresses, holdingAddress, authorizationAddress } from '../src/hooklab-owner-driver/pins.mjs'
import { parseInclusiveMaxWalletProfile } from '../src/hooklab-inclusive-max-wallet-profile.mjs'
import { productionArtifacts, productionProfileJson } from '../src/hooklab-production-operator-bundle.mjs'
import { stackProductionArtifacts } from '../src/hooklab-production-stack-bundle.mjs'
import { hookCoinAddresses } from '../src/hooklab-inclusive-max-wallet-swap.mjs'
import { ownStack, OWN_STACK_SKIP, PLACEHOLDER_IDS } from './fixtures/hooklab-own-stack.mjs'

const legacyProfile = JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json', import.meta.url)))

test('the legacy stack is exactly bundle 2 as reviewed and deployed', () => {
  assert.deepEqual({ ...LEGACY_STACK.programs }, legacyProfile.programs)
  assert.equal(LEGACY_STACK.quoteMint, legacyProfile.quoteMint)
  assert.equal(kitOf(legacyProfile), LEGACY_STACK.kitProgram); assert.equal(tokenElfLengthOf(legacyProfile), 326504)
  assert.equal(isStackProfile(legacyProfile), false); assert.ok(profileRolesDistinct(legacyProfile))
})

test('addresses are derived only from the programs a caller passes: no stack is assumed', () => {
  assert.throws(() => derivedAddresses(), /programs is required/)
  assert.throws(() => holdingAddress(PLACEHOLDER_IDS.quoteMint, PLACEHOLDER_IDS.launch), /token program is required/)
  assert.throws(() => authorizationAddress(PLACEHOLDER_IDS.launch), /launch program is required/)
  const own = derivedAddresses({ launch: PLACEHOLDER_IDS.launch, swap: PLACEHOLDER_IDS.swap, gate: PLACEHOLDER_IDS.gate, token: PLACEHOLDER_IDS.token }, PLACEHOLDER_IDS.quoteMint)
  assert.equal(Object.keys(own).some(name => name.startsWith('bridge')), false, 'a stack without a bridge has no bridge addresses')
  assert.ok(Object.keys(derivedAddresses(LEGACY_STACK.programs, LEGACY_STACK.quoteMint)).includes('bridgeConfig'))
})

test('a profile is a stack (no bridge, names its stack) or legacy (with its bridge), never both or neither', () => {
  const { bridge, ...four } = legacyProfile.programs
  assert.throws(() => kitOf({ ...legacyProfile, programs: four }), /either a stack/)
  assert.throws(() => kitOf({ ...legacyProfile, stack: { kitProgram: PLACEHOLDER_IDS.gate } }), /either a stack/)
  assert.equal(coinStack({ source: 'open' }), 'own'); assert.equal(coinStack({ source: 'owner-invite' }), 'legacy'); assert.equal(coinStack(null), 'legacy')
})

test('our own stack: its profile carries its programs, marker, pins and kit, and every compiler derives from it', { skip: OWN_STACK_SKIP }, () => {
  const { stack, idls } = ownStack(), artifacts = stackProductionArtifacts(stack, idls), profile = artifacts.base
  assert.deepEqual(profile.programs, stack.programs); assert.equal(profile.quoteMint, PLACEHOLDER_IDS.quoteMint)
  assert.equal(profile.programs.bridge, undefined); assert.equal(profile.stack.upgradeAuthority, PLACEHOLDER_IDS.upgradeAuthority)
  assert.equal(kitOf(profile), stack.kitProgram); assert.deepEqual(profile.elfSha256.launch, stack.build.elf.launch.trimmedSha256)
  // The served profile (with the owner's menus) parses as a reviewed inclusive profile.
  const parsed = parseInclusiveMaxWalletProfile(JSON.parse(productionProfileJson(profile)))
  assert.equal(parsed.stack.id, stack.id)
  // The coin's accounts come from the stack: nothing in them is a legacy address.
  const a = hookCoinAddresses(profile, PLACEHOLDER_IDS.gate), legacy = hookCoinAddresses(productionArtifacts().base, PLACEHOLDER_IDS.gate)
  // (The kit's own PDA depends only on the kit and the mint; the placeholder stack keeps the legacy kit ID.)
  for (const [name, address] of Object.entries(a)) if (name !== 'kitConfig') assert.notEqual(address, legacy[name], name)
})

test('a stack descriptor is refused when its IDLs are not its build\'s or name other programs', { skip: OWN_STACK_SKIP }, () => {
  const { stack, idls } = ownStack(), base = productionArtifacts().base
  assert.throws(() => stackProfile(base, stack, { ...idls, launch: Buffer.from(readFileSync(new URL('../vendor/hooklab-native-candidate/open-36dd07e/bordrless_launch.json', import.meta.url))) }), /launch IDL differs/)
  const other = ownStack({ seed: 'other' })
  assert.throws(() => stackProfile(base, { ...stack, build: { ...stack.build, idlSha256: other.stack.build.idlSha256 } }, other.idls), /names another program/)
  assert.throws(() => parseStack({ ...stack, quoteMint: stack.programs.token }), /distinct/)
  assert.throws(() => parseStack({ ...stack, id: 'legacy' }))
})
