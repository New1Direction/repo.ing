// Candidate historical accounting. Archive author authentication is not chain-history acceptance.
import { createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import bs58 from 'bs58'
import { VersionedTransaction } from '@solana/web3.js'
import { decodePool, decodeHolding } from '@repo-ing/hooklab-production-candidate'
import { inspectCurveState, verifyCurvePlan, curveDigest } from './hooklab-curve.mjs'
import { reconcileHookLabReceipts, verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'

/** Candidate adapter for a pinned archive assertion, NOT proof of chain history correctness.
 * All pins and the fetcher are server-owned; no public request may choose any of them. There is
 * intentionally no configured provider/key or accepted archive schema. No private key is used.
 * Pinning/signature verification authenticates the archive author, not its replay/capture method.
 */
export function createCurveArchiveReader({ readArchive, publicKeyPem, archiveSha256, source }) {
  if (typeof readArchive !== 'function' || !/^[a-f0-9]{64}$/.test(archiveSha256 ?? '')
    || !/^[a-z][a-z0-9-]{0,63}$/.test(source ?? '')) throw new Error('Server-owned archive pins required')
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Archive requires Ed25519')
  const signerSha256 = curveDigest(key.export({ format: 'der', type: 'spki' }))
  return async context => {
    const { plan, receipt } = context
    verifyCurvePlan(plan)
    const envelope = await readArchive(context)
    const canonical = (value, max) => {
      if (typeof value !== 'string' || value.length > max) throw new Error('Archive size/encoding differs')
      const bytes = Buffer.from(value, 'base64')
      if (!bytes.length || bytes.toString('base64') !== value) throw new Error('Archive size/encoding differs')
      return bytes
    }
    const raw = canonical(envelope?.payloadBase64, 32768), signature = canonical(envelope?.signatureBase64, 88)
    if (curveDigest(raw) !== archiveSha256 || signature.length !== 64
      || !verify(null, Buffer.concat([Buffer.from('repo.ing curve archive assertion v1\n'), raw]), key, signature)) {
      throw new Error('Archive hash/signature differs')
    }
    const payload = JSON.parse(raw.toString('utf8'))
    if (!Buffer.from(JSON.stringify(payload)).equals(raw) || payload.schema !== 'repoing/curve-archive-assertion/1'
      || payload.source !== source || payload.genesisHash !== plan.review.genesisHash
      || payload.profileSha256 !== plan.review.profileSha256 || !isDeepStrictEqual(payload.receipt, receipt)
      || payload.history?.schema !== 'repoing/curve-history/1'
      || payload.history.signature !== receipt?.signature || payload.history.slot !== receipt?.slot
      || payload.history.messageSha256 !== plan.review.messageSha256) throw new Error('Archive transaction binding differs')
    return { schema: 'repoing/curve-history-archive-result/1', history: payload.history,
      archive: { source, signerSha256, archiveSha256, payloadBase64: envelope.payloadBase64,
        signerPublicKeyPem: key.export({ format: 'pem', type: 'spki' }),
        signatureBase64: envelope.signatureBase64, signatureVerified: true, chainVerified: false } }
  }
}

/** Standard RPC supplies transaction/fee evidence only, NEVER historical custom-token state.
 * readHistory is a separately reviewed replay/archive adapter. Omitting it must remain useful for
 * recovery but cannot settle the trade. Preserve the original provider response beside normalization.
 */
export async function readCurveReceipt(connection, provider, plan, signedBase64, readHistory) {
  verifyCurvePlan(plan)
  const retained = verifyHookLabSignedMessage(plan.review, signedBase64)
  const bounded = async work => {
    let timer
    try {
      return await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Read timeout')), 5000)
      })])
    } finally { clearTimeout(timer) }
  }
  if (await bounded(() => connection.getGenesisHash()) !== plan.review.genesisHash) throw new Error('Wrong recovery network')
  const tx = await bounded(() => connection.getTransaction(retained.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }))
  if (!tx) return { provider, receipt: null }
  const wire = new VersionedTransaction(tx.transaction.message)
  wire.signatures = tx.transaction.signatures.map(s => bs58.decode(s))
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
  const exact = value => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Unsafe RPC integer')
    return String(value)
  }
  const receipt = { genesisHash: plan.review.genesisHash, signature: tx.transaction.signatures[0],
    messageSha256: retained.messageSha256, signedTransactionBase64: Buffer.from(wire.serialize()).toString('base64'),
    slot: tx.slot, confirmationStatus: 'finalized', feeLamports: exact(tx.meta?.fee), error: tx.meta?.err,
    balances: Array.from({ length: keys.length }, (_, n) => ({ address: keys.get(n).toBase58(),
      before: exact(tx.meta?.preBalances[n]), after: exact(tx.meta?.postBalances[n]) })) }
  let history = null, historyArchive = null
  // An unavailable history service must not discard a known finalized transaction response.
  if (readHistory && tx.meta?.err === null) {
    try {
      const response = await bounded(() => readHistory({ provider, signature: retained.signature, slot: tx.slot, plan, receipt }))
      if (response?.schema === 'repoing/curve-history-archive-result/1') {
        history = response.history; historyArchive = response.archive
      } else history = response
    } catch { /* unresolved history; never discard the finalized RPC response */ }
  }
  return { provider, receipt, history, ...(historyArchive ? { historyArchive } : {}), transactionResponse: JSON.parse(JSON.stringify(tx)) }
}

/** Explicit internal worker integration; no scheduler registration and no broadcast path. */
export async function indexCurveReceipts(journal, adapters) {
  if (!Array.isArray(adapters) || adapters.length !== 2 || new Set(adapters.map(a => a.provider)).size !== 2) {
    throw new Error('Two independent read adapters required')
  }
  const outcomes = []
  for (const entry of await journal.pending(25)) {
    const row = await journal.get(entry.github_user_id, entry.id)
    const observations = await Promise.all(adapters.map(async a => {
      try {
        return await readCurveReceipt(a.connection, a.provider, row.plan, row.partial_transaction, a.readHistory)
      } catch { return { provider: a.provider, receipt: null } }
    }))
    const result = await journal.observe(entry.github_user_id, entry.id, observations)
    outcomes.push({ id: entry.id, status: result.status })
  }
  return outcomes
}

export function inspectCurveReceipt(plan, signedBase64, observations, providers) {
  verifyCurvePlan(plan)
  const result = reconcileHookLabReceipts(plan.review, signedBase64, observations, providers)
  const finish = (status, reason) => ({ ...result, status, reason, chainVerified: false,
    historyProvenanceVerified: false, canRetry: false, canSubmit: false })
  if (!['finalized-transaction-only', 'finalized-failure'].includes(result.status)) return finish(result.status, result.reason)
  // Retain a finalized failure, but it is never permission to rebuild/retry this intent.
  if (result.status === 'finalized-failure') return finish(result.status, 'Finalized transaction failure; retain fee and raw evidence')
  const [left, right] = observations
  const h = left.history, r = left.receipt
  if (!h || !isDeepStrictEqual(h, right.history) || h.schema !== 'repoing/curve-history/1'
    || h.kind !== 'transaction-replay' || h.signature !== result.signature || h.slot !== r.slot
    || h.messageSha256 !== plan.review.messageSha256 || !Number.isSafeInteger(h.transactionIndex) || h.transactionIndex < 0
    || !/^[a-f0-9]{64}$/.test(h.evidenceSha256 ?? '')) {
    return finish('review-required', 'Missing agreeing transaction-bound history; later account snapshots cannot prove historical deltas')
  }
  try {
    const check = (ok, message) => { if (!ok) throw new Error(message) }
    check(isDeepStrictEqual(h.before, plan.observed.accounts), 'Historical prestate differs from reviewed state')
    const checked = inspectCurveState(plan.intent, { ...plan.observed, accounts: h.before })
    const { after, pool, launch, holdings } = checked
    const roles = Object.keys(h.before).sort()
    check(isDeepStrictEqual(Object.keys(h.after).sort(), roles), 'Historical account inventory differs')
    const decode = (role, fn, size) => {
      const a = h.after[role], b = h.before[role], raw = Buffer.from(a.dataBase64, 'base64')
      check(a.address === b.address && a.owner === b.owner && a.executable === false && raw.length === size
        && raw[8] === 1 && raw.toString('base64') === a.dataBase64, 'Historical account identity/layout differs')
      // Frozen v1 Borsh offsets, with pool hook Some(launch), and no holding delegate.
      // Semantic decoders omit reserved bytes; they must not hide unrelated raw state changes.
      const expected = Buffer.from(b.dataBase64, 'base64')
      const ranges = role === 'pool' ? [[210, 226], [299, 347]] : [[74, 82]]
      for (const [start, end] of ranges) raw.copy(expected, start, start, end)
      check(expected.equals(raw), 'Unexpected raw account change')
      return fn(raw)
    }
    const buy = plan.intent.side === 'buy', amount = BigInt(plan.intent.amountIn), output = checked.output
    const postPool = decode('pool', decodePool, 411)
    check(Number.isSafeInteger(h.blockTime) && h.blockTime >= pool.lastSwapAt
      && h.blockTime >= launch.createdAt, 'Invalid historical block time')
    check(isDeepStrictEqual(postPool, { ...pool, baseReserve: after.baseReserve, quoteReserve: after.quoteReserve,
      swapCount: after.swapCount, lastSwapAt: h.blockTime, baseVolume: pool.baseVolume + (buy ? output : amount),
      quoteVolume: pool.quoteVolume + (buy ? amount : output) }), 'Pool reserve/fee/volume/counter deltas differ')
    for (const [role, expected] of [['traderBase', after.traderBase], ['traderQuote', after.traderQuote],
      ['baseVault', after.baseReserve], ['quoteVault', after.quoteReserve + pool.protocolFeesQuote]]) {
      const before = decodeHolding(Buffer.from(h.before[role].dataBase64, 'base64'))
      check(isDeepStrictEqual(decode(role, decodeHolding, 204), { ...before, amount: expected }), 'Holding deltas differ')
    }
    // Zero sniper window means the first-buy exemption cannot change creatorBought.
    for (const role of roles.filter(r => !['pool', 'traderBase', 'traderQuote', 'baseVault', 'quoteVault'].includes(r))) {
      check(isDeepStrictEqual(h.before[role], h.after[role]), 'Unexpected account change')
    }
    const keys = plan.review.accounts.map(a => a.address)
    check(Array.isArray(r.balances) && isDeepStrictEqual(r.balances.map(b => b.address), keys), 'Native balance inventory differs')
    for (const b of r.balances) {
      check(typeof b.before === 'string' && typeof b.after === 'string'
        && /^(0|[1-9]\d{0,19})$/.test(b.before) && /^(0|[1-9]\d{0,19})$/.test(b.after)
        && BigInt(b.before) <= 0xffffffffffffffffn && BigInt(b.after) <= 0xffffffffffffffffn, 'Unsafe native balance encoding')
      const expected = b.address === plan.intent.feePayer ? -BigInt(r.feeLamports) : 0n
      check(BigInt(b.after) - BigInt(b.before) === expected, 'Unexpected native fee/rent/debit')
    }
    check(holdings.launchQuote === decodeHolding(Buffer.from(h.after.launchQuote.dataBase64, 'base64')).amount, 'Launch quote changed')
    return finish('candidate-deltas-matched', 'Supplied transaction history matches; trusted history provenance and production acceptance remain required')
  } catch {
    return finish('review-required', 'Historical account/economic postconditions differ')
  }
}
