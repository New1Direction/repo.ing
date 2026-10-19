// Synthetic finalized transactions of a coin on our own stack (hook-lab's placeholder IDs; native SOL only): its open
// launch (the launch program's OpenLaunchCreated, LaunchCreated and NativeLaunchCreated, the swap program's PoolCreated)
// and native swaps (each swap's Swapped and SwappedNative, emitted by the swap program under its own event authority), in
// the shape web3.js getTransaction returns. The event bytes are the reviewed IDLs' exact encodings. No keys, no RPC.
import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import BN from 'bn.js'
import { BorshCoder } from '@anchor-lang/core'
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { loadNativeArtifacts, loadOpenArtifacts } from '../../src/hooklab-native-pins.mjs'
import { hookCoinAddresses } from '../../src/hooklab-inclusive-max-wallet-swap.mjs'
import { LEGACY_KIT } from '../../src/hooklab-stack.mjs'
import { EMIT_CPI_TAG } from '../../src/hooklab-trade-events.mjs'
import { PLACEHOLDER_IDS } from './hooklab-own-stack.mjs'

const key = label => Keypair.fromSeed(createHash('sha256').update(`repo.ing own stack trades fixture ${label}`).digest()).publicKey
// The coin's profile as the trade runtime names it for a coin on our own stack (programs, marker, stack; no bridge).
export const ownProfile = Object.freeze({ programs: Object.freeze({ launch: PLACEHOLDER_IDS.launch, swap: PLACEHOLDER_IDS.swap, gate: PLACEHOLDER_IDS.gate, token: PLACEHOLDER_IDS.token }),
  quoteMint: PLACEHOLDER_IDS.quoteMint, stack: Object.freeze({ id: 'test-placeholder', build: 'relocated-open-36dd07e', upgradeAuthority: PLACEHOLDER_IDS.upgradeAuthority,
    kitProgram: LEGACY_KIT, tokenElfLength: 326504, open: true }) })
export const ownMint = key('mint').toBase58(), ownTrader = key('trader').toBase58(), ownCreator = key('creator').toBase58()
export const ownAddresses = hookCoinAddresses(ownProfile, ownMint)
const P = ownProfile.programs, authority = program => PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(program))[0]
const swapCoder = () => new BorshCoder(loadNativeArtifacts().idls.swap), launchCoder = () => new BorshCoder(loadOpenArtifacts().idls.launch)
const eventBytes = (coder, idl, name, data) => Buffer.concat([EMIT_CPI_TAG, Buffer.from(idl.events.find(e => e.name === name).discriminator), coder.types.encode(name, data)])
const pk = value => new PublicKey(value), bn = value => new BN(String(value))
export const signatureOf = n => bs58.encode(Buffer.alloc(64, n))

// One transaction: an outer instruction to `program` and its self-CPI events (program, name, data, coder role).
function transaction({ n, slot, program, events, extraKeys = [] }) {
  const payer = pk(ownTrader), outer = new TransactionInstruction({ programId: pk(program), data: Buffer.alloc(8),
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }, ...[ownAddresses.pool, ...extraKeys].map(a => ({ pubkey: pk(a), isSigner: false, isWritable: true })),
      ...[P.swap, P.launch].flatMap(p => [{ pubkey: authority(p), isSigner: false, isWritable: false }, { pubkey: pk(p), isSigner: false, isWritable: false }])] })
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: bs58.encode(Buffer.alloc(32, 7)), instructions: [outer] }).compileToV0Message()
  const keys = message.staticAccountKeys.map(k => k.toBase58()), index = address => keys.indexOf(address)
  // An event of the outer program is its self-CPI (height 2); another program's runs inside its own CPI from the outer one
  // (the launch's create_pool into the swap program at height 2, the swap's event at height 3).
  const inner = events.flatMap(({ program: emitter, bytes }) => {
    const event = height => ({ programIdIndex: index(emitter), accounts: [index(authority(emitter).toBase58())], data: bs58.encode(bytes), stackHeight: height })
    return emitter === program ? [event(2)] : [{ programIdIndex: index(emitter), accounts: [], data: bs58.encode(Buffer.alloc(8)), stackHeight: 2 }, event(3)]
  })
  return { slot, blockTime: 1800000000 + n, transaction: { signatures: [signatureOf(n)], message }, meta: { err: null, innerInstructions: [{ index: 0, instructions: inner }],
    loadedAddresses: { writable: [], readonly: [] } } }
}

// A native swap: Swapped (the trade) and SwappedNative (its lamports), as the native swap program emits them. edit lets a
// test bend either event; lone: only the Swapped (as a bridged pool would emit).
export function ownSwap({ n, slot, side = 'buy', amountIn = 1000000000n, out = 2000000000000n, swapCount = 1, creatorCut = 7500000n, platform = 2500000n,
  edit = {}, lone = false }) {
  const buy = side === 'buy', coder = swapCoder(), idl = loadNativeArtifacts().idls.swap
  const swapped = { pool: pk(ownAddresses.pool), trader: pk(ownTrader), recipient: pk(ownTrader), direction: buy ? 1 : 0, amount_in: bn(amountIn), deltas_in: [],
    burn_in: bn(0), cuts_in: bn(buy ? creatorCut : 0), received_in: bn(buy ? amountIn - creatorCut : amountIn), lp_fee: bn(0), protocol_fee: bn(platform), lp_fee_bps: 0,
    amount_out: bn(out), deltas_out: [], burn_out: bn(0), cuts_out: bn(buy ? 0 : creatorCut), delivered_out: bn(buy ? out : out - creatorCut - platform),
    base_reserve: bn(750000000000000n), quote_reserve: bn(5000000000n), virtual_base: bn(1000000000000000n), virtual_quote: bn(53251917070n), swap_count: bn(swapCount),
    slot: bn(slot), ts: bn(1800000000 + n), ...edit.swapped }
  const native = { pool: pk(ownAddresses.pool), direction: buy ? 1 : 0, quote_lamports: bn(buy ? amountIn - creatorCut : out - creatorCut - platform), quote_deltas: [],
    pool_lamports: bn(9000000000n), ...edit.native }
  return transaction({ n, slot, program: P.swap, events: [{ program: P.swap, bytes: eventBytes(coder, idl, 'Swapped', swapped) },
    ...(lone ? [] : [{ program: P.swap, bytes: eventBytes(coder, idl, 'SwappedNative', native) }])] })
}

// The coin's open launch: the launch program's events and the swap program's PoolCreated for the pool; no trade.
export function ownLaunch({ n, slot }) {
  const launch = launchCoder(), launchIdl = loadOpenArtifacts().idls.launch, swap = swapCoder(), swapIdl = loadNativeArtifacts().idls.swap
  const defaults = (coder, idl, name) => {
    const fill = type => typeof type === 'string' ? (type === 'pubkey' ? pk(ownMint) : type === 'bool' ? false : type === 'string' ? '' : ['u64', 'i64', 'u128', 'i128'].includes(type) ? bn(1) : 1)
      : type.option ? null : type.vec ? [] : type.array ? Array.from({ length: type.array[1] }, () => fill(type.array[0]))
        : Object.fromEntries(idl.types.find(t => t.name === type.defined.name).type.fields.map(f => [f.name, fill(f.type)]))
    return eventBytes(coder, idl, name, fill({ defined: { name } }))
  }
  const events = [...['OpenLaunchCreated', 'LaunchCreated', 'NativeLaunchCreated'].map(name => ({ program: P.launch, bytes: defaults(launch, launchIdl, name) })),
    { program: P.swap, bytes: defaults(swap, swapIdl, 'PoolCreated') }]
  return transaction({ n, slot, program: P.launch, events, extraKeys: [ownCreator] })
}
