import { bundleLaunchable } from '../../src/bundle-launch.mjs'
import { walletBackers } from '../../src/bundle-raise-chain.mjs'
import { loadBundles } from '../../src/bundle-raise-store.mjs'
import { backerJson, bundleJson } from './bundle-state.mjs'

// /wallet for Bundle launches (docs/BUNDLE_LAUNCH.md), as app/lib/stock-wallet.mjs does for stock pairs: the bundles this wallet
// backs (its Backer accounts on chain), each with its raise, the wallet's shares and what it can claim or have refunded.
// - While Bundle launches are dark the overview gets no extra field and makes no extra read: a wallet's response is unchanged.
// - Otherwise { bundles }: the site's bundles the wallet backs (a refunded backer account is closed, so it drops out), or null
//   when they cannot be read now. connection: returns the RPC connection, called only then.
export async function walletBundleFields(db, connection, wallet, { launchable = bundleLaunchable } = {}) {
  if (!launchable()) return {}
  try {
    const backed = await walletBackers(connection(), wallet)
    const rows = await loadBundles(db, backed.map(item => item.id))
    const bundles = backed.filter(item => rows.has(item.id.toString())).map(({ id, bundle, backer }) => {
      const view = bundleJson({ row: rows.get(id.toString()), bundle })
      return { ...view, backer: backerJson(bundle, backer) }
    })
    return { bundles }
  } catch { return { bundles: null } }
}
