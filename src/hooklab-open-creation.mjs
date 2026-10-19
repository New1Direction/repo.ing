// The chain's open-creation state, for the creator's form and the server's reserve check: the launch Config's switches
// and menus (src/hooklab-launch-config-reserved.mjs), its creation fee and opening-price bounds, and whether creation is
// paused (Config.paused, or the launch governance's creation gate). Read at finalized from both providers, which must
// return identical bytes. Read-only; no keys.
import { createHash } from 'node:crypto'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { loadNativeArtifacts, loadOpenArtifacts } from './hooklab-native-pins.mjs'
import { LAUNCH_CONFIG_RESERVED_AT, parseLaunchConfigReserved } from './hooklab-launch-config-reserved.mjs'
import { LAUNCH_ACCOUNT_BYTES } from './hooklab-native-launch.mjs'

const fail = message => Object.assign(Error(message), { code: 'OPEN_CREATION_UNAVAILABLE' })

// HOOK_OPEN_LAUNCHES=true: self-serve launches (after the open-launches migration). The site's coin pages, metadata and
// listing serve coins from either path while owner-approved launches remain readable.
export const openLaunchesEnabled = env => env?.HOOK_OPEN_LAUNCHES === 'true'
export const siteLaunchesEnabled = env => env?.HOOK_OWNER_APPROVED_LAUNCHES === 'true' || openLaunchesEnabled(env)
const pda = (program, seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(program))[0]

// The accounts a self-serve launch creates, by size: the preparation's policy, its registry and the selected config, then
// the launch's (measured on our own stack): the inclusive fee policy, the pool registry, five holdings, the pool, the
// coin and LP mints, and the launch. Their rent at the chain's current rate is what the creator locks.
export const PREPARATION_ACCOUNT_SIZES = Object.freeze([90, 81, 176])
export const LAUNCH_ACCOUNT_SIZES = Object.freeze([75, 186, 204, 204, 204, 204, 204, 411, 519, 519, LAUNCH_ACCOUNT_BYTES])
export const OPEN_LAUNCH_ACCOUNT_SIZES = Object.freeze([...PREPARATION_ACCOUNT_SIZES, ...LAUNCH_ACCOUNT_SIZES])
// Kept above the exact figure so a launch never fails on a rounding difference; small next to the rent itself.
export const LAUNCH_RENT_MARGIN_LAMPORTS = 100000n
// The rent of a self-serve launch at the chain's current rate (rentFor: size -> lamports, e.g. the provider's
// getMinimumBalanceForRentExemption). guard: the bound the launch's debit guard is signed with. The program counts the
// launch account's rent twice (what the creator paid, plus Rent::minimum_balance(Launch::LEN)), so the bound is the launch
// transaction's rent, the launch account's rent again, and the margin.
export async function openLaunchRent(rentFor) {
  const sum = async sizes => (await Promise.all(sizes.map(size => rentFor(size)))).reduce((total, value) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw fail('Rent unavailable'); return total + BigInt(value) }, 0n)
  const preparation = await sum(PREPARATION_ACCOUNT_SIZES), launch = await sum(LAUNCH_ACCOUNT_SIZES), launchAccount = await sum([LAUNCH_ACCOUNT_BYTES])
  return Object.freeze({ preparation, launch, guard: launch + launchAccount + LAUNCH_RENT_MARGIN_LAMPORTS })
}

// The highest creator fee an open launch may choose under a launch Config: min(max_creator_fee_bps, max_rules_fee_bps).
export const openCreatorFeeCeiling = config => Math.min(config.max_creator_fee_bps, config.rule_bounds.max_rules_fee_bps)

// programs: the stack's { launch, swap } (the launch program alone still reads everything but the pool fee).
export async function readOpenCreation(connections, programs) {
  if (!Array.isArray(connections) || connections.length !== 2) throw fail('Two providers required')
  const { launch: launchProgram, swap: swapProgram = null } = typeof programs === 'string' ? { launch: programs } : programs
  const owners = [launchProgram, launchProgram, ...(swapProgram ? [swapProgram] : [])]
  const keys = [pda(launchProgram, 'config'), pda(launchProgram, 'governance'), ...(swapProgram ? [pda(swapProgram, 'config')] : [])]
  const views = await Promise.all(connections.map(({ connection }) => connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized' })))
  const [config, governance, swapConfig] = keys.map((_, i) => {
    const [a, b] = views.map(v => v.value[i])
    if (!a || !b || !a.owner.equals(b.owner) || !Buffer.from(a.data).equals(Buffer.from(b.data)) || a.owner.toBase58() !== owners[i]) throw fail('Launch configuration unavailable or providers disagree')
    return Buffer.from(a.data)
  })
  const { coders } = loadNativeArtifacts(), c = coders.launch.accounts.decode('Config', config), g = coders.launch.accounts.decode('Governance', governance)
  const reserved = parseLaunchConfigReserved(config.subarray(LAUNCH_CONFIG_RESERVED_AT))
  if (!reserved) throw fail('Launch configuration is in a state the reviewed programs never write')
  const rent = await openLaunchRent(size => connections[0].connection.getMinimumBalanceForRentExemption(size, 'finalized'))
  // The creator fees on offer: the on-chain menu under the current ceiling, the lower of max_creator_fee_bps and
  // rule_bounds.max_rules_fee_bps (the program does not re-check its menu when the owner lowers either). The site offers
  // and accepts only these.
  const ceiling = openCreatorFeeCeiling(c)
  return Object.freeze({ native: reserved.native, open: reserved.open, paused: c.paused || g.state.gates.creation,
    creatorFeeBps: Object.freeze(reserved.creatorFeeBps.filter(bps => bps <= ceiling)), capBps: Object.freeze([...reserved.capBps]), maxCreatorFeeBps: ceiling,
    launchFeeLamports: c.launch_fee_lamports.toString(), minVirtualQuote: c.min_virtual_quote.toString(), maxVirtualQuote: c.max_virtual_quote.toString(),
    ...(swapConfig ? { poolCreationFeeLamports: coders.swap.accounts.decode('Config', swapConfig).pool_creation_fee_lamports.toString() } : {}),
    // rentLamports: what the creator locks (preparation and launch); guardRentLamports: the launch's signed rent bound.
    rentLamports: String(rent.preparation + rent.launch), preparationRentLamports: String(rent.preparation), launchRentLamports: String(rent.launch),
    guardRentLamports: String(rent.guard) })
}

// The owner's governed switch (hook-lab feat/open-creation): open creation on or off with the two menus, recorded as a
// policy change digest = sha256("hook-lab:open-creation:v1" || launch program || config || on u8 || fee 4 x u16 LE ||
// cap 4 x u16 LE). Accounts as governed_set_native_launches: admin (signer), config and governance (writable), the event
// authority and the program. The program refuses menus that are not strictly ascending, a fee above the Config's
// ceiling, a cap outside 1..9999, empty menus when turning on, and the same state again.
const slots = menu => { const out = [...menu]; while (out.length < 4) out.push(0); return out }
export function openCreationDigest(launchProgram, config, { on, creatorFeeBps, capBps }) {
  const menus = Buffer.alloc(16); slots(creatorFeeBps).forEach((v, i) => menus.writeUInt16LE(v, 2 * i)); slots(capBps).forEach((v, i) => menus.writeUInt16LE(v, 8 + 2 * i))
  return createHash('sha256').update(Buffer.concat([Buffer.from('hook-lab:open-creation:v1'), new PublicKey(launchProgram).toBuffer(), new PublicKey(config).toBuffer(), Buffer.from([on ? 1 : 0]), menus])).digest()
}
export function governedSetOpenCreation({ launchProgram, admin, expected, on, creatorFeeBps, capBps }) {
  const commitment = Buffer.from(expected)
  if (commitment.length !== 32 || (on !== true && on !== false) || creatorFeeBps.length > 4 || capBps.length > 4) throw fail('Expected a 32-byte commitment, on or off, and at most 4 choices per menu')
  const meta = (pubkey, isSigner, isWritable) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable })
  return new TransactionInstruction({ programId: new PublicKey(launchProgram),
    keys: [meta(admin, true, false), meta(pda(launchProgram, 'config'), false, true), meta(pda(launchProgram, 'governance'), false, true),
      meta(pda(launchProgram, '__event_authority'), false, false), meta(launchProgram, false, false)],
    data: loadOpenArtifacts().coders.launch.instruction.encode('governed_set_open_creation', { expected: [...commitment], on, fee_menu: slots(creatorFeeBps), cap_menu: slots(capBps) }) })
}

// A launch or setup review while the chain's launch settings differ from the server's reviewed bundle (after the owner
// changes them, until the bundle is collected again). Shown to the creator as is; trading, selling and claims carry on.
export const LAUNCH_SETTINGS_CHANGED = 'repo.ing is updating its launch settings. Try again in a few minutes. Nothing was signed or spent.'
export const launchSettingsChanged = () => Object.assign(Error(LAUNCH_SETTINGS_CHANGED), { code: 'HOOKLAB_USER_REFUSAL' })
const isRefusal = error => error?.code === 'HOOKLAB_USER_REFUSAL'
export const passRefusal = (error, masked) => { throw isRefusal(error) ? error : masked() }

// Plain text for the launch program's errors a creator can meet in an open launch (hook-lab feat/open-creation ABI).
const OPEN_LAUNCH_ERRORS = Object.freeze({
  6120: 'Open launches are switched off right now. Try again later.',
  6121: 'That creator fee or max-per-wallet choice is no longer offered. Pick one from the current list and review again.',
  6122: 'This coin\'s launch settings belong to another wallet. Start again from your own wallet.',
  6123: 'repo.ing\'s launch menu is being updated. Try again in a few minutes.',
  6124: 'repo.ing\'s launch settings did not change.',
  6055: 'Launches are paused right now. Your SOL was not spent; try again later.',
  6056: 'repo.ing\'s launch settings changed while you were signing. Review again to get a fresh transaction.',
  6103: 'Launches with ordinary SOL are switched off right now. Try again later.',
})
export const openLaunchErrorText = code => OPEN_LAUNCH_ERRORS[code] ?? null
