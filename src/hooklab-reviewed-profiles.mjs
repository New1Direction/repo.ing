// Operator profiles a sent operation may have been reviewed under (sha256 of the profile JSON). Reconcile settles an
// operation under the profile it was reviewed under when that profile is one of these, so deploying a new production
// bundle never strands an operation that is still waiting for its receipt. Only reconcile uses this: every new review,
// wallet request and send needs today's profile. Add each production bundle's profile when it is generated (bundle 3
// after the native-SOL upgrade).
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export const REVIEWED_PROFILE_SHA256 = Object.freeze([
  'dd8606aa4c8107d4ae4883a5a1c182b4968a38ddf48905e19c635d31bcd24772', // config/hooklab-production-bundle-2.json
])
const sha = text => createHash('sha256').update(text).digest('hex')

// A trade envelope ({json, expectedSha256, idls, elfLengths, providers}) reviewed under an allowed profile, on today's
// chain and providers (which the receipt is read from).
export function reviewedEnvelope(stored, current, allowlist = REVIEWED_PROFILE_SHA256) {
  try {
    return typeof stored?.json === 'string' && sha(stored.json) === stored.expectedSha256 && allowlist.includes(stored.expectedSha256)
      && isDeepStrictEqual(stored.providers, current.providers) && JSON.parse(stored.json).genesisHash === JSON.parse(current.json).genesisHash
  } catch { return false }
}

// A wallet-funding profile ({genesisHash, programs, quoteMint, profileSha256, providers}) reviewed under an allowed
// profile, naming today's chain, programs, bridged-SOL mint and providers.
export function reviewedFundingProfile(stored, current, allowlist = REVIEWED_PROFILE_SHA256) {
  const { profileSha256, ...rest } = stored ?? {}, { profileSha256: ignored, ...today } = current
  return allowlist.includes(profileSha256) && isDeepStrictEqual(rest, today)
}
