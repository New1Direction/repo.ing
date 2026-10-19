// What a value looks like after a Postgres jsonb column: object keys come back shortest first, then bytewise; arrays keep
// their order. Settlement contexts and reviews are stored this way, so replay tests must read them back the same way.
const jsonbKeyOrder = ([a], [b]) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b))
export const jsonbRoundTrip = value => JSON.parse(JSON.stringify(value),
  (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(jsonbKeyOrder)) : v)
