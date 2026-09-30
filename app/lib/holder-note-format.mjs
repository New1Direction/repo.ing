// Client-safe formatting for holder notes. Market tokens use 6 decimals.
export const NOTE_MAX = 280
const DECIMALS = 6

export const shortWallet = wallet => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`

// "1.2M", "850K", "12.5", never rounding a nonzero holding down to 0.
export function holdingLabel(balanceBaseUnits) {
  const raw = BigInt(balanceBaseUnits ?? 0)
  if (raw > 0n && raw < 10n ** BigInt(DECIMALS - 2)) return '<0.01'
  const value = Number(raw) / 10 ** DECIMALS
  return value.toLocaleString('en-US', value >= 1000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 })
}

// Public shape of a note. balance: the lazily re-checked current balance (bigint) or null when unknown; unknown falls
// back to the balance verified at post time and is never shown as sold.
export const publicNote = (note, balance) => ({ id: note.id, wallet: note.wallet, body: note.body, updatedAt: new Date(note.updatedAt).toISOString(),
  balance: (balance ?? BigInt(note.balanceAtPost)).toString(), sold: balance === 0n })
