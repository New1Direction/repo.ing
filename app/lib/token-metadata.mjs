// Off-chain token metadata (Metaplex JSON). Wallets, DEX Screener and Jupiter read the
// description and links from here, so it names the repository and links back to it.
export function tokenMetadataJson({ mint, origin, market }) {
  const marketUrl = `${origin}/token/${mint}`
  const githubUrl = market.fullName ? `https://github.com/${market.fullName}` : null
  const description = market.fullName
    ? `$${market.symbol} is the repo.ing market for github.com/${market.fullName}. ` +
      `Trading fees pay the repository's builders in SOL. ` +
      `Community launch: does not imply endorsement by the repository's maintainers.`
    : `Token for public GitHub repository ${market.repoId} on repo.ing.`
  const links = { website: marketUrl, ...(githubUrl && { github: githubUrl }) }
  return {
    name: market.name,
    symbol: market.symbol,
    description,
    image: market.hasImage ? `${origin}/api/token-image/${mint}` : `${origin}/api/repo-logo/${market.repoId}?v=3`,
    external_url: marketUrl,
    ...links,
    extensions: links,
  }
}
