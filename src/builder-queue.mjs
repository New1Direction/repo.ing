// Bounded concurrency keeps large repository accounts from flooding GitHub or Solana.
export async function mapLimited(items, concurrency, work) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i], i) }
  }))
  return results
}

export async function claimBuilderQueue(items, submit, onResult) {
  const unique = [...new Map(items.map(item => [item.repoId, item])).values()]
  return mapLimited(unique, 2, async item => {
    onResult(item.repoId, { status: 'pending' })
    let result
    try { result = await submit(item) }
    catch { result = { status: 'unknown', error: 'Confirmation interrupted. Refresh to check this payout before retrying.' } }
    onResult(item.repoId, result)
    return result
  })
}
