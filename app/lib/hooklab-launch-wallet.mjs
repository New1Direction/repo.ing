// Wallet signing for a reviewed launch transaction (preparation or launch), shared by the guided launchers. The server's
// wallet request must carry exactly the reviewed message for this wallet and network; the wallet may add only its own
// signature. Returns the signed transaction (base64) for the server to retain. Browser only (crypto.subtle, atob).
const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const encode = bytes => btoa(String.fromCharCode(...bytes))
const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])

// walletRequest: the server's wallet-request response; reviewed: the operation's review the creator saw; address: the
// signed-in wallet; currentWallet(): the wallet connected right now; adapter: the wallet adapter.
export async function signReviewedLaunch({ walletRequest, reviewed, address, genesisHash, currentWallet, adapter }) {
  if (walletRequest.review.messageSha256 !== reviewed.messageSha256 || walletRequest.review.wallet !== address || walletRequest.review.genesisHash !== genesisHash)
    throw Error('The transaction changed after review. Signing was stopped.')
  const { VersionedTransaction } = await import('@solana/web3.js')
  const tx = VersionedTransaction.deserialize(decode(walletRequest.partialTransactionBase64))
  const message = tx.message.serialize()
  if (encode(message) !== walletRequest.review.messageBase64) throw Error('Transaction bytes differ from the reviewed message.')
  const digest = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', message)))
  const expectedDigest = encode(Uint8Array.from(reviewed.messageSha256.match(/../g), value => parseInt(value, 16)))
  if (digest !== expectedDigest || currentWallet() !== address) throw Error('Transaction identity or connected wallet changed.')
  const previousSignatures = tx.signatures.map(signature => Uint8Array.from(signature))
  if (typeof adapter?.signTransaction !== 'function') throw Error('Connect a wallet that supports transaction signing.')
  if (Date.now() >= reviewed.reviewExpiresAtMs || currentWallet() !== address) throw Error('The review expired or wallet changed before the signature prompt. Refresh the unsigned review.')
  const signed = await adapter.signTransaction(tx)
  if (currentWallet() !== address || !equal(signed.message.serialize(), message)) throw Error('Wallet changed the reviewed message or active account. Submission was stopped.')
  for (let index = 0; index < previousSignatures.length; index++) {
    if (reviewed.requiredSigners[index] !== address && !equal(signed.signatures[index], previousSignatures[index])) throw Error('Wallet changed another signer’s signature. Submission was stopped.')
  }
  return encode(signed.serialize())
}
