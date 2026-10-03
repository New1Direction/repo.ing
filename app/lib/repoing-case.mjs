import { formatSolDisplay } from './format.mjs'
import { buybackSummary, formatAgo } from './buyback-summary.mjs'

const LAMPORTS_PER_SOL = 1_000_000_000n
const AMOUNT = /^\d+(\.\d+)?$/
const PULSE_SHOWN = new Set(['shipping', 'active', 'quiet'])
const count = n => Number(n).toLocaleString('en-US')
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`

// Whole SOL, floored so a total never reads as more than it is: '6958730000000' lamports -> '6,958'.
export function formatWholeSol(lamports) {
  if (!AMOUNT.test(String(lamports))) return null
  return (BigInt(String(lamports).split('.')[0]) / LAMPORTS_PER_SOL).toLocaleString('en-US')
}

// The $REPOING page's "Why hold $REPOING" facts, each only while its figure is verified:
// - policy: the active policy's buyback share (buybackStatus().since, null while the revenue ledger is under review),
//   plus how far published buybacks run ahead of it;
// - buybacks: every published buyback from the receipts /stats lists (platform revenue and the team wallet);
// - volume: all-time trading and live markets from the /stats totals;
// - shipping: the repository's Dev Pulse (commits today, else this week, and pull requests merged this week).
// models: Hugging Face model markets are open. Returns [] when nothing is known.
export function repoingCase({ status = null, receipts = null, totals = null, pulse = null, models = false, now = Date.now() } = {}) {
  const facts = []
  if (status?.since?.basis === 'policy' && Number.isInteger(status.since.permille) && status.since.permille > 0) {
    const ahead = AMOUNT.test(String(status.standing?.aheadLamports)) ? BigInt(String(status.standing.aheadLamports).split('.')[0]) : 0n
    facts.push({ id: 'policy', label: 'To buybacks', value: `${status.since.permille / 10}%`,
      detail: "of every market's platform fees go to $REPOING buybacks",
      note: ahead > 0n ? `${formatSolDisplay(ahead)} SOL bought beyond that so far` : null })
  }
  const bought = buybackSummary(receipts, null)
  if (bought) {
    const latest = status?.latest ?? null
    const ago = latest ? formatAgo(latest.at, now) : null
    facts.push({ id: 'buybacks', label: 'Bought back', value: `${bought.sol} SOL`,
      detail: `${bought.tokens} $REPOING, every buy on-chain`, note: ago ? `Last one ${ago}` : null })
  }
  const volume = totals ? formatWholeSol(totals.volume) : null
  if (volume && volume !== '0' && Number.isInteger(totals.markets) && totals.markets > 0) {
    facts.push({ id: 'volume', label: 'Traded on repo.ing', value: `${volume} SOL`,
      detail: `across ${plural(totals.markets, 'market')}. More trading, more buybacks.`,
      note: models ? 'Now open to Hugging Face models' : null })
  }
  if (PULSE_SHOWN.has(pulse?.status) && (pulse.commits24h > 0 || pulse.commits7d > 0)) {
    const today = pulse.commits24h > 0
    const merged = pulse.merged7d > 0 ? `${count(pulse.merged7d)} PR${pulse.merged7d === 1 ? '' : 's'} merged this week` : null
    facts.push({ id: 'shipping', label: today ? 'Shipped today' : 'Shipped this week', value: plural(today ? pulse.commits24h : pulse.commits7d, 'commit'),
      detail: 'built in public on GitHub', note: merged })
  }
  return facts
}
