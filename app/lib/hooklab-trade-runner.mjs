// Drives one wallet-signed Hook Lab operation (buy, sell, add SOL, withdraw SOL) through the server lifecycle:
// exact review -> the wallet signs exactly the reviewed bytes -> sent once -> finalized receipt. Browser-side checks
// mirror the server's: the same message, this wallet as the only signer, and nothing else signed or changed.
const FINAL = new Set(['finalized-success', 'finalized-failure', 'review-required', 'expired'])
const encode = bytes => btoa(String.fromCharCode(...bytes))
const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
export const isFinal = status => FINAL.has(status)

export async function callTrade(body) {
  const response = await fetch('/api/hook-lab/inclusive-trade', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => { throw Error('The connection dropped. Your transaction is saved; check its status before trying again.') })
  if (value.status === 'blocked') throw Object.assign(Error(value.blockers?.[0]?.message || 'Trading is unavailable right now.'), { code: value.blockers?.[0]?.code })
  if (response.status === 401) throw Object.assign(Error('Sign in with your wallet again.'), { code: 'SIGNED_OUT' })
  if (!response.ok || value.status !== 'available') throw Error(value.error || 'Trading is unavailable right now. Your transaction is saved; check its status before trying again.')
  return value
}

// The server's operation must be this signing ID, this wallet's, on this network, with this wallet as the only signer.
export function expectOperation(value, { signingId, wallet, genesisHash }) {
  const op = value?.operation
  if (!op || op.id !== signingId || op.custodyOperationId !== signingId || op.review?.genesisHash !== genesisHash || op.review.wallet !== wallet
    || op.review.payer !== wallet || op.review.requiredSigners?.length !== 1 || op.review.requiredSigners[0] !== wallet)
    throw Error('The transaction or wallet changed. Nothing more was signed.')
  return op
}

// Never sent and past its review deadline: the server can close it as expired once both providers prove its blockhash
// can no longer land (until then the expire call is refused and the panel tries again later).
const UNSENT = new Set(['reviewed', 'partial', 'signed', 'signing-claimed', 'signing-unknown'])
export const expiredUnsent = (op, now = Date.now()) => UNSENT.has(op.status) && !op.signature && now >= op.review.reviewExpiresAtMs
export async function closeExpired({ call = callTrade, op, signingId, wallet, genesisHash, now = Date.now() }) {
  if (!expiredUnsent(op, now)) return op
  return expectOperation(await call({ action: 'expire', signingId }), { signingId, wallet, genesisHash })
}

// create: the body that starts it ({ action: 'quote' | 'fund' | 'withdraw', request }). onStatus('review'|'sign'|'send'|'confirm').
export async function runOperation({ call = callTrade, create, signingId, wallet, genesisHash, signTransaction, onStatus = () => {}, onOperation = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = 4000, maxPolls = 45, loadTransaction }) {
  const ids = { signingId, wallet, genesisHash }
  onStatus('review')
  let op = expectOperation(await call({ ...create, signingId }), ids); onOperation(op)
  if (op.status === 'reviewed') {
    onStatus('sign')
    const issued = await call({ action: 'wallet-request', signingId })
    if (issued.review?.wallet !== wallet || issued.review.genesisHash !== genesisHash || issued.review.messageSha256 !== op.review.messageSha256)
      throw Error('The transaction changed after review. Nothing was signed.')
    const VersionedTransaction = loadTransaction ? await loadTransaction() : (await import('@solana/web3.js')).VersionedTransaction
    const tx = VersionedTransaction.deserialize(decode(issued.partialTransactionBase64)), message = Uint8Array.from(tx.message.serialize())
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', message))].map(v => v.toString(16).padStart(2, '0')).join('')
    if (encode(message) !== issued.review.messageBase64 || digest !== op.review.messageSha256 || Date.now() >= op.review.reviewExpiresAtMs)
      throw Error('The transaction expired or changed. Nothing was signed.')
    const signed = await signTransaction(tx)
    if (!equal(Uint8Array.from(signed.message.serialize()), message) || signed.signatures.length !== 1 || !signed.signatures[0].some(v => v !== 0))
      throw Error('Your wallet changed the transaction. Nothing was sent.')
    op = expectOperation(await call({ action: 'retain-wallet', signingId, signedTransactionBase64: encode(signed.serialize()) }), ids); onOperation(op)
  }
  if (op.status === 'signed') {
    onStatus('send')
    op = expectOperation(await call({ action: 'submit', signingId }), ids); onOperation(op)
  }
  onStatus('confirm')
  for (let i = 0; i < maxPolls && !isFinal(op.status); i++) {
    await sleep(pollMs)
    op = expectOperation(await call({ action: 'reconcile', signingId }), ids); onOperation(op)
  }
  return op
}

// Unfinished operations survive reloads, so the panel can finish confirming them instead of starting over.
const KEY = 'repo.ing.hooks.trade.pending.v1'
export function pendingOperations(storage, wallet) {
  try { return (JSON.parse(storage.getItem(KEY)) ?? []).filter(x => x.wallet === wallet) } catch { return [] }
}
export function rememberOperation(storage, entry) {
  try { const list = (JSON.parse(storage.getItem(KEY)) ?? []).filter(x => x.signingId !== entry.signingId); storage.setItem(KEY, JSON.stringify([...list, entry].slice(-10))) } catch {}
}
export function forgetOperation(storage, signingId) {
  try { storage.setItem(KEY, JSON.stringify((JSON.parse(storage.getItem(KEY)) ?? []).filter(x => x.signingId !== signingId))) } catch {}
}
