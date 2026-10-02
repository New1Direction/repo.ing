import { drizzle } from 'drizzle-orm/node-postgres'
import { AgentLaunchError, signLaunchDraft } from './agent-launch-draft.mjs'
import { projectLaunchStatus } from './agent-launch.mjs'
import { DISCOVERY_VERSION, DISCOVERY_CAP, DISCOVERY_WINDOW_MS } from './discovery-rewards.mjs'
import { INITIAL_BUY_CAP_BPS } from './launch-buy.mjs'
import { activeDecision } from './maintainer-opt-outs.mjs'
import { HF_DISCLAIMER } from './hf-copy.mjs'
import { hfModelUrl } from './hf-url.mjs'
import { HF_OPT_OUT_ERROR, isHfMarketId, modelLookupError, modelTokenDefaults, persistModelRepository, resolveModel } from './hf-launch.mjs'

// MCP service for Hugging Face model markets (resolve_model, create_model_launch_draft, get_model_launch_status): the model
// counterparts of src/agent-launch.mjs, under the same rules. A draft is only a signed browser review link; the user
// chooses artwork and approves the costs in their own wallet. Models are read by their stable _id (src/hf-launch.mjs).
export function createModelLaunchService({ pool, origin, secret, config, discovery, allocation, hf, now = Date.now }) {
  const status = async marketId => {
    const { rows } = await pool.query('select status,launch_finality,indexed_at,mint,pool,launch_signature,launcher_wallet from markets where github_repo_id=$1', [marketId])
    return { marketId, ...projectLaunchStatus(rows[0], origin), observedAt: new Date(now()).toISOString() }
  }
  async function resolveModelMarket(input) {
    let repo
    try {
      repo = await resolveModel({ pool, hf, input })
      await persistModelRepository(drizzle(pool), repo)
    } catch (error) {
      const refusal = modelLookupError(error)
      throw new AgentLaunchError(refusal.status >= 500 ? 'Hugging Face could not be checked right now. Try again later.' : refusal.message)
    }
    const marketId = repo.githubRepoId.toString()
    const [launch, optOut] = await Promise.all([status(marketId), activeDecision(pool, marketId)])
    // ownerOptedOut: the model's owner declined the market or opted the model out; it cannot be launched.
    return { marketId, hfId: repo.hfId, path: repo.fullName, modelUrl: hfModelUrl(repo.fullName),
      owner: { handle: repo.owner, kind: repo.ownerKind }, gated: repo.gated !== false,
      derivativeOf: repo.baseModels.map(base => ({ path: base.path, relation: base.relation })),
      ...launch, ownerOptedOut: Boolean(optOut), reviewUrl: `${origin}/launch/${marketId}`, disclaimer: HF_DISCLAIMER }
  }
  return {
    resolveModel: ({ model }) => resolveModelMarket(model),
    async createModelDraft({ model, tokenName, tokenSymbol, initialBuy = 'none' }) {
      const resolved = await resolveModelMarket(model)
      if (resolved.live) return { ...resolved, draftCreated: false, reason: 'A canonical market already exists. Open its market.' }
      if (resolved.ownerOptedOut) throw new AgentLaunchError(HF_OPT_OUT_ERROR)
      if (resolved.state !== 'not_launched') throw new AgentLaunchError('This model has a launch in progress or requiring review. Check launch status before continuing.')
      if (!config) throw new AgentLaunchError('Launch configuration is unavailable.')
      const defaults = modelTokenDefaults(resolved.path.split('/')[1])
      const name = tokenName ?? defaults.tokenName, symbol = tokenSymbol ?? defaults.tokenSymbol
      if (!symbol) throw new AgentLaunchError('Choose a ticker with 1–10 letters or numbers.')
      // allocation is the launch rule every draft records (verifyLaunchDraft compares it); a model market never gets the
      // builder allocation or the verification bonus (rewardStamps, markets_hf_no_rewards).
      const { draft, token } = signLaunchDraft({ repoId: resolved.marketId, fullName: resolved.path, tokenName: name, tokenSymbol: symbol,
        initialBuy, config, discovery, allocation }, { secret, now: now() })
      return { ...resolved, state: 'awaiting_browser_review', draftCreated: true,
        reviewUrl: `${origin}/launch/${resolved.marketId}?draft=${encodeURIComponent(token)}`, expiresAt: new Date(draft.expiresAt).toISOString(),
        tokenName: name, tokenSymbol: symbol, initialBuyPercent: Number(initialBuy === 'none' ? 0 : initialBuy) / 100,
        rules: { config, initialBuyMaxSupplyBps: INITIAL_BUY_CAP_BPS, builderAllocationEnabled: false, verificationBonus: false,
          creatorFees: "Accrue for the model's current Hugging Face owner, claimable after they verify on repo.ing.",
          discovery: discovery ? { version: DISCOVERY_VERSION, maxLamports: DISCOVERY_CAP.toString(), maxDurationMs: DISCOVERY_WINDOW_MS,
            endsAtGraduation: true, detailsUrl: `${origin}/how-it-works` } : null,
          costs: 'Quoted and simulated during browser review; this draft is not a price quote.' },
        next: 'Open the review URL. Choose artwork, check the token details and live costs, then explicitly approve in your wallet. Nothing is reserved or launched by this draft. The signing wallet is the discoverer.' }
    },
    async getModelStatus({ marketId }) {
      if (!isHfMarketId(marketId)) throw new AgentLaunchError('Use the marketId that resolve_model returned.')
      const [launch, { rows: [model] }] = await Promise.all([status(marketId),
        pool.query('select hf_id as "hfId", repo_path as "path" from hf_models where market_ref=$1', [marketId])])
      return { ...launch, hfId: model?.hfId ?? null, path: model?.path ?? null }
    },
  }
}
