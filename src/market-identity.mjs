// Which source a market belongs to, decided by its id alone (pure, no I/O). Every market id lives in the existing
// github_repo_id columns: GitHub repository ids are below 2^52, and Hugging Face model markets take their ids from
// hf_models.market_ref (sequence hf_market_ref_seq, migration 0049) in HF_MARKET_REF_MIN..HF_MARKET_REF_MAX. Both ranges
// stay below 2^53, so a stray Number(id) is still exact. 2^52 itself belongs to neither source.
export const GITHUB_REPO_ID_MAX = 4503599627370495n
export const HF_MARKET_REF_MIN = 4503599627370497n
export const HF_MARKET_REF_MAX = 7000000000000000n

export class MarketIdentityError extends Error {}

// A bigint, a safe-integer number or a decimal string; anything else (floats, signs, spaces, hex, exponents) is refused.
function integerId(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value)
  throw new MarketIdentityError('Market ID must be an integer')
}

export function marketSource(id) {
  const value = integerId(id)
  if (value >= 1n && value <= GITHUB_REPO_ID_MAX) return 'github'
  if (value >= HF_MARKET_REF_MIN && value <= HF_MARKET_REF_MAX) return 'huggingface'
  throw new MarketIdentityError('Market ID is outside every source range')
}

export const isMarketId = id => { try { marketSource(id); return true } catch { return false } }
export const isGithubRepoId = id => isMarketId(id) && marketSource(id) === 'github'

// Called first in every GitHub-calling path (tests/market-identity-guards.test.mjs), so a Hugging Face id never reaches
// GitHub, where a 404 could be taken as a decision about the market. Returns the id as a bigint.
export function assertGithubRepoId(id) {
  if (marketSource(id) !== 'github') throw new MarketIdentityError('Not a GitHub repository ID')
  return integerId(id)
}

export function assertHfMarketId(id) {
  if (marketSource(id) !== 'huggingface') throw new MarketIdentityError('Not a Hugging Face market ID')
  return integerId(id)
}

// Payout authority (claims, wallet binding) must come from the market's own source. An authority without a source
// field is GitHub's: every verifier written before Hugging Face markets.
export function assertAuthoritySource(authority, id) {
  const market = marketSource(id), source = authority?.source ?? 'github'
  if (source !== market) throw new MarketIdentityError(`A ${source} authority cannot act for a ${market} market`)
}
