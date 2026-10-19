// Server bootstrap only, behind HOOK_NATIVE_LAUNCHES_ENABLED. Creator fee claims for native-SOL launches: their own
// lifecycle on the shared signing table (stage native-claim), the two-provider claim resolver and a display read.
// Never reads keys or endpoints from requests or activates itself.
import { nativeSigningLifecycle } from '../../src/hooklab-native-signing.mjs'
import { nativeTransactionSender } from '../../src/hooklab-native-transaction-sender.mjs'
import { nativeClaimResolver } from '../../src/hooklab-native-claim-resolver.mjs'
import { stagedResolver } from '../../src/hooklab-wallet-funding-resolver.mjs'
import { CLAIM_OPERATION, CLAIM_STAGE, readNativeClaimStatus } from '../../src/hooklab-native-claim.mjs'
const runtimeKey = Symbol.for('repo.ing.hooklab.native-claim-runtime')

export function createNativeClaimRuntime(pool, { origin, nativeLaunchesApproved = false, config, profile, dossierJson, connections, limits } = {}) {
  if (nativeLaunchesApproved !== true) throw Error('Explicit native-launch approval required')
  const resolver = nativeClaimResolver({ config, profile, dossierJson, connections, limits })
  const lifecycle = nativeSigningLifecycle(pool, { enabled: true, origin, resolver: stagedResolver({ [CLAIM_STAGE]: resolver }), sender: nativeTransactionSender({ enabled: true, connections }),
    custodyAdapter: null, stageOperations: { [CLAIM_STAGE]: CLAIM_OPERATION } })
  const programs = JSON.parse(profile.json).programs
  // Display reads use the primary provider; the claim itself re-verifies on both providers before anything is signed.
  const status = mint => readNativeClaimStatus({ connection: connections[0].connection, mint, programs })
  return Object.freeze({ origin, nativeLaunchesApproved: true, lifecycle, status })
}
export function installNativeClaimRuntime(value) {
  if (nativeClaimRuntime() || !value || value.nativeLaunchesApproved !== true || !value.lifecycle || typeof value.status !== 'function') throw Error('Complete approved claim runtime required')
  globalThis[runtimeKey] = Object.freeze(value)
}
export function nativeClaimRuntime() { return globalThis[runtimeKey] ?? null }
