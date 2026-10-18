// Canary request shapes, lookup-table record and CPI event decoding shared by canary stages.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import bs58 from 'bs58'
import { AddressLookupTableAccount } from '@solana/web3.js'
import { parseMaxWalletPreparationRequest } from '../../hooklab-inclusive-max-wallet-profile.mjs'
import { loadArtifacts } from '../artifacts.mjs'
import { value } from '../config.mjs'
import { ALT_PROGRAM, sha256, pda } from '../pins.mjs'
import { readAccounts } from '../rpc.mjs'
import { check } from './common.mjs'

export const EVENT_TAG = Buffer.from('e445a52e51cb9a1d', 'hex')
export const SELECTED_CONFIG_COMMAND = 'solana-keygen new --no-bip39-passphrase --silent --outfile "<owner custody dir>/selected-config-keypair.json"  # owner-run, inside custody; then set decisions.selectedConfig.value to its public key'

export function canaryBlocked(ctx) {
  const reasons = []
  if (!ctx.roles.selectedConfig) reasons.push(`selectedConfig not chosen (owner approval required to generate it; the tool never generates it). Command the owner would run: ${SELECTED_CONFIG_COMMAND}`)
  if (value(ctx.config, 'capBps') === null) reasons.push('capBps not chosen (owner chooses 100 or 200)')
  return reasons.length ? reasons.join('; ') : null
}
export function preparationRequest(ctx) {
  const launch = value(ctx.config, 'canaryLaunch')
  return parseMaxWalletPreparationRequest({ schema: 'repoing/inclusive-max-wallet-preparation-request/1', policyKind: 'max-wallet', policyVersion: 2,
    creator: ctx.roles.creator, feePayer: ctx.roles.creator, mint: ctx.roles.mint, selectedConfig: ctx.roles.selectedConfig, capBps: value(ctx.config, 'capBps'),
    label: launch.label, creatorFeeBps: value(ctx.config, 'creatorFeeBps'), rules: 'none', hookFlags: 1, feeModel: 2, protocolShareBps: 2500 })
}
export function launchRequest(ctx) {
  const launch = value(ctx.config, 'canaryLaunch'), prep = preparationRequest(ctx)
  return { ...prep, schema: 'repoing/inclusive-max-wallet-launch-request/1', reviewer: ctx.roles.admin, name: launch.name, symbol: launch.symbol, uri: launch.uri, virtualQuote: launch.virtualQuote }
}
export function swapRequest(ctx, side, amountIn, minAmountOut, maxPriceImpactBps) {
  return { schema: 'repoing/inclusive-max-wallet-swap-request/1', policyKind: 'max-wallet', policyVersion: 2, creatorFeeBps: value(ctx.config, 'creatorFeeBps'), feeModel: 2,
    protocolShareBps: 2500, capBps: value(ctx.config, 'capBps'), side, trader: ctx.roles.creator, recipient: ctx.roles.creator, feePayer: ctx.roles.creator,
    mint: ctx.roles.mint, selectedConfig: ctx.roles.selectedConfig, amountIn: String(amountIn), minAmountOut: String(minAmountOut), maxInput: String(amountIn), maxPriceImpactBps }
}
// Durable public record of the canary lookup table address (written after step one finalizes).
export const altRecordPath = ctx => path.join(ctx.journal.dir, '..', 'alt.public.json')
export function altRecord(ctx) {
  const decided = value(ctx.config, 'lookupTable')
  if (existsSync(altRecordPath(ctx))) {
    const record = JSON.parse(readFileSync(altRecordPath(ctx), 'utf8'))
    check(!decided || decided === record.address, 'Config lookupTable differs from the recorded canary lookup table')
    return record
  }
  return decided ? { address: decided } : null
}
export function writeAltRecord(ctx, record) {
  mkdirSync(path.dirname(altRecordPath(ctx)), { recursive: true, mode: 0o700 })
  writeFileSync(`${altRecordPath(ctx)}.next`, JSON.stringify(record, null, 2), { mode: 0o600 })
  renameSync(`${altRecordPath(ctx)}.next`, altRecordPath(ctx))
}
/** Reads the recorded lookup table from both providers and returns the compiler-shaped pin. */
export async function readLookupTable(ctx) {
  const record = altRecord(ctx)
  if (!record) return null
  const snapshot = await readAccounts(ctx.readers, ctx.genesis, [record.address])
  const account = snapshot.accounts.get(record.address)
  if (!account) return null
  check(account.owner === ALT_PROGRAM && !account.executable, 'Recorded lookup table is not owned by the lookup-table program')
  const data = Buffer.from(account.dataBase64, 'base64'), state = AddressLookupTableAccount.deserialize(data)
  return { pin: { address: record.address, owner: ALT_PROGRAM, dataBase64: account.dataBase64, sha256: sha256(data) }, state, slot: snapshot.slot }
}
/** Decode emit_cpi events (self-CPI to the program's event authority) from a finalized transaction. */
export function cpiEvents(tx, programs) {
  const { coders } = loadArtifacts()
  const loaded = tx.meta.loadedAddresses ?? { writable: [], readonly: [] }
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: loaded })
  const addresses = Array.from({ length: keys.length }, (_, i) => keys.get(i).toBase58()), out = []
  const roles = Object.entries(programs)
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const inner of group.instructions) {
      const program = addresses[inner.programIdIndex], role = roles.find(([, id]) => id === program)?.[0]
      if (!role || !coders[role]) continue
      const data = Buffer.from(bs58.decode(inner.data))
      if (!data.subarray(0, 8).equals(EVENT_TAG)) continue
      check(inner.accounts.length === 1 && addresses[inner.accounts[0]] === pda(program, '__event_authority'), 'Event CPI is not from the program event authority')
      const event = coders[role === 'token' ? 'token' : role].events.decode(data.subarray(8).toString('base64'))
      if (event) out.push({ index: group.index, program, role, name: event.name, data: event.data })
    }
  }
  return out
}
