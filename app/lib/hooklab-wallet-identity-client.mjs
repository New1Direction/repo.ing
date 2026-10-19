// The server sets a challenge's expiry with its own clock (5 minutes) and enforces it when verifying the signature.
// Browser clocks differ from it by milliseconds to minutes, so the expiry bounds here allow that much drift: with no
// allowance, any browser even 1 ms behind the server refused every challenge and sign-in stopped before the wallet.
export const CLOCK_SKEW_MS = 10 * 60_000

// Validate the exact identity-only signing request before presenting it to a wallet.
export function validateWalletIdentityChallenge(challenge, { wallet, origin, genesisHash, nowMs = Date.now() }) {
  const fail = () => { throw Error('Wallet identity challenge changed or expired. Start again.') }
  if (!challenge || challenge.wallet !== wallet || !/^[a-f0-9]{64}$/.test(challenge.nonce ?? '')
    || typeof challenge.message !== 'string' || challenge.message.length > 2048) fail()
  const expiry = Date.parse(challenge.expiresAt)
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== challenge.expiresAt
    || expiry <= nowMs - CLOCK_SKEW_MS || expiry > nowMs + 300000 + CLOCK_SKEW_MS) fail()
  const lines = challenge.message.split('\n')
  if (lines.length !== 9 || lines[0] !== 'repo.ing general launcher wallet identity v1'
    || lines[1] !== `Origin: ${origin}` || lines[2] !== 'Audience: general-launcher'
    || lines[3] !== `Genesis: ${genesisHash}` || lines[4] !== `Wallet: ${wallet}`
    || !/^Browser binding SHA256: [a-f0-9]{64}$/.test(lines[5])
    || lines[6] !== `Nonce: ${challenge.nonce}` || lines[7] !== `Expires: ${challenge.expiresAt}`
    || lines[8] !== 'Sign in to this launcher only. No spending, transaction, creator grant or launch authorization.') fail()
  return challenge
}

export function walletIdentitySessionState(response, nowMs = Date.now()) {
  if (!response || response.signedIn !== true) return null
  const value = response.principal ?? response
  if (typeof value.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.wallet)
    || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= nowMs) return null
  return { wallet: value.wallet, expiresAt: value.expiresAt }
}
