import { OFFICIAL_TOKEN } from './official-token.mjs'
// Off-chain token metadata (Metaplex JSON). Wallets, DEX Screener and Jupiter read the
// description and links from here, so it names the repository and links back to it.
// repo.ing's own token is launched by the repository's own team, so it gets an official description
// and the home page as its website instead of the community-launch disclaimer.
const OFFICIAL_DESCRIPTION = 'The official token of repo.ing, the market layer for open source. ' +
  'Every trade pays builders, and 60% of platform fees buy back $REPOING.'

export function tokenMetadataJson({ mint, origin, market }) {
  const official = mint === OFFICIAL_TOKEN.mint
  const websiteUrl = official ? origin : `${origin}/token/${mint}`
  const githubUrl = market.fullName ? `https://github.com/${market.fullName}` : null
  const description = official ? OFFICIAL_DESCRIPTION
    : market.fullName
      ? `$${market.symbol} is the repo.ing market for github.com/${market.fullName}. ` +
        `Trading fees pay the repository's builders in SOL. ` +
        `Community launch: does not imply endorsement by the repository's maintainers.`
      : `Token for public GitHub repository ${market.repoId} on repo.ing.`
  // Only repo.ing's own token carries repo.ing's X account; other tokens are community launches for
  // other people's repositories, and linking our account would read as an endorsement.
  const links = { website: websiteUrl, ...(githubUrl && { github: githubUrl }), ...(official && { twitter: OFFICIAL_TOKEN.xUrl }) }
  return {
    name: market.name,
    symbol: market.symbol,
    description,
    image: market.hasImage ? `${origin}/api/token-image/${mint}` : `${origin}/api/repo-logo/${market.repoId}?v=3`,
    external_url: websiteUrl,
    ...links,
    extensions: links,
  }
}
