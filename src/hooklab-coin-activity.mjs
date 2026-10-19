// Display-only chain reads behind a Hooks coin's chart, trades and holders: the three RPC methods the trade index and
// the holders list use (never a send), and the holders list itself. Hooks coins are not SPL tokens: a holding is a
// 204-byte account of the Hook Lab token program at ["holding", mint, owner].
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { binding } from './hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS, holdingAddress } from './hooklab-owner-driver/pins.mjs'

const fail = code => { throw Object.assign(Error(code), { code }) }
const check = (ok, code) => { if (!ok) fail(code) }
// Holding layout (bordrless_token IDL): 8-byte discriminator, version u8, bump u8, mint, owner, amount u64, ...
export const HOLDING = Object.freeze({ size: 204, mint: 10, owner: 42, amount: 74, read: 82 })

// connection: the trade runtime's primary provider (the one the coin page's market read uses).
export function hookActivityRpc(connection, { programs = PROGRAMS } = {}) {
  return Object.freeze({
    signatures: (pool, { before, until, limit }) => connection.getSignaturesForAddress(new PublicKey(pool), { before, until, limit }, 'finalized'),
    transaction: signature => connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
    // Every holding of one mint, up to its amount: the program filters by size and by the mint at its offset.
    holdings: mint => connection.getProgramAccounts(new PublicKey(programs.token), { commitment: 'confirmed', encoding: 'base64', withContext: true,
      dataSlice: { offset: 0, length: HOLDING.read }, filters: [{ dataSize: HOLDING.size }, { memcmp: { offset: HOLDING.mint, bytes: mint } }] }),
  })
}

// Accounts that hold a coin but are not traders, by the owner of their holding (hookCoinAddresses): the pool's vault
// (the bonding curve until graduation, then the liquidity pool), the launch's reserve, and anything the LP mint owns.
export function hookHolderLabels(addresses, { graduated = false } = {}) {
  return new Map([[addresses.pool, graduated ? 'Liquidity pool' : 'Bonding curve'], [addresses.launch, 'Launch reserve'], [addresses.lpMint, 'Liquidity (LP)']])
}

// The coin's holders with a balance, largest first: labelled non-trader accounts (no rank) first, then up to `limit`
// ranked holders. supply: the mint's current supply (raw units), for each holder's share. Every listed row is checked: its
// account belongs to the token program, is a Holding of this mint, and sits at the holding address of its owner.
export async function readHookCoinHolders({ rpc, mint, supply, labels = new Map(), limit = 50, programs = PROGRAMS }) {
  const total = BigInt(supply)
  check(total > 0n, 'HOOK_HOLDERS_SUPPLY_INVALID')
  const response = await rpc.holdings(mint), mintBytes = new PublicKey(mint).toBuffer()
  const discriminator = Buffer.from(binding('token').idl.accounts.find(a => a.name === 'Holding').discriminator)
  check(Array.isArray(response?.value) && Number.isSafeInteger(response.context?.slot), 'HOOK_HOLDERS_UNAVAILABLE')
  const all = []
  for (const { pubkey, account } of response.value) {
    const data = Buffer.from(account?.data ?? [])
    check(account?.owner?.toBase58?.() === programs.token && data.length === HOLDING.read && data.subarray(0, 8).equals(discriminator)
      && data.subarray(HOLDING.mint, HOLDING.mint + 32).equals(mintBytes), 'HOOK_HOLDERS_ACCOUNT_INVALID')
    const amount = data.readBigUInt64LE(HOLDING.amount)
    if (amount === 0n) continue
    all.push({ holding: pubkey.toBase58(), owner: bs58.encode(data.subarray(HOLDING.owner, HOLDING.owner + 32)), amount })
  }
  all.sort((a, b) => a.amount === b.amount ? (a.owner < b.owner ? -1 : 1) : a.amount > b.amount ? -1 : 1)
  const labelled = all.filter(row => labels.has(row.owner)), ranked = all.filter(row => !labels.has(row.owner))
  const shown = [...labelled, ...ranked.slice(0, limit)]
  for (const row of shown) check(holdingAddress(mint, row.owner, programs.token) === row.holding, 'HOOK_HOLDERS_ACCOUNT_INVALID')
  const percent = amount => Number(amount * 1_000_000n / total) / 10_000
  return { observedSlot: response.context.slot, supply: String(total), holderCount: ranked.length,
    holders: shown.map(row => ({ rank: labels.has(row.owner) ? null : ranked.indexOf(row) + 1, owner: row.owner, holding: row.holding,
      amount: String(row.amount), percent: percent(row.amount), label: labels.get(row.owner) ?? null })) }
}
