// Reviews hash JSON.stringify output, which follows key order, and a Postgres jsonb column hands a stored settlement
// context back with its keys reordered. Collectors build, and settlement paths rebuild, what a review hashes in this one
// construction order, so a recompiled review is byte-identical to the original.
// Known keys come first in that order; any other key is kept after them, so strict checks still refuse it.
const ordered = (keys, value) => ({ ...Object.fromEntries(keys.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]])), ...value })
const account = a => a === null ? null : ordered(['address', 'owner', 'executable', 'lamports', 'dataBase64'], a)
export const canonicalObservation = o => ({ ...ordered(['provider', 'genesisHash', 'commitment', 'slot', 'observedAtMs', 'accounts'], o),
  accounts: o.accounts.map(x => ordered(['address', 'account'], { ...x, account: account(x.account) })) })
// A launch review also hashes its preparation proof and the reviewed state hashes.
export const LAUNCH_STATE_HASHES = Object.freeze(['launchConfig', 'swapConfig', 'launchGovernance', 'swapGovernance', 'authorization', 'quoteMint'])
export const canonicalLaunchProof = p => ({ ...ordered(['schema', 'profileSha256', 'preparationIntentSha256', 'executionSlot', 'preparedAccountHashes'], p),
  preparedAccountHashes: ordered(['policy', 'registry', 'selectedConfig'], p.preparedAccountHashes) })
export const canonicalStateHashes = h => ordered(LAUNCH_STATE_HASHES, h)
