import { database } from './server.mjs'
import { loadBuybackReceipts } from './buyback-receipts-db.mjs'
import { ttlMemo } from './ttl-memo.mjs'

// One in-process read shared by /stats and the homepage counter. Worker-detected receipts appear
// within a minute; loadBuybackReceipts never rejects and falls back to the verified list.
export const buybackReceipts = ttlMemo(() => loadBuybackReceipts(database()), 30_000)
