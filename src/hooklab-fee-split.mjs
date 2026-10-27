// One total fee, split between the fee hooks (owner design, 2026-10-27): the creator picks the total (a whole number of
// basis points, 0 to 10%) and each hook's share of it (shares add up to 100%). The hooks' parts round down and the
// creator takes the remainder, so the parts always add up to the total. The 75/25 platform share applies inside the
// creator's part only. The max wallet cap is not a fee. Holders Earn is not live yet: its share must be 0.
// Pure: the launch form, the launch-requests API and the compilers check the same split.
export const FEE_SHARE_TOTAL = 10000
export const MAX_TOTAL_FEE_BPS = 1000
const fail = message => { throw Error(message) }
const isBps = (value, max) => Number.isInteger(value) && value >= 0 && value <= max
const percent = bps => `${bps / 100}%`

// { totalBps, shares: { creator, burn, holders? } } (shares in basis points of 100%) -> each part in basis points.
export function splitFee({ totalBps, shares }) {
  if (!isBps(totalBps, MAX_TOTAL_FEE_BPS)) fail('The total fee must be a whole number of basis points from 0 to 10%.')
  const { creator, burn = 0, holders = 0 } = shares ?? {}
  if (![creator, burn, holders].every(share => isBps(share, FEE_SHARE_TOTAL)) || creator + burn + holders !== FEE_SHARE_TOTAL)
    fail('The fee shares must be whole basis points that add up to 100%.')
  const burnBps = Math.floor(totalBps * burn / FEE_SHARE_TOTAL), holderFeeBps = Math.floor(totalBps * holders / FEE_SHARE_TOTAL)
  return { totalBps, creatorFeeBps: totalBps - burnBps - holderFeeBps, burnBps, holderFeeBps }
}

// Why the chain would refuse this split under the launch Config's bounds, or ''. The creator's ceiling is the lower of
// max_creator_fee_bps and max_rules_fee_bps, as the open route checks it (hook-lab independent.rs fee_ceiling).
export function checkFeeSplit(split, { maxCreatorFeeBps, maxRulesFeeBps, maxBurnBps, maxHolderFeeBps }) {
  const { creatorFeeBps, burnBps, holderFeeBps } = split, creatorCeiling = Math.min(maxCreatorFeeBps, maxRulesFeeBps)
  if (holderFeeBps !== 0) return 'Holders Earn is not live yet.'
  if (creatorFeeBps > creatorCeiling) return `The creator fee can be at most ${percent(creatorCeiling)}.`
  if (burnBps > maxBurnBps) return `The burn can be at most ${percent(maxBurnBps)} of each trade.`
  if (holderFeeBps > maxHolderFeeBps) return `Holders Earn can be at most ${percent(maxHolderFeeBps)} of each trade.`
  if (creatorFeeBps + burnBps + holderFeeBps > maxRulesFeeBps) return `The total fee can be at most ${percent(maxRulesFeeBps)}.`
  return ''
}

// The launch's LaunchRules (hook-lab state.rs): the burn on both sides; holder fees 0 until Holders Earn is live.
export const launchRulesOf = ({ burnBps, holderFeeBps }) => ({ holder_fee_buy_bps: holderFeeBps, holder_fee_sell_bps: holderFeeBps,
  burn_buy_bps: burnBps, burn_sell_bps: burnBps, max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 })

// What the buyer reads before signing: one total, then each hook in plain words. A burn destroys the coin's own tokens.
export function describeFeeSplit({ totalBps, creatorFeeBps, burnBps }) {
  return { total: `Every buy and sell pays ${percent(totalBps)} in total.`,
    creator: `${percent(creatorFeeBps)} goes to the creator (repo.ing keeps a quarter of it).`,
    burn: burnBps ? `${percent(burnBps)} of each trade’s coins is burned (destroyed), shrinking the supply.` : '' }
}
