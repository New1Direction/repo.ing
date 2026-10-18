// Shared lookup table for customer trades. A buy or sell touches 35 accounts and fits a packet only
// when the 16 addresses common to every trade come from a table. Step 1 creates the table with
// exactly those addresses (payer is authority and payer); step 2 freezes it, so its bytes, and the
// production bundle's pin on them, can never change. Freezing is irreversible: the ~0.0057 SOL rent
// stays locked. Launches use their own per-launch tables (owner agent), not this one.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AddressLookupTableAccount, AddressLookupTableProgram, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js'
import { inclusiveMaxWalletSwapInventory } from '../../hooklab-inclusive-max-wallet-swap.mjs'
import { readAccounts } from '../rpc.mjs'
import * as ix from '../instructions.mjs'
import { ALT_PROGRAM, sha256 } from '../pins.mjs'
import { check, simpleMessage } from './common.mjs'

const recordPath = ctx => path.join(ctx.journal.dir, '..', 'trade-table.public.json')
const synthetic = label => Keypair.fromSeed(Buffer.from(sha256(`repo.ing shared trade table derivation ${label}`), 'hex')).publicKey.toBase58()
// The addresses every trade shares: the intersection of two trades with nothing else in common.
export function sharedTradeAddresses(envelope) {
  const profile = JSON.parse(envelope.json)
  const request = label => ({ schema: 'repoing/inclusive-max-wallet-swap-request/1', policyKind: 'max-wallet', policyVersion: 2, creatorFeeBps: profile.capability.creatorFeeBps,
    feeModel: 2, protocolShareBps: 2500, capBps: profile.capability.defaultCapBps ?? 200, side: 'buy', trader: synthetic(`${label} trader`), recipient: synthetic(`${label} trader`),
    feePayer: synthetic(`${label} trader`), mint: synthetic(`${label} mint`), selectedConfig: synthetic(`${label} config`), amountIn: '1', minAmountOut: '1', maxInput: '1', maxPriceImpactBps: 100 })
  const a = inclusiveMaxWalletSwapInventory(profile, request('a')), b = inclusiveMaxWalletSwapInventory(profile, request('b'))
  return a.filter(address => b.includes(address))
}
function record(ctx) { return existsSync(recordPath(ctx)) ? JSON.parse(readFileSync(recordPath(ctx), 'utf8')) : null }
function writeRecord(ctx, value) {
  mkdirSync(path.dirname(recordPath(ctx)), { recursive: true, mode: 0o700 })
  writeFileSync(`${recordPath(ctx)}.next`, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(`${recordPath(ctx)}.next`, recordPath(ctx))
}
async function readTable(ctx, address) {
  const snapshot = await readAccounts(ctx.readers, ctx.genesis, [address]), account = snapshot.accounts.get(address)
  if (!account) return { slot: snapshot.slot, table: null }
  check(account.owner === ALT_PROGRAM && !account.executable, 'Recorded trade table is not owned by the lookup-table program')
  const data = Buffer.from(account.dataBase64, 'base64')
  return { slot: snapshot.slot, table: { state: AddressLookupTableAccount.deserialize(data), sha256: sha256(data) } }
}

export const tradeTable = {
  name: 'trade-table',
  async build(ctx, pinned) {
    const payer = ctx.roles.payer, inventory = sharedTradeAddresses(ctx.envelope), existing = record(ctx)
    const base = await readAccounts(ctx.readers, ctx.genesis, [payer])
    if (!existing) {
      let recentSlot = pinned?.recentSlot
      if (recentSlot === undefined) {
        const hashes = (await ctx.readers[0].connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, 'finalized'))?.data
        check(hashes && hashes.readBigUInt64LE(0) > 0n, 'SlotHashes sysvar unavailable')
        recentSlot = Number(hashes.readBigUInt64LE(8))
      }
      const [create, table] = ix.lookupCreate(payer, payer, recentSlot)
      const { review, blockhash } = await simpleMessage(ctx, { stage: 'trade-table', payer, instructions: [create, ix.lookupExtend(payer, payer, table.toBase58(), inventory)], pinned, snapshot: base, units: 30000 })
      return { observedSlot: base.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, recentSlot },
        notes: ['step 1 of 2: create the shared trade table with every address common to all trades; run plan/execute trade-table again to freeze it', `recent slot ${recentSlot} must still be in SlotHashes (~200 s) at execution`],
        sections: [{ title: 'shared trade lookup table', rows: [`table ${table.toBase58()} (authority and payer ${payer})`, `${inventory.length} addresses, sha256 ${sha256(JSON.stringify(inventory))}`, ...inventory.map((a, i) => `  [${i}] ${a}`)] }],
        expect: { step: 'create', table: table.toBase58(), recentSlot, inventory } }
    }
    const { table } = await readTable(ctx, existing.address)
    check(table, 'Recorded trade table is missing on chain; refusing to create a replacement silently')
    check(isDeepStrictEqual(table.state.addresses.map(a => a.toBase58()), inventory), 'Trade table addresses differ from the shared trade inventory')
    if (!table.state.authority) return { blocked: `trade table ${existing.address} is complete and frozen; table data sha256 ${table.sha256} goes into the production bundle`, observedSlot: base.slot }
    check(table.state.authority.toBase58() === payer && table.state.deactivationSlot === 0xffffffffffffffffn, 'Trade table authority or activation differs')
    const freeze = AddressLookupTableProgram.freezeLookupTable({ lookupTable: new PublicKey(existing.address), authority: new PublicKey(payer) })
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'trade-table', payer, instructions: [freeze], pinned, snapshot: base, units: 30000 })
    return { observedSlot: base.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      notes: ['step 2 of 2: FREEZE the shared trade table. Irreversible: its addresses can never change and its rent (~0.0057 SOL) stays locked'],
      sections: [{ title: 'freeze shared trade lookup table', rows: [`table ${existing.address}: ${inventory.length} addresses, authority ${payer} -> none (permanent)`] }],
      expect: { step: 'freeze', table: existing.address, inventory } }
  },
  async verify(ctx, expect) {
    if (expect.step === 'create') writeRecord(ctx, { address: expect.table, recentSlot: expect.recentSlot, authority: ctx.roles.payer, inventorySha256: sha256(JSON.stringify(expect.inventory)) })
    const { table } = await readTable(ctx, expect.table)
    check(table && isDeepStrictEqual(table.state.addresses.map(a => a.toBase58()), expect.inventory), 'Trade table contents differ from the reviewed inventory')
    if (expect.step === 'freeze') check(!table.state.authority, 'Trade table is not frozen')
    return [`trade table ${expect.table} holds the ${expect.inventory.length} shared trade addresses${expect.step === 'freeze' ? '; frozen; data sha256 ' + table.sha256 : ''}`]
  },
}
