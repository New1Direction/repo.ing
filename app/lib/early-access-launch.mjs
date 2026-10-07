import { isGithubRepoId } from '../../src/market-identity.mjs'
import { EarlyAccessError, earlyAccessDbcConfig, earlyAccessLaunchable, earlyAccessLookupTable, earlyAccessWindow } from '../../src/early-access.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID } from '../../src/early-access-hook.mjs'
import { hookRules } from '../../src/early-access-rules.mjs'
import { CONTRIBUTOR_ERRORS, fetchRepositoryContributors, replaceContributorSnapshot } from '../../src/github-contributors.mjs'
import { linksForGithubUsers } from '../../src/github-wallet-links.mjs'

// Contributor early access on the launch API (docs/EARLY_ACCESS.md): what a prepare request asks for, decided before anything is
// read or reserved; the repository's contributor snapshot taken under the repository lock; and the guard that decides it again
// after reservation and after the wallet signed. Every refusal is an EarlyAccessError with a message the page can show.
export const EARLY_ACCESS_REFUSALS = Object.freeze({
  unavailable: 'Contributor early access is not available.',
  github: 'Contributor early access is for GitHub repositories only.',
  launchPage: 'Contributor early access is launched from the launch page only.',
  sol: 'Contributor early access launches are paired with SOL only.',
  configured: 'Contributor early access is not configured.',
  changed: 'Contributor early access changed. Review the launch again.',
  options: 'The fair ramp and star unlocks are options of a contributor early access launch: choose a window too.',
  stars: 'Star unlocks needs the fair ramp.',
})
const refuse = key => new EarlyAccessError(EARLY_ACCESS_REFUSALS[key])

// null when the request does not ask for early access (body.earlyAccessSeconds absent), else { windowSeconds, rules }: rules adds
// the fair ramp (body.fairRamp) and star unlocks (body.starUnlocks, with the fair ramp only), each exactly true or absent; they
// are options of an early access launch only (owner decision, 2026-10-07). Refused: while early access cannot launch (switch or
// code gate), for a Hugging Face model, a trend or agent-draft (MCP, CLI) launch, a stock pair, or a window outside 15 minutes
// to 24 hours.
export function earlyAccessRequest(body, { launchable = earlyAccessLaunchable() } = {}) {
  const option = name => { const value = body?.[name]; if (value === undefined || value === null || value === false) return false
    if (value !== true) throw refuse('options'); return true }
  const fairRamp = option('fairRamp'), starUnlocks = option('starUnlocks')
  if (body?.earlyAccessSeconds === undefined || body.earlyAccessSeconds === null) {
    if (fairRamp || starUnlocks) throw refuse('options')
    return null
  }
  if (!launchable) throw refuse('unavailable')
  if (body.hfId !== undefined || !isGithubRepoId(String(body.repoId ?? ''))) throw refuse('github')
  if (body.trendRevision !== undefined || body.agentDraft !== undefined) throw refuse('launchPage')
  if (body.quoteAssetId !== undefined && body.quoteAssetId !== null && body.quoteAssetId !== 'sol') throw refuse('sol')
  if (starUnlocks && !fairRamp) throw refuse('stars')
  return { windowSeconds: earlyAccessWindow(body.earlyAccessSeconds), rules: hookRules({ fairRamp, starUnlocks }) }
}

// The settings an early access launch needs: its DBC config and its lookup table (base58), or a refusal naming neither value.
export function earlyAccessSettings(env = process.env) {
  const config = earlyAccessDbcConfig(env), lookupTable = earlyAccessLookupTable(env)
  if (!config || !lookupTable) throw refuse('configured')
  return { config: config.toBase58(), lookupTable: lookupTable.toBase58() }
}

// The snapshot step for the coordinator (src/launch-coordinator.mjs, earlyAccess.snapshot): GitHub's contributor list replaces
// the repository's rows in early_access_contributors; the launcher stays on the allow list after its first buy only when its
// wallet is linked to one of those accounts. A GitHub failure or an empty list refuses the launch (never an empty list silently).
export function contributorSnapshotStep({ pool, fetchImpl = fetch, fetchContributors = fetchRepositoryContributors }) {
  return async ({ repo, wallet }) => {
    const contributors = await fetchContributors({ githubRepoId: repo.githubRepoId, fullName: repo.fullName, fetchImpl })
    if (!contributors.length) throw new EarlyAccessError(CONTRIBUTOR_ERRORS.none)
    await replaceContributorSnapshot(pool, repo.githubRepoId, contributors)
    const links = await linksForGithubUsers(pool, contributors.map(contributor => contributor.githubUserId))
    return { contributors: contributors.length, linkedWallets: links.length, keepLauncher: links.some(link => link.wallet === wallet) }
  }
}

// launchGuard: a market stamped for early access goes on only while early access can launch, on the hook program and config it
// was prepared with. versioned: whether the review being signed is a v0 transaction, which only an early access market has.
export function earlyAccessGuard(config, { versioned = null, launchable = earlyAccessLaunchable, configured = () => earlyAccessDbcConfig()?.toBase58() ?? null } = {}) {
  return async ({ market }) => {
    const stamped = market.earlyAccessEnd !== null && market.earlyAccessEnd !== undefined
    if (versioned !== null && stamped !== versioned) throw refuse('changed')
    if (!stamped) return
    if (!launchable()) throw refuse('unavailable')
    if (market.transferHookProgram !== EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58() || configured() !== config) throw refuse('changed')
  }
}
