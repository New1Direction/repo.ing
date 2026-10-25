// Trading on markets admitted by rule (src/new-market-admission.mjs) rather than the reviewed allowlist.
// The owner controls it from one trading_controls row (migration 0086): no row, a disabled row or an unreadable
// table all mean off. The switch stops buys and sells at once; the caps apply to buys only, so holders can always exit
// while it is on. The daily cap is a rolling 24 h sum of submitted new-market buys, checked at prepare and at submit.
const CONTROL = 'new_markets'
const OFF = Object.freeze({ enabled: false })

const solLabel = lamports => {
  const whole = lamports / 1_000_000_000n, fraction = (lamports % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''} SOL`
}

export async function newMarketControls(db) {
  try {
    const { rows: [row] } = await db.query('select enabled, max_buy_lamports, daily_buy_lamports from trading_controls where key = $1', [CONTROL])
    if (!row || row.enabled !== true) return OFF
    return { enabled: true, maxBuyLamports: BigInt(row.max_buy_lamports), dailyBuyLamports: BigInt(row.daily_buy_lamports) }
  } catch { return OFF }
}

export async function assertNewMarketTrade(db, { direction, amountLamports, reviewedRepoIds }) {
  let amount
  try { amount = BigInt(amountLamports) } catch { throw Error('Invalid trade amount') }
  if (!['buy', 'sell'].includes(direction) || amount <= 0n) throw Error('Invalid trade amount')
  const controls = await newMarketControls(db)
  if (!controls.enabled) throw Error('New-market trading is paused')
  if (direction === 'sell') return
  if (amount > controls.maxBuyLamports) throw Error(`New-market trading limit: a buy can be at most ${solLabel(controls.maxBuyLamports)}`)
  const { rows: [{ spent }] } = await db.query(`select coalesce(sum(amount_in), 0)::text as spent from trade_outcomes
    where outcome = 'submitted' and direction = 'buy' and created_at > now() - interval '24 hours'
      and github_repo_id is not null and github_repo_id <> all($1::bigint[])`, [reviewedRepoIds])
  if (BigInt(spent) + amount > controls.dailyBuyLamports) {
    throw Error("New-market trading limit: today's new-market buys are full; try again later")
  }
}
