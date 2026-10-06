import { walletBackers } from '../../src/bundle-raise-chain.mjs'
import { anyBundles, loadBundles } from '../../src/bundle-raise-store.mjs'
import { backerJson, bundleJson } from './bundle-state.mjs'

// /wallet for Bundle launches (docs/BUNDLE_LAUNCH.md), as app/lib/stock-wallet.mjs does for stock pairs: the bundles this wallet
// backs (its Backer accounts on chain), each with its raise, the wallet's shares and what it can claim or have refunded.
// - Whatever Bundle launches' switch says: a backer can always find its refund or claim here.
// - Until the site has opened a bundle, and for a wallet that backs none, the overview gets no extra field and makes no chain read
//   beyond one database check: a wallet's response is unchanged.
// - Otherwise { bundles }: the site's bundles the wallet backs (a refunded backer account is closed, so it drops out), or null
//   when they cannot be read now. connection: returns the RPC connection, called only then. allowed(): whether this address may
//   make the program-wide Backer read now (the bundle:read limit, app/lib/request-limits.mjs); when it may not, null.
export async function walletBundleFields(db, connection, wallet, { allowed = () => true } = {}) {
  try {
    if (!await anyBundles(db)) return {}
    if (!allowed()) return { bundles: null }
    const backed = await walletBackers(connection(), wallet)
    const rows = await loadBundles(db, backed.map(item => item.id))
    const bundles = backed.filter(item => rows.has(item.id.toString())).map(({ id, bundle, backer }) => {
      const view = bundleJson({ row: rows.get(id.toString()), bundle })
      return { ...view, backer: backerJson(bundle, backer) }
    })
    return bundles.length ? { bundles } : {}
  } catch { return { bundles: null } }
}
