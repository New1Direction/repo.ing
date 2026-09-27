import { formatUnits } from './format.mjs'

export function sumTokenAccountBalances(accounts) {
  let total = 0n
  for (const { account } of accounts) {
    if (!Buffer.isBuffer(account.data) || account.data.length !== 8) throw new Error('Unexpected token account balance data')
    total += account.data.readBigUInt64LE(0)
  }
  return total.toString()
}

export function sellAmountForPercent(balanceBaseUnits, percent, decimals = 6) {
  if (![25, 50, 100].includes(percent)) throw new Error('Unsupported sell percentage')
  const amount = BigInt(balanceBaseUnits) * BigInt(percent) / 100n
  if (amount <= 0n) return ''
  const base = 10n ** BigInt(decimals)
  const whole = amount / base
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}`
}

export function tokenBalanceLabel(balanceBaseUnits, decimals = 6) {
  if (balanceBaseUnits === null || balanceBaseUnits === undefined) return '—'
  if (BigInt(balanceBaseUnits) > 0n && BigInt(balanceBaseUnits) < 10n ** BigInt(decimals - 2)) return '<0.01'
  return formatUnits(balanceBaseUnits, decimals, 2)
}
