// Test fixtures only. Generated ELF-bearing JSON stays outside tracked source.
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const plans={'hooklab-max-wallet-buy-app-plan.json':'buy-app-plan.json','hooklab-max-wallet-sell-app-plan.json':'sell-app-plan.json'}
const allowed = new Set([...Object.keys(plans),'hooklab-max-wallet-rust-vector.json', 'hooklab-max-wallet-buy-rust-vector.json', 'hooklab-max-wallet-sell-rust-vector.json'])
export function generatedMaxWalletArtifact(name, baseUrl) {
  if (!allowed.has(name)) throw Error('Unknown generated max-wallet artifact')
  const root = process.env.HOOKLAB_GENERATED_FIXTURE_DIR
  if (root === undefined) return new URL(`./${name}`, baseUrl)
  if (!root || !isAbsolute(root)) throw Error('HOOKLAB_GENERATED_FIXTURE_DIR must be an absolute test-artifact directory')
  return pathToFileURL(resolve(root, plans[name]??name))
}
