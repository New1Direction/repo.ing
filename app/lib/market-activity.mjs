// A market's Activity tab, newest first: finalized curve and graduated-pool trades, creator fees, settled payouts and
// parts-fund entries. A trade carries its trader's X account (handle, name, avatar) only when that wallet linked X with a
// wallet signature; no wallet address is sent. handles: wallet → public link (xHandlesFor).
const iso = value => value instanceof Date ? value.toISOString() : value ?? null
const publicX = link => link?.username ? { username: link.username, name: link.name ?? null, image: link.image ?? null } : null

export function activityEvents({ trades = [], fees = [], claims = [], parts = [], handles = new Map(), limit = 40 }) {
  return [
    ...trades.map(row => {
      const x = publicX(row.trader ? handles.get(row.trader) : null)
      return { type: row.direction, signature: row.signature, eventIndex: row.eventIndex, occurredAt: iso(row.occurredAt),
        inputBaseUnits: row.inputBaseUnits, outputBaseUnits: row.outputBaseUnits, ...(x ? { x } : {}) }
    }),
    ...fees.map(row => ({ type: 'fee', signature: row.signature, eventIndex: row.eventIndex,
      occurredAt: iso(row.occurredAt), amountBaseUnits: row.amountBaseUnits })),
    ...claims.map(row => ({ type: 'claim', signature: row.signature, occurredAt: iso(row.occurredAt), amountBaseUnits: row.amountBaseUnits })),
    ...parts.map(row => ({ type: row.type, signature: row.signature, ref: row.ref, occurredAt: iso(row.occurredAt),
      ...(row.type === 'parts-pledge' ? { amountBaseUnits: row.amountBaseUnits, symbol: row.symbol, decimals: row.decimals, usdCents: row.usdCents } : { body: row.body }) })),
  ].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, limit)
}
