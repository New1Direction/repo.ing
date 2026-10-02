// Slippage tolerance for site trades, in basis points of the quoted output: 1% unless the trader picks a preset or a
// custom value. Solana Actions (Blinks) always use the default. Pure and dependency-free: the trade panel imports it too.
export const DEFAULT_SLIPPAGE_BPS = 100
export const MIN_SLIPPAGE_BPS = 50
export const MAX_SLIPPAGE_BPS = 2500
export const SLIPPAGE_PRESETS_BPS = Object.freeze([100, 300, 500, 1000, 2000])
// Meteora DBC and DAMM v2 both fail a swap that would pay out less than its minimum with ExceededSlippage (6002).
export const EXCEEDED_SLIPPAGE = 6002
export const SLIPPAGE_EXCEEDED = 'SLIPPAGE_EXCEEDED'
const SWAP_PROGRAMS = ['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG']

const inRange = bps => Number.isSafeInteger(bps) && bps >= MIN_SLIPPAGE_BPS && bps <= MAX_SLIPPAGE_BPS

// Strict: absent means the default; anything else must be an integer number of basis points in [50, 2500]. Never clamped.
export function parseSlippageBps(value) {
  if (value === undefined) return DEFAULT_SLIPPAGE_BPS
  if (!inRange(value)) throw Error('Invalid slippage: choose between 0.5% and 25%')
  return value
}

// The minimum output at this tolerance, floored exactly as both Meteora SDKs compute it. Traders require the SDK's own
// minimum to equal this before anything is signed.
export function minimumOutAfterSlippage(output, slippageBps) {
  if (!inRange(slippageBps)) throw Error('Invalid slippage: choose between 0.5% and 25%')
  const amount = BigInt(output)
  if (amount < 0n) throw Error('No executable output quote')
  return amount * BigInt(10_000 - slippageBps) / 10_000n
}

// The retry offered after a slippage failure: the next preset above the tolerance that failed, or null above 20%.
export const nextSlippagePreset = bps => SLIPPAGE_PRESETS_BPS.find(preset => preset > bps) ?? null

export const slippageLabel = bps => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`

// A typed custom percentage ("0.5", "3", "12.25") as basis points, or null when malformed or outside 0.5–25%.
export function parseSlippagePercent(text) {
  const match = /^(\d{0,2})(?:\.(\d{0,2}))?$/.exec(String(text ?? '').trim())
  if (!match || !(match[1] || match[2])) return null
  const bps = Number(match[1] || '0') * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return inRange(bps) ? bps : null
}

// Position of the one DBC or DAMM swap in a prepared transaction (wallet assertions are only ever appended after it).
export const swapInstructionIndex = instructions =>
  (instructions ?? []).findIndex(ix => SWAP_PROGRAMS.includes(ix?.programId?.toBase58?.()))

// A landed transaction's error, e.g. { InstructionError: [3, { Custom: 6002 }] }, raised by the prepared swap itself.
export function isSlippageError(err, swapIndex) {
  const [index, detail] = err?.InstructionError ?? []
  return swapIndex >= 0 && index === swapIndex && detail?.Custom === EXCEEDED_SLIPPAGE
}

// sendTransaction preflight refusal (web3.js SendTransactionError): the RPC node simulated the signed swap, saw it fail
// on the minimum and never forwarded it. Only the RPC message carries the instruction index and code.
export function isPreflightSlippageError(error, swapIndex) {
  const text = typeof error?.transactionMessage === 'string' ? error.transactionMessage : typeof error?.message === 'string' ? error.message : ''
  const match = /simulation failed[^]*?Error processing Instruction (\d+): custom program error: 0x([0-9a-f]+)/i.exec(text)
  return Boolean(match) && swapIndex >= 0 && Number(match[1]) === swapIndex && parseInt(match[2], 16) === EXCEEDED_SLIPPAGE
}
