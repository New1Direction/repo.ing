import { OFFICIAL_TOKEN } from './official-token.mjs'
import { HF_DISCLAIMER, isModelMarket } from './hf-model-display.mjs'
import { stockPairFeeLine } from '../../src/stock-owner-claims.mjs'
// Off-chain token metadata (Metaplex JSON). Wallets, DEX Screener and Jupiter read the
// description and links from here, so it names the repository and links back to it.
// repo.ing's own token is launched by the repository's own team, so it gets an official description
// and the home page as its website instead of the community-launch disclaimer.
// A stock pair (market.quoteAssetId set) says what its trades pay, in its stock, instead of builders in SOL.
const OFFICIAL_DESCRIPTION = 'The official token of repo.ing, the market layer for open source. ' +
  'Every trade pays builders, and 60% of platform fees buy back $REPOING.'

export function tokenMetadataJson({ mint, origin, market }) {
  const official = mint === OFFICIAL_TOKEN.mint
  if (!official && isModelMarket(market)) return modelMetadataJson({ mint, origin, market })
  const websiteUrl = official ? origin : `${origin}/token/${mint}`
  const githubUrl = market.fullName ? `https://github.com/${market.fullName}` : null
  const description = official ? OFFICIAL_DESCRIPTION
    : market.fullName
      ? `$${market.symbol} is the repo.ing market for github.com/${market.fullName}. ` +
        `${stockPairFeeLine(market) ?? 'Trading fees pay the repository\'s builders in SOL.'} ` +
        `Community launch: does not imply endorsement by the repository's maintainers.`
      : `Token for public GitHub repository ${market.repoId} on repo.ing.`
  // Only repo.ing's own token carries repo.ing's X account; other tokens are community launches for
  // other people's repositories, and linking our account would read as an endorsement.
  const links = { website: websiteUrl, ...(githubUrl && { github: githubUrl }), ...(official && { twitter: OFFICIAL_TOKEN.xUrl }) }
  return {
    name: market.name,
    symbol: market.symbol,
    description,
    image: market.hasImage ? `${origin}/api/token-image/${mint}` : `${origin}/api/repo-logo/${market.repoId}?v=4`,
    external_url: websiteUrl,
    ...links,
    extensions: links,
  }
}

// A Hugging Face model market: names the model and who its fees pay, with the full disclaimer, and links only to its
// market page (no Hugging Face or GitHub link that could read as an official listing).
function modelMetadataJson({ mint, origin, market }) {
  const websiteUrl = `${origin}/token/${mint}`
  const description = market.fullName
    ? `$${market.symbol} is the repo.ing market for the Hugging Face model huggingface.co/${market.fullName}. ` +
      `Trading fees pay the model's owner in SOL. ${HF_DISCLAIMER}`
    : `Token for a Hugging Face model market (${market.repoId}) on repo.ing. ${HF_DISCLAIMER}`
  const links = { website: websiteUrl }
  return {
    name: market.name,
    symbol: market.symbol,
    description,
    image: market.hasImage ? `${origin}/api/token-image/${mint}` : `${origin}/api/repo-logo/${market.repoId}?v=4`,
    external_url: websiteUrl,
    ...links,
    extensions: links,
  }
}
