import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'

const WSOL = 'So11111111111111111111111111111111111111112'
// SOL (WSOL) vaults of the canonical $REPOING pools, verified from pool state: the DBC curve
// Gda7Sig9… quote vault (buys before graduation) and the DAMM v2 pool FHw49kTE… token B vault.
export const REPOING_SOL_VAULTS = Object.freeze(['HM9dEZ1Z6Wc32v3espfFLhQ3yojkjrumcVAaMKdqpUNo', '9gu44zqNnRCxCt9jkrAmC3UBczYyuLbeJvGDsRJfYbur'])
// Launch buy and early team purchases precede this and are not buybacks.
export const BUYBACK_SINCE = '2026-09-27T21:00:00.000Z'

// Per token account: net change across the transaction. A missing side is a created or closed account.
function tokenDeltas(meta) {
  const accounts = new Map()
  for (const [side, list] of [['pre', meta.preTokenBalances], ['post', meta.postTokenBalances]]) for (const entry of list ?? []) {
    const account = accounts.get(entry.accountIndex) ?? { index: entry.accountIndex, mint: entry.mint, owner: entry.owner, pre: 0n, post: 0n }
    if (account.mint !== entry.mint || account.owner !== entry.owner) return null
    account[side] = BigInt(entry.uiTokenAmount.amount)
    accounts.set(entry.accountIndex, account)
  }
  return [...accounts.values()].map(account => ({ ...account, delta: account.post - account.pre }))
}

// Every account of the transaction, in index order: its static keys, then the ones a lookup table loaded.
const accountKeys = tx => [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])].map(String)

// A finalized, successful buy of $REPOING through the canonical pool paid by `wallet`, or null.
// spentLamports is the swap input (trading and route fees included): WSOL gained by token accounts
// the wallet does not own. Network fees and refundable rent are excluded. Anything ambiguous is null.
export function detectBuyback(tx, { wallet, source, mint = OFFICIAL_TOKEN.mint, vaults = REPOING_SOL_VAULTS, since = BUYBACK_SINCE }) {
  const meta = tx?.meta, message = tx?.transaction?.message
  if (!meta || meta.err !== null || !message || !Number.isSafeInteger(tx.blockTime)) return null
  if (tx.blockTime * 1000 < Date.parse(since)) return null
  const keys = accountKeys(tx)
  const payer = keys.indexOf(wallet)
  // Only a signer can spend its own SOL; the wallet must have paid.
  if (payer < 0 || payer >= message.header.numRequiredSignatures || !(BigInt(meta.postBalances[payer]) < BigInt(meta.preBalances[payer]))) return null
  const deltas = tokenDeltas(meta)
  if (!deltas) return null
  // Exactly one canonical vault moves, and it gains SOL. Sells, migrations and multi-pool routes are not receipts.
  const pools = deltas.filter(account => vaults.includes(keys[account.index]) && account.delta !== 0n)
  if (pools.length !== 1 || pools[0].mint !== WSOL || pools[0].delta <= 0n) return null
  const bought = deltas.filter(account => account.mint === mint && account.owner === wallet)
  if (bought.some(account => account.delta < 0n)) return null
  const tokenBaseUnits = bought.reduce((sum, account) => sum + account.delta, 0n)
  if (tokenBaseUnits <= 0n) return null
  const spentLamports = deltas.filter(account => account.mint === WSOL && account.owner !== wallet && account.delta > 0n)
    .reduce((sum, account) => sum + account.delta, 0n)
  const signature = tx.transaction.signatures?.[0]
  if (!signature) return null
  return { signature, source, wallet, mint, spentLamports: String(spentLamports), tokenBaseUnits: String(tokenBaseUnits),
    at: new Date(tx.blockTime * 1000).toISOString(), slot: String(tx.slot) }
}

// Where a buy that detectBuyback accepted put its tokens: the wallet's token account with the largest gain.
export function buybackTokenAccount(tx, { wallet, mint = OFFICIAL_TOKEN.mint }) {
  const gains = (tokenDeltas(tx.meta) ?? []).filter(account => account.mint === mint && account.owner === wallet && account.delta > 0n)
  const largest = gains.reduce((best, account) => !best || account.delta > best.delta ? account : best, null)
  return largest ? accountKeys(tx)[largest.index] : null
}
