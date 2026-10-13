// The staged launch mechanism, described for one market (docs/LAUNCH_TRANSPARENCY.md#transparent-price-discovery). repo.ing does
// not run a hidden allocation: price discovery is one public bonding curve that every buyer trades at the same price for the same
// reserve, opened in a single atomic transaction, with a short decaying launch fee against first-block bots. Each stage below states
// what happened for this market, from its records; nothing here is a forecast.

const DAY = 86_400_000
const sol = lamports => `${(Number(BigInt(lamports ?? 0)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`
const pct = value => `${Number(value.toFixed(value >= 10 ? 1 : 2))}%`

// facts: { schedule: { scheduledAt, createdAt } | null, launch: { signature, launchedAt, initialBuyLamports, initialBuyPercent, groupLaunch,
//   groupRaiseLamports }, launchFee: { startPercent, endPercent, durationLabel } | null, earlyAccess: { end, rules } | null,
//   curve: { thresholdLamports, bondingPercent }, graduated: { signature } | null, now }
export function launchStages({ schedule = null, launch = {}, launchFee = null, earlyAccess = null, curve = {}, graduated = null, now = Date.now() } = {}) {
  const launchedAt = launch.launchedAt ? new Date(launch.launchedAt).getTime() : null
  const stages = []
  stages.push(schedule
    ? { id: 'announce', title: 'Public announcement', status: 'done', facts: [
      `Announced ${Math.round((new Date(schedule.scheduledAt) - new Date(schedule.createdAt)) / 3_600_000)} hours ahead on the public launch calendar, feeds and webhooks.`,
      'Until the announced time nobody could launch it; during the window only the announced wallet could, with at most the announced initial buy.'] }
    : { id: 'announce', title: 'Public announcement', status: 'skipped', facts: ['Not scheduled in advance: the market was launched when a wallet first asked.'] })
  const buyFacts = launch.groupLaunch
    ? [`A Group launch raise (all or nothing) paid ${launch.groupRaiseLamports ? sol(launch.groupRaiseLamports) : 'its pooled SOL'} into one swap in the launch transaction: every backer\'s SOL bought at the same price.`,
      `That buy took ${launch.initialBuyPercent === null || launch.initialBuyPercent === undefined ? 'an unrecorded share' : pct(launch.initialBuyPercent)} of supply into a program vault; backers hold fee shares, not tokens.`]
    : BigInt(launch.initialBuyLamports ?? 0) > 0n
      ? [`The launcher\'s initial buy: ${sol(launch.initialBuyLamports)} for ${pct(launch.initialBuyPercent ?? 0)} of supply, in the same transaction that created the pool.`,
        'It is the only purchase that transaction can make, capped at 3% of supply, and pays the regular fee. Nobody else can join that transaction.']
      : ['No initial buy: the first purchase was an ordinary trade on the public curve.']
  stages.push({ id: 'launch', title: 'Atomic launch transaction', status: launchedAt ? 'done' : 'upcoming', evidence: launch.signature ?? null, facts: buyFacts })
  const feeEnd = launchedAt && launchFee?.durationSeconds ? launchedAt + launchFee.durationSeconds * 1000 : null
  stages.push(launchFee
    ? { id: 'launch-fee', title: 'Launch fee window', status: feeEnd && now >= feeEnd ? 'done' : launchedAt ? 'active' : 'upcoming', facts: [
      `The trading fee started at ${launchFee.startPercent} and fell to ${launchFee.endPercent} over ${launchFee.durationLabel}, the same for every wallet.`,
      'It makes buying in the first seconds expensive for bots without reserving anything for anyone.'] }
    : { id: 'launch-fee', title: 'Launch fee window', status: 'skipped', facts: ['This market\'s config has a flat fee from the first block (launched before the launch fee existed).'] })
  if (earlyAccess) {
    const ended = new Date(earlyAccess.end).getTime() <= now
    stages.push({ id: 'early-access', title: 'Contributor early access', status: ended ? 'done' : 'active', facts: [
      `Until ${new Date(earlyAccess.end).toISOString()}, only wallets linked to the repository\'s GitHub contributors could buy; anyone could sell.`,
      ...(earlyAccess.fairRamp ? ['Per-wallet caps rose from 2% to 10% of supply with curve progress, enforced by the token\'s transfer hook.'] : [])] })
  }
  stages.push({ id: 'curve', title: 'Public bonding curve', status: graduated ? 'done' : launchedAt ? 'active' : 'upcoming', facts: [
    'One published price function: the price depends only on the SOL in the curve, so every buyer pays the same price at the same reserve.',
    `Graduates when the curve holds ${curve.thresholdLamports ? sol(curve.thresholdLamports) : 'its target'} of real SOL reserve${Number.isFinite(curve.bondingPercent) && !graduated ? ` (now ${Math.floor(curve.bondingPercent)}%)` : ''}. Sells move it back.`] })
  stages.push({ id: 'graduation', title: 'Graduation to a locked pool', status: graduated ? 'done' : 'upcoming', evidence: graduated?.signature ?? null, facts: [
    'The curve\'s SOL and reserved tokens migrate to a Meteora DAMM v2 pool whose migrated liquidity is permanently locked; anyone can add more liquidity there.'] })
  return { stages, sameTermsForEveryone: true, ageDays: launchedAt ? Math.floor((now - launchedAt) / DAY) : null }
}

// Follow-up phases that are deliberately not live (shown with the mechanism so nobody mistakes a plan for a feature).
export const NOT_LIVE = Object.freeze([
  { id: 'batch-auction', title: 'On-chain batch auction', text: 'A uniform-price opening auction needs a new audited Solana program; Meteora\'s curve cannot run one. Phase 3.' },
  { id: 'wallet-caps', title: 'Per-wallet caps for everyone', text: 'DBC pools cannot cap wallets. Contributor early access can (transfer hook) but is not enabled yet.' },
  { id: 'rewards', title: 'Rebates and builder rewards', text: 'Market-maker incentives, LP fee rebates and post-launch builder rewards are measured and published as previews; nothing is funded or paid.' },
])
