// The launch review's transaction on the page (app/components/launch-form.jsx): a legacy launch exactly as before, or an early
// access launch's v0 transaction (docs/EARLY_ACCESS.md). web3: the @solana/web3.js module the page loaded.
export function decodeLaunchTransaction(bytes, { Transaction, VersionedTransaction }) {
  let version = 'legacy'
  try { version = VersionedTransaction.deserialize(bytes).version } catch { /* read as legacy below, failing as before */ }
  return version === 0 ? VersionedTransaction.deserialize(bytes) : Transaction.from(bytes)
}
