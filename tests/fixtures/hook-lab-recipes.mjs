// Raw intent examples from the six prepared templates, deliberately asymmetric.
const creator = { type: 'creator_fee', fee_bps: 125 }
const holder = { type: 'holder_rewards', buy_bps: 25, sell_bps: 75 }
const burn = { type: 'burn', buy_bps: 0, sell_bps: 30 }
const wallet = { type: 'max_wallet', pct_bps: 150 }
const lock = { type: 'creator_lock', days_secs: 172800 }
const early = { type: 'early_lock', window_secs: 60, lock_secs: 3600 }
export const recipeCases = Object.entries({
  plain: [creator, { type: 'burn', buy_bps: 35, sell_bps: 80 }],
  'creator-rewards': [creator, holder, burn, wallet, lock, early],
  burns: [{ type: 'burn', buy_bps: 35, sell_bps: 80 }, creator],
  locks: [{ type: 'creator_lock', days_secs: 86400 }, { type: 'early_lock', window_secs: 45, lock_secs: 7200 }, creator, holder, burn, wallet],
  'max-wallet': [{ type: 'max_wallet', pct_bps: 175 }, creator, holder, burn, lock, early],
  'half-life': [{ type: 'exit_halflife', start_bps: 2000, half_secs: 21600, zero_secs: 172800 },
    { type: 'creator_fee', fee_bps: 50 }, { type: 'burn', buy_bps: 10, sell_bps: 20 }],
}).map(([template, blocks]) => [template, { format: 'hook-lab/1', coin: { name: 'Example', ticker: 'EX' }, blocks }])

export function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, text) => values.set(key, text) }
}
