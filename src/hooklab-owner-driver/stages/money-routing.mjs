// Before any public activation (native-launches --to on, open-creation --to on, open-launches, open-trading) both
// configs are read again, and the stage refuses unless they route the platform's money to the configured treasury and
// quote with the stack's quote marker: launch Config treasury and quote_mint, swap Config treasury and fee_collector
// (owner blocker 3; hook-lab independent delta review L-3). config-init and quote-marker check these at setup; this
// keeps a later governed change, or a wrong config, from going live. Deactivation is never held back.
import { derivedAddresses } from '../pins.mjs'
import { readAccounts } from '../rpc.mjs'
import { cdecode, owned } from './common.mjs'

const b58 = key => key.toBase58()

/** Why these two decoded Configs do not route to ctx.roles.treasury and quote with ctx.quoteMint; [] when they do. */
export function routingProblems(ctx, launchConfig, swapConfig) {
  const treasury = ctx.roles.treasury, marker = ctx.quoteMint, problems = []
  if (b58(launchConfig.treasury) !== treasury) problems.push(`launch Config treasury ${b58(launchConfig.treasury)} is not the configured treasury ${treasury}`)
  if (b58(launchConfig.quote_mint) !== marker) problems.push(`launch Config quote_mint ${b58(launchConfig.quote_mint)} is not the stack's quote marker ${marker}`)
  if (b58(swapConfig.treasury) !== treasury) problems.push(`swap Config treasury ${b58(swapConfig.treasury)} is not the configured treasury ${treasury}`)
  if (b58(swapConfig.fee_collector) !== treasury) problems.push(`swap Config fee_collector ${b58(swapConfig.fee_collector)} is not the configured treasury ${treasury}`)
  return problems
}

/** null when the money routing is right; otherwise a stage result that refuses (plan shows it, execute refuses it). */
export async function checkMoneyRouting(ctx, stage) {
  const d = derivedAddresses(ctx.programs, ctx.quoteMint)
  const snapshot = await readAccounts(ctx.readers, ctx.genesis, [d.launchConfig, d.swapConfig])
  const launch = cdecode(ctx, 'launch', 'Config', owned(snapshot.accounts, d.launchConfig, ctx.programs.launch, 'launch config'))
  const swap = cdecode(ctx, 'swap', 'Config', owned(snapshot.accounts, d.swapConfig, ctx.programs.swap, 'swap config'))
  const problems = routingProblems(ctx, launch, swap)
  return problems.length ? { blocked: `${stage}: refusing to activate: ${problems.join('; ')}`, observedSlot: snapshot.slot } : null
}
