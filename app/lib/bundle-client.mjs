// The raise flow from the browser (app/lib/bundle-api.mjs): read a bundle, open one, and deposit, refund or claim. Every
// transaction is built by the site and signed by the connected wallet; the site checks the signed bytes before it co-signs or
// relays them. No Node imports: web3.js is loaded only when a transaction is signed.

const toBase64 = bytes => btoa(String.fromCharCode(...bytes))
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0))

export async function bundleRequest(path, body = null) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(result.error || 'Group launch request failed'), { status: response.status, code: result.code ?? null })
  return Object.assign(result, { pending: response.status === 202 || result.pending === true })
}

export const readBundle = (id, wallet = null) => bundleRequest(`/api/bundles/${id}${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ''}`)

async function signPrepared(prepared, provider) {
  const { Transaction } = await import('@solana/web3.js')
  const signed = await provider().signTransaction(Transaction.from(fromBase64(prepared.transaction)))
  return toBase64(signed.serialize({ requireAllSignatures: false, verifySignatures: true }))
}

// Open a raise: prepare (the site checks the repository and builds the transaction), sign, submit. onStage: progress text.
export async function openBundle(details, { provider, onStage = () => {} }) {
  onStage('Checking the repository')
  const prepared = await bundleRequest('/api/bundles', { action: 'prepare', ...details })
  onStage('Waiting for wallet')
  const transaction = await signPrepared(prepared, provider)
  onStage('Opening the group launch')
  return bundleRequest('/api/bundles', { action: 'submit', bundleId: prepared.bundleId, review: prepared.review, transaction })
}

// deposit (lamports as digits), refund or claim for the connected wallet: prepare, sign, send. Resolves { signature, confirmed }.
export async function bundleAction(id, action, { wallet, provider, lamports = null, onStage = () => {} }) {
  onStage('Preparing')
  const prepared = await bundleRequest(`/api/bundles/${id}`, { action, wallet, ...lamports ? { lamports } : {} })
  onStage('Waiting for wallet')
  const transaction = await signPrepared(prepared, provider)
  onStage('Sending')
  return bundleRequest(`/api/bundles/${id}`, { action: 'send', wallet, transaction, lastValidBlockHeight: prepared.lastValidBlockHeight })
}
