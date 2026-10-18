// Two-provider finalized reads. Mainnet use is read-only except the explicit one-send path in
// execute.mjs. Reads must agree, be <=5 slots apart and complete within 5 seconds.
import { isDeepStrictEqual } from 'node:util'
import { Connection } from '@solana/web3.js'
import { MAINNET_GENESIS, pk } from './pins.mjs'

// solana.publicnode.com rejects getMultipleAccounts above 10 keys (HTTP 403); chunks stay within
// the five-slot spread check below.
export const MAX_SLOT_SPREAD = 5, MAX_READ_MS = 5000, CHUNK = 10
export const DEFAULT_MAINNET_RPC = ['https://api.mainnet-beta.solana.com', 'https://solana.publicnode.com']
const check = (ok, message) => { if (!ok) throw Error(message) }
const loopback = url => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)

// Display form never includes query strings (providers often carry API keys there).
export const redact = url => { const u = new URL(url); return `${u.origin}${u.pathname === '/' ? '' : u.pathname}${u.search ? '?<redacted>' : ''}` }
export function makeReaders({ rpc, rpc2, localTest }) {
  const urls = [rpc ?? (localTest ? null : DEFAULT_MAINNET_RPC[0]), rpc2 ?? (localTest ? null : DEFAULT_MAINNET_RPC[1])]
  check(urls.every(Boolean), 'Two RPC URLs are required (--rpc and --rpc2)')
  const parsed = urls.map(u => new URL(u))
  check(parsed.every(u => !u.username && !u.password && !u.hash), 'RPC URLs may not embed credentials or fragments')
  check(parsed[0].origin !== parsed[1].origin, 'The two RPC providers must have distinct origins')
  if (localTest) check(parsed.every(loopback), '--local-test accepts loopback RPC endpoints only')
  else check(parsed.every(u => u.protocol === 'https:' && !loopback(u)), 'Mainnet mode requires two remote HTTPS RPC providers')
  return urls.map((url, i) => ({ provider: i === 0 ? 'primary' : 'secondary', url: redact(url), connection: new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true }) }))
}
/** Verifies genesis on both providers. Mainnet mode requires the mainnet genesis; --local-test forbids it. */
export async function verifyGenesis(readers, { localTest, expectedLocalGenesis }) {
  const hashes = await Promise.all(readers.map(r => r.connection.getGenesisHash()))
  check(hashes[0] === hashes[1], 'RPC providers report different genesis hashes')
  if (localTest) {
    check(hashes[0] !== MAINNET_GENESIS, '--local-test refuses the mainnet genesis')
    if (expectedLocalGenesis) check(hashes[0] === expectedLocalGenesis, 'Local genesis differs from the expected local validator')
  } else check(hashes[0] === MAINNET_GENESIS, `Genesis ${hashes[0]} is not mainnet-beta; refusing (use --local-test only for a local validator)`)
  return hashes[0]
}
const toRow = (address, a) => a === null ? { address, account: null }
  : { address, account: { address, owner: a.owner.toBase58(), executable: a.executable, lamports: String(a.lamports), dataBase64: Buffer.from(a.data).toString('base64') } }
async function readOnce(reader, keys) {
  const rows = [], slots = []
  const chunks = []
  for (let i = 0; i < keys.length; i += CHUNK) chunks.push(keys.slice(i, i + CHUNK))
  const results = await Promise.all(chunks.map(chunk => reader.connection.getMultipleAccountsInfoAndContext(chunk.map(pk), { commitment: 'finalized' })))
  results.forEach((result, c) => {
    check(result.value.length === chunks[c].length, 'Provider returned a short account list')
    slots.push(result.context.slot); chunks[c].forEach((address, j) => rows.push(toRow(address, result.value[j])))
  })
  return { rows, slot: Math.min(...slots), maxSlot: Math.max(...slots) }
}
/** Finalized snapshot of `addresses` from both providers; retries a disagreeing pair up to 3 times. */
export async function readAccounts(readers, genesisHash, addresses, { attempts = 3 } = {}) {
  const keys = [...addresses]
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    const started = Date.now()
    try {
      const results = await Promise.all(readers.map(r => readOnce(r, keys)))
      const elapsed = Date.now() - started, slots = results.flatMap(r => [r.slot, r.maxSlot])
      check(elapsed <= MAX_READ_MS, `Two-provider read took ${elapsed} ms (> ${MAX_READ_MS})`)
      check(Math.max(...slots) - Math.min(...slots) <= MAX_SLOT_SPREAD, 'Providers are more than five slots apart')
      check(isDeepStrictEqual(results[0].rows, results[1].rows), 'Providers disagree on finalized account state')
      const observations = readers.map((r, i) => ({ provider: r.provider, genesisHash, commitment: 'finalized', slot: results[i].maxSlot, observedAtMs: started,
        accounts: results[i].rows.map(row => structuredClone(row)) }))
      return { slot: Math.max(...slots), observedAtMs: started, observations, accounts: new Map(results[0].rows.map(row => [row.address, row.account])) }
    } catch (error) { lastError = error; if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 800)) }
  }
  throw lastError
}
/** A finalized blockhash confirmed valid by both providers, with block heights. */
export async function readBlockhash(readers, minSlot = 0) {
  let latest
  // The primary may trail the secondary by a slot or two; wait briefly for it to reach minSlot.
  for (let attempt = 0; ; attempt++) {
    try { latest = await readers[0].connection.getLatestBlockhashAndContext({ commitment: 'finalized', minContextSlot: minSlot }); break }
    catch (error) { if (attempt >= 10 || !/Minimum context slot/i.test(error.message ?? '')) throw error; await new Promise(resolve => setTimeout(resolve, 500)) }
  }
  const confirmations = await Promise.all(readers.map(async r => {
    const valid = await r.connection.isBlockhashValid(latest.value.blockhash, { commitment: 'finalized' })
    check(valid.value === true, 'Blockhash not yet valid on both providers')
    return { slot: valid.context.slot, height: await r.connection.getBlockHeight({ commitment: 'finalized' }) }
  }))
  return { blockhash: latest.value.blockhash, lastValidBlockHeight: latest.value.lastValidBlockHeight, contextSlot: latest.context.slot,
    currentBlockHeight: Math.max(...confirmations.map(c => c.height)), observedSlot: Math.max(...confirmations.map(c => c.slot)) }
}
export async function blockhashStillValid(readers, blockhash) {
  const results = await Promise.all(readers.map(r => r.connection.isBlockhashValid(blockhash, { commitment: 'finalized' }).then(x => x.value).catch(() => false)))
  return results.every(Boolean)
}
export async function rentExemption(readers, sizes) {
  const rows = await Promise.all(readers.map(r => Promise.all(sizes.map(n => r.connection.getMinimumBalanceForRentExemption(n, 'finalized')))))
  check(isDeepStrictEqual(rows[0], rows[1]), 'Providers disagree on rent exemption')
  return Object.fromEntries(sizes.map((n, i) => [n, rows[0][i]]))
}
/** Read-only simulation (sigVerify:false). Never sends. */
export async function simulate(reader, transaction) {
  try {
    const result = await reader.connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: false, commitment: 'finalized' })
    return { err: result.value.err, unitsConsumed: result.value.unitsConsumed ?? null, logs: (result.value.logs ?? []).slice(-12) }
  } catch (error) { return { err: `simulation unavailable: ${error.message}`, unitsConsumed: null, logs: [] } }
}
