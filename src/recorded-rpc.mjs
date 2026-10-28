// A real web3.js Connection answered from recorded read-only RPC responses (tests/fixtures/hooklab-revenue-mainnet.json),
// so a replay decodes exactly what a live read would, with no network. Any other method, or a request the recording does not
// cover, throws.
import { Connection } from '@solana/web3.js'

function signaturesPage(list, { before, limit = 1000 } = {}) {
  const start = before ? list.findIndex(item => item.signature === before) + 1 : 0
  return list.slice(start, start + limit)
}

export function recordedConnection(recording, { calls = [] } = {}) {
  const launchAccounts = new Map(Object.values(recording.launches).map(l => [l.launch, l.account]))
  const answer = (method, params) => {
    if (method === 'getProgramAccounts' && params[0] === recording.programs.swap) return recording.pools
    if (method === 'getAccountInfo' && launchAccounts.has(params[0])) return launchAccounts.get(params[0])
    if (method === 'getMinimumBalanceForRentExemption' && recording.rentExempt?.[params[0]] !== undefined) return recording.rentExempt[params[0]]
    if (method === 'getSignaturesForAddress' && recording.signatures[params[0]]) return signaturesPage(recording.signatures[params[0]], params[1])
    if (method === 'getTransaction' && recording.transactions[params[0]]) return recording.transactions[params[0]]
    throw Error(`RECORDING_MISSING ${method}`)
  }
  return new Connection('https://recording.invalid', { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ method: body.method, params: body.params })
    let result, error
    try { result = answer(body.method, body.params) } catch (e) { error = { code: -32000, message: e.message } }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(error ? { error } : { result }) }), { headers: { 'content-type': 'application/json' } })
  } })
}
