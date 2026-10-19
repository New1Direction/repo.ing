// The Hook Lab canary coin's real mainnet history (two swaps, its launch and a fee claim), saved read-only in
// hooklab-canary-trades-mainnet.json and served to a real web3.js Connection through a fake fetch, so tests decode
// exactly what production reads. The canary is not listed on repo.ing; it is only a fixture here.
import { readFileSync } from 'node:fs'
import { Connection } from '@solana/web3.js'

export const canary = JSON.parse(readFileSync(new URL('./hooklab-canary-trades-mainnet.json', import.meta.url), 'utf8'))
export const CANARY_BUY = '5LPRXLDZgBoJAi5KHKo79sWkj4qNEmoVY4J3uXvkg881ULcTH5fBW7E94qqPwbL3pszCcGPUZ4k9XuVSyk4Dvki9'
export const CANARY_SELL = '3PBoq892dSnBTmKJvgqLCqoaXtgmhiZjkMq5ozTpA6cDpn5pw7naoFjEZroAtJ1Jtpe7qQC4kvAd1e5cdcxevJbx'
export const CANARY_LAUNCH = '21PRGF31LttC1Ky4TFXrUUKfqzYXo86rYrvq1rBRRsiHJ1NqVXnwKrG6rUS2jVv4PhP2k7tDtw3r2hefpHSimEMT'
export const CANARY_CLAIM = '3KLcHz1CynimtxositsdVMXmnK1bGx4LUfF8tarkKanZuSRjwiLtber7nBKZoRKub7EN1bpKdbtrWzfYcyGfdpLy'
export const clone = value => JSON.parse(JSON.stringify(value))

// getSignaturesForAddress honours before/until/limit as an RPC does (newest first, both bounds exclusive).
function signaturesPage(list, { before, until, limit = 1000 } = {}) {
  let start = 0, end = list.length
  if (before) start = list.findIndex(item => item.signature === before) + 1
  if (until) { const at = list.findIndex(item => item.signature === until); if (at >= 0) end = at }
  return list.slice(start, Math.max(start, end)).slice(0, limit)
}

// calls: every JSON-RPC request ({ method, params }) is appended here.
export function canaryConnection({ transactions = canary.transactions, signatures = canary.signatures, holdings = canary.holdings, calls = [] } = {}) {
  const answer = (method, params) => {
    if (method === 'getSignaturesForAddress') return params[0] === canary.pool ? signaturesPage(signatures, params[1]) : []
    if (method === 'getTransaction') return transactions[params[0]] ?? null
    if (method === 'getProgramAccounts') return params[1]?.withContext ? holdings : holdings.value
    throw Error(`unexpected RPC ${method}`)
  }
  return new Connection('https://fixture.invalid', { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ method: body.method, params: body.params })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer(body.method, body.params) }), { headers: { 'content-type': 'application/json' } })
  } })
}
