// The blockhash a review signs with, and the last block height it can land in, proven by two providers. The first names
// the latest finalized blockhash; the second must hold that same blockhash as its block at the same slot, and that
// block's height plus 150 (Agave's MAX_PROCESSING_AGE) must be the lastValidBlockHeight the first gave. One provider alone
// therefore cannot shorten a review's life (an executed trade that then never settles) or stretch it (expiry, which the
// signing lifecycle decides from this same height). Checked on a local validator (solana-core 4.0.1): for finalized and
// confirmed blockhashes, getBlock(context slot).blockHeight + 150 === lastValidBlockHeight, same blockhash, every sample.
export const BLOCKHASH_LIFETIME_BLOCKS = 150
const integer = value => Number.isSafeInteger(value) && value >= 0

export async function provenLatestBlockhash(connections, { minContextSlot }) {
  if (!Array.isArray(connections) || connections.length !== 2) throw Error('Two providers are required to prove a blockhash')
  const latest = await connections[0].connection.getLatestBlockhashAndContext({ commitment: 'finalized', minContextSlot })
  const slot = latest?.context?.slot
  const block = integer(slot) ? await connections[1].connection.getBlock(slot, { commitment: 'finalized', maxSupportedTransactionVersion: 0, transactionDetails: 'none', rewards: false }) : null
  if (!block || typeof latest.value?.blockhash !== 'string' || block.blockhash !== latest.value.blockhash || !integer(block.blockHeight)
    || block.blockHeight + BLOCKHASH_LIFETIME_BLOCKS !== latest.value.lastValidBlockHeight) throw Error('The blockhash lifetime is not proven by the second provider')
  return { context: { slot }, value: { blockhash: latest.value.blockhash, lastValidBlockHeight: latest.value.lastValidBlockHeight } }
}
// How far the finalized chain is proven on both providers: the slot the first names as its latest finalized and the height
// the second holds for that same block (provenLatestBlockhash). The signing lifecycle's expire() closes a never-sent
// operation only once this slot and height are past its own deadline and lastValidBlockHeight, so it can never land.
export async function provenFinalizedProgress(connections) {
  const proven = await provenLatestBlockhash(connections, { minContextSlot: 0 })
  return { slot: proven.context.slot, blockHeight: proven.value.lastValidBlockHeight - BLOCKHASH_LIFETIME_BLOCKS }
}
