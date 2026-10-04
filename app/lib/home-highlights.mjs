import { formatSolDisplay } from './format.mjs'
import { formatWholeSol } from './repoing-case.mjs'
import { buybackSummary } from './buyback-summary.mjs'

const AMOUNT = /^\d+(\.\d+)?$/
const lamports = value => AMOUNT.test(String(value ?? '')) ? BigInt(String(value).split('.')[0]) : 0n

// The hero's proof line, each figure only while it is known: all-time trading (whole SOL, floored), builder payouts,
// and buybacks (every published receipt, linking to them).
export function proofFacts({ totals = null, receipts = null } = {}) {
  const facts = [], traded = totals ? formatWholeSol(totals.volume) : null
  if (traded && traded !== '0') facts.push({ id: 'traded', value: `${traded} SOL`, label: 'traded' })
  if (totals && lamports(totals.paid) > 0n) facts.push({ id: 'paid', value: `${formatSolDisplay(lamports(totals.paid))} SOL`, label: 'paid to builders' })
  const bought = buybackSummary(receipts, null)
  if (bought) facts.push({ id: 'bought', value: `${bought.sol} SOL`, label: 'bought back', href: '/stats#repo-title' })
  return facts
}
