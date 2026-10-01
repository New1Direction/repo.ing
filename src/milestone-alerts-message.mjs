// Graduation-milestone alerts (see src/milestone-alerts.mjs), pure parts: which milestone a market's verified progress
// has reached, what one channel should do about it this run, and the post text.
import { publicGraduation } from './graduation-readiness.mjs'
import { cleanRepoName, cleanSymbol, escapeHtml, tokenUrl, X_MAX_WEIGHT, xWeight } from './launch-alerts-message.mjs'

export const MILESTONES = Object.freeze([25, 50, 75, 90])
export const GRADUATED_MILESTONE = 100

// Highest milestone reached: 0 below 25%, then 25/50/75/90 on an active curve (exact lamport ratio, never a rounded
// percent), 100 once graduation is durably proven. null when there is nothing to announce yet: stale or unverified
// progress (publicGraduation throws, the same gate as the public curve endpoint), or a curve that reached its target
// but has not migrated ('migrating'; its graduation is announced once the migration is proven).
export function milestoneOf(row, now = Date.now()) {
  let curve
  try { curve = publicGraduation(row, now) } catch { return null }
  if (curve.phase === 'GRADUATED') return { milestone: GRADUATED_MILESTONE, curve }
  if (curve.phase !== 'CURVE' || curve.status !== 'active') return null
  const reserve = BigInt(curve.reserveLamports), threshold = BigInt(curve.thresholdLamports)
  if (threshold <= 0n || reserve < 0n) return null
  const milestone = MILESTONES.reduce((reached, percent) => reserve * 100n >= threshold * BigInt(percent) ? percent : reached, 0)
  return { milestone, curve }
}

const time = value => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)

// One channel's decisions for this run. markets: [{ githubRepoId, milestone, ... }] with fresh progress only.
// marks: Map(repoId -> { milestone, markedAt }). alerts: Map(repoId -> [{ id, milestone, status, attempts, nextAttemptAt,
// updatedAt }]) on this channel.
// - No mark yet, or one taken before the cutoff: (re)take it at the current milestone, never lower. Nothing is posted,
//   so whatever a market had already reached when the job (or this channel) was turned on is never announced.
// - Otherwise the current milestone is posted when it is above the mark and above every milestone already claimed on
//   this channel: a jump from 20% to 80% posts 75% only, and dropping back and re-crossing never posts again.
// - A 'failed' claim is retried once its retry time has come, only while it is still the channel's highest claim for the
//   market and the market is still at that milestone (never a lower milestone after a higher one); 'unknown' never is.
// Posts are ordered graduations first, then by milestone, so a capped run sends the most significant ones.
export function planMilestones({ markets, marks, alerts, since, now, maxAttempts }) {
  const takeMarks = [], posts = []
  for (const market of markets) {
    const mark = marks.get(market.githubRepoId)
    if (!mark || time(mark.markedAt) < time(since)) {
      takeMarks.push({ githubRepoId: market.githubRepoId, milestone: Math.max(mark?.milestone ?? 0, market.milestone) })
      continue
    }
    if (market.milestone <= mark.milestone) continue
    const top = (alerts.get(market.githubRepoId) ?? []).reduce((best, row) => !best || row.milestone > best.milestone ? row : best, null)
    if (!top || market.milestone > top.milestone) { posts.push(market); continue }
    if (top.milestone === market.milestone && top.status === 'failed' && top.attempts < maxAttempts
      && time(top.nextAttemptAt ?? top.updatedAt) <= time(now)) posts.push({ ...market, alertId: top.id })
  }
  posts.sort((a, b) => b.milestone - a.milestone || String(a.githubRepoId).localeCompare(String(b.githubRepoId)))
  return { marks: takeMarks, posts }
}

// "42.5", "1,234.57", "<0.01": two decimals at most, and a nonzero amount never reads as 0.
export function solAmount(lamports) {
  const value = BigInt(lamports)
  if (value > 0n && value < 10_000_000n) return '<0.01'
  return (Number(value) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function headline({ milestone, ticker, remaining, target }) {
  if (milestone === GRADUATED_MILESTONE) return `🎓 ${ticker} graduated to Meteora after reaching its ${target} SOL target on repo.ing.`
  if (!MILESTONES.includes(milestone)) throw Error(`Unknown milestone ${milestone}`)
  return `📈 ${ticker} passed ${milestone}% of the way to graduating on repo.ing — ${remaining} SOL to go.`
}

// post: { fullName, tokenSymbol, mint, milestone, curve: { remainingLamports, thresholdLamports } }.
// channel: 'telegram' (HTML) or 'x' (plain, at most 280 weighted characters). Factual: no price talk.
export function buildMilestoneMessage(post, { channel, origin }) {
  const repo = cleanRepoName(post.fullName), symbol = cleanSymbol(post.tokenSymbol), url = tokenUrl(origin, post.mint)
  const ticker = symbol ? `$${symbol}` : repo
  const lines = [headline({ milestone: post.milestone, ticker, remaining: solAmount(post.curve.remainingLamports), target: solAmount(post.curve.thresholdLamports) }),
    ...(symbol ? [repo] : []), url]
  if (channel === 'telegram') return lines.map(escapeHtml).join('\n')
  if (channel !== 'x') throw Error(`Unknown milestone alert channel ${channel}`)
  const text = lines.join('\n')
  if (xWeight(text) > X_MAX_WEIGHT) throw Error('Milestone alert exceeds the X length limit')
  return text
}
