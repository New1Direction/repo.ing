import { createHmac } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { NOTE_PAGE_SIZE, createHolderNotes, createNoteStore } from '../../src/holder-notes.mjs'
import { chain, database } from './server.mjs'
import { sumTokenAccountBalances } from './token-balance.mjs'
import { createBalanceCache, readAtaBalances } from './holder-note-balances.mjs'
import { publicNote } from './holder-note-format.mjs'
export { publicNote }

const MAX_OFFSET = 500
const BALANCE_TIMEOUT_MS = 3000

// One cache per server process (shared across requests and hot reloads). A slow RPC never holds the notes back:
// after the timeout the badges fall back to the post-time balance (never "sold").
const withTimeout = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error('Balance read timed out')), BALANCE_TIMEOUT_MS).unref?.())])
const cachedBalances = () => globalThis.__repoingNoteBalances ??= createBalanceCache({ fetchBalances: (mint, wallets) => withTimeout(readAtaBalances(chain(), mint, wallets)) })

// Post-time check: every token account the wallet owns for this mint (SPL Token or Token-2022, whichever the mint uses).
async function readWalletBalance(wallet, mint) {
  const accounts = await chain().getTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mint) }, { commitment: 'confirmed', dataSlice: { offset: 64, length: 8 } })
  return BigInt(sumTokenAccountBalances(accounts.value))
}

export function holderNotesService() {
  const pool = database()
  if (!pool) return null
  const store = createNoteStore(pool)
  return { store, notes: createHolderNotes({ store, readBalance: readWalletBalance }) }
}

// Rate-limit key only: the raw address is never stored.
export function clientKey(request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown'
  return createHmac('sha256', process.env.GITHUB_APP_CLIENT_SECRET || 'repo.ing holder notes').update(ip.slice(0, 64)).digest('hex').slice(0, 32)
}

// Newest first, hidden notes excluded, with lazily re-checked holder balances.
export async function holderNotesPage(mint, offset = 0) {
  const service = holderNotesService()
  if (!service) return { notes: [], hasMore: false, unavailable: true }
  const start = Math.min(Math.max(0, Math.trunc(Number(offset) || 0)), MAX_OFFSET)
  const { notes, hasMore } = await service.store.list(mint, { offset: start, limit: NOTE_PAGE_SIZE })
  const balances = notes.length ? await cachedBalances()(mint, notes.map(n => n.wallet)) : new Map()
  return { notes: notes.map(note => publicNote(note, balances.get(note.wallet) ?? null)), hasMore: hasMore && start + NOTE_PAGE_SIZE < MAX_OFFSET }
}
