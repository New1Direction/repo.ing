// What a declined market says off its token page: its Blink (app/lib/solana-actions.mjs), its link-preview card
// (app/lib/og-market-card.jsx) and its page metadata. A current GitHub admin, or for a Hugging Face model market its owner,
// declined it (src/maintainer-opt-outs.mjs). The sentences are the token page banners' (app/components/maintainer-declined.jsx,
// app/components/hf/model-token-page.jsx). Such a market still trades so holders can exit, so nothing here hides a trade
// button; it only stops saying that trades pay the builders.
import { isModelMarket } from './hf-model-display.mjs'

export const declinedLabel = market => isModelMarket(market) ? 'Declined by the owner' : 'Declined by the maintainer'

// "The maintainer of owner/name has declined this market. repo.ing does not promote it, and it is not endorsed by the project."
export function declinedSummary(market) {
  const name = market.fullName || `repository ${market.repoId}`
  return isModelMarket(market)
    ? `The owner of ${name} has declined this market. repo.ing does not promote it, and it is not endorsed by the model’s creators.`
    : `The maintainer of ${name} has declined this market. repo.ing does not promote it, and it is not endorsed by the project.`
}

export const DECLINED_TRADING = 'Trading stays open so holders can exit.'

// The link-preview card's footer line in place of "Every trade pays…" (a model market's card already carries its disclaimer).
export const declinedFooter = market => isModelMarket(market) ? DECLINED_TRADING : `Not endorsed by the project. ${DECLINED_TRADING}`
