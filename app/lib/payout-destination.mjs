import { activateDuePayoutAddresses, readPayoutDestinations } from '../../src/payout-address.mjs'

// Active binding and waiting pasted address per repository, for the claim page and the Builders dashboard. A pasted
// address whose hold has passed is activated first (database only; a repository busy with a claim or binding change is
// left to that holder or the worker), so a page never shows, or seals a review for, a recipient that is no longer current.
export async function currentPayoutDestinations(pool, repoIds) {
  try { await activateDuePayoutAddresses(pool, { repoIds }) }
  catch (error) { console.error('payout address activation unavailable', { error: error?.code ?? error?.name ?? 'error' }) }
  return readPayoutDestinations(pool, repoIds)
}
