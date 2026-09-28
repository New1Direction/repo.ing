// Price and funding previews run independently. Both belong to the same input
// generation; an abandoned request must never update the next wallet or amount.
export async function loadTradePreview({ request, signal, onQuote, onQuoteError, onCosts, fetcher = fetch }) {
  async function read(action) {
    const response = await fetcher('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, action }), cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) })
    const result = await response.json()
    if (!response.ok) throw Error(result.error || 'Quote unavailable')
    return result
  }
  const costs = request.wallet ? (async () => {
    try {
      const result = await read('costs')
      if (!result.costs || !['networkFee','accountDeposits','refundableDeposit','total','required','shortfall'].every(key => /^\d+$/.test(result.costs[key]))) throw Error('Costs unavailable')
      if (!signal.aborted) onCosts({ costs: result.costs })
    } catch { if (!signal.aborted) onCosts({ unavailable: true }) }
  })() : Promise.resolve()
  const quote = (async () => {
    try {
      const result = await read('quote')
      if (!/^\d+$/.test(result.outputAmount) || !/^\d+$/.test(result.minimumAmountOut)) throw Error('Invalid quote')
      if (!signal.aborted) onQuote(result)
    } catch (error) { if (!signal.aborted) onQuoteError(error) }
  })()
  await Promise.all([quote, costs])
}
