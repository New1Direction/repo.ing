import { parseUnits } from './format.mjs'
export const BUY_PRESETS_KEY = 'repoing:buy-presets:v1'
export const DEFAULT_BUY_PRESETS = ['0.1', '0.5', '1']
export function validateBuyPresets(values) {
  if (!Array.isArray(values) || values.length !== 3) throw Error('Set three SOL amounts.')
  const result = values.map(value => {
    if (typeof value !== 'string' || value.length > 22) throw Error('Enter a valid SOL amount.')
    const units = BigInt(parseUnits(value.trim(), 9))
    if (units > 18446744073709551615n) throw Error('That amount is too large.')
    return `${units / 1000000000n}${units % 1000000000n ? `.${String(units % 1000000000n).padStart(9, '0').replace(/0+$/, '')}` : ''}`
  })
  if (new Set(result).size !== 3) throw Error('Choose three different amounts.')
  return result
}
