// Chain truth for an ownerless (open) launch, independent of the site's settlement code: the launch Config's open-creation
// state (switch and menus at bytes 187..204), and one finalized create_launch_open_v1 checked against it: only the creator
// and the mint signed, the fee and cap are on the chain's menus, the creation fee and the pool creation fee went to the
// treasury exactly, the creator paid exactly fee + those + the rent of what was created, and the events came in order.
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'
import bs58 from 'bs58'
import { expect } from 'e2e'
import { PROGRAMS, accountKeys, allDeltas, coders, lamportDelta } from './chain.ts'
import { connection, stack } from './stack.ts'

const idl = (file: string) => JSON.parse(readFileSync(new URL(`../../../../vendor/${file}`, import.meta.url), 'utf8'))
// The open-creation launch IDL (hook-lab feat/open-creation 36dd07e), at this stack's launch program ID.
// (our own stack's launch IDL when the stack runs it; it carries the same open-creation instruction and events)
export const openCoder = stack.idlDir ? coders.launch : new BorshCoder({ ...idl('hooklab-native-candidate/open-36dd07e/bordrless_launch.json'), address: PROGRAMS.launch })
const swapCoder = stack.idlDir ? coders.swap : new BorshCoder({ ...idl('hooklab-native-candidate/bordrless_swap.json'), address: PROGRAMS.swap })
const EMIT_CPI = Buffer.from('e445a52e51cb9a1d', 'hex')
const configAddress = (program: string) => PublicKey.findProgramAddressSync([Buffer.from('config')], new PublicKey(program))[0]

export interface OpenCreationState { native: boolean; open: boolean; feeMenu: number[]; capMenu: number[]; launchFeeLamports: bigint; paused: boolean; poolCreationFeeLamports: bigint; treasury: string; revision: bigint }

/** The launch Config's open-creation bytes and fees, plus the swap Config's pool creation fee, at finalized. */
export async function openCreationState(): Promise<OpenCreationState> {
  const [launchInfo, swapInfo] = await connection.getMultipleAccountsInfo([configAddress(PROGRAMS.launch), configAddress(PROGRAMS.swap)], 'finalized')
  const raw = Buffer.from(launchInfo!.data), menu = (at: number) => Array.from({ length: 4 }, (_, i) => raw.readUInt16LE(at + 2 * i)).filter(v => v !== 0)
  const config = openCoder.accounts.decode('Config', raw), swap = swapCoder.accounts.decode('Config', Buffer.from(swapInfo!.data))
  const governance = await connection.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from('governance')], new PublicKey(PROGRAMS.launch))[0], 'finalized')
  const gov = openCoder.accounts.decode('Governance', Buffer.from(governance!.data))
  return { native: raw[186] === 1, open: raw[187] === 1, feeMenu: menu(188), capMenu: menu(196), launchFeeLamports: BigInt(config.launch_fee_lamports.toString()),
    // Creation is paused by the Config's flag or by the guardian's emergency pause (the launch governance's creation gate).
    paused: !!config.paused || !!gov.state.gates.creation, poolCreationFeeLamports: BigInt(swap.pool_creation_fee_lamports.toString()), treasury: config.treasury.toBase58(),
    revision: BigInt(gov.state.revision.toString()) }
}

export function openEvents(tx: VersionedTransactionResponse): { name: string; data: any }[] {
  const keys = accountKeys(tx), out: { name: string; data: any }[] = []
  for (const group of tx.meta?.innerInstructions ?? []) for (const ix of group.instructions) {
    if (keys[ix.programIdIndex] !== PROGRAMS.launch) continue
    const bytes = Buffer.from(bs58.decode(ix.data))
    if (!bytes.subarray(0, 8).equals(EMIT_CPI)) continue
    const decoded = openCoder.events.decode(bytes.subarray(8).toString('base64'))
    if (decoded) out.push({ name: decoded.name, data: decoded.data })
  }
  return out
}

/** One finalized open launch, exactly. Returns the chosen fee and cap and the creator's total debit. */
export function expectOpenLaunch(tx: VersionedTransactionResponse, { creator, mint, state, feeBps, capBps }:
  { creator: string; mint: string; state: OpenCreationState; feeBps: number; capBps: number }): { debit: bigint; rent: bigint } {
  expect(tx.meta?.err).toBeNull()
  const keys = accountKeys(tx), header = tx.transaction.message.header
  // Only the creator and the mint sign: no admin, no reviewer, no grant.
  expect(keys.slice(0, header.numRequiredSignatures).sort()).toEqual([creator, mint].sort())
  const top = tx.transaction.message.compiledInstructions.filter(ix => keys[ix.programIdIndex] === PROGRAMS.launch)
    .map(ix => openCoder.instruction.decode(Buffer.from(ix.data))?.name)
  expect(top).toEqual(['create_launch_open_v1'])
  const events = openEvents(tx)
  expect(events.map(e => e.name)).toEqual(['OpenLaunchCreated', 'LaunchCreated', 'NativeLaunchCreated'])
  const opened = events[0].data, created = events[1].data
  expect([opened.creator.toBase58(), opened.mint.toBase58(), opened.creator_fee_bps, opened.cap_bps]).toEqual([creator, mint, feeBps, capBps])
  expect(state.feeMenu.includes(feeBps) && state.capMenu.includes(capBps)).toBe(true) // fee and cap only from the chain's menus
  expect(BigInt(created.launch_fee_lamports.toString())).toBe(state.launchFeeLamports)
  // The treasury receives the creation fee and the pool creation fee, exactly.
  expect(lamportDelta(tx, state.treasury)).toBe(state.launchFeeLamports + state.poolCreationFeeLamports)
  // The creator pays the network fee, both fees and the rent of every account the launch created, nothing else.
  const deltas = allDeltas(tx), rent = Object.entries(deltas).filter(([address, d]) => address !== state.treasury && address !== creator && BigInt(d) > 0n)
    .reduce((sum, [, d]) => sum + BigInt(d), 0n)
  const debit = BigInt(tx.meta!.fee) + state.launchFeeLamports + state.poolCreationFeeLamports + rent
  expect(lamportDelta(tx, creator)).toBe(-debit)
  return { debit, rent }
}
