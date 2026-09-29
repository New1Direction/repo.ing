import { OFFICIAL_TOKEN } from './official-token.mjs'
export const SITE_URL = 'https://repo.ing'
const SOURCE_URL = 'https://github.com/New1Direction/repo.ing'
const ORGANIZATION_ID = `${SITE_URL}/#organization`
const WEBSITE_ID = `${SITE_URL}/#website`

// Inline <script> content: repo descriptions are user-controlled, so no character may close the tag or
// start an HTML comment. JSON.parse reads the escapes back as the original characters.
const UNSAFE = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' }
export function serializeJsonLd(data) {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, character => UNSAFE[character])
}

export function siteJsonLd(lang = 'en') {
  return { '@context': 'https://schema.org', '@graph': [
    { '@type': 'Organization', '@id': ORGANIZATION_ID, name: 'repo.ing', url: SITE_URL, logo: `${SITE_URL}/apple-icon.png`,
      slogan: 'The market layer for open source.', sameAs: [SOURCE_URL, OFFICIAL_TOKEN.xUrl] },
    { '@type': 'WebSite', '@id': WEBSITE_ID, name: 'repo.ing', url: SITE_URL, inLanguage: lang === 'ja' ? ['en', 'ja'] : 'en',
      description: 'The market layer for open source. Launch and trade tokens for public GitHub repositories — every trade pays the builders.',
      publisher: { '@id': ORGANIZATION_ID } },
  ] }
}

export function faqJsonLd({ url, lang, questions }) {
  return { '@context': 'https://schema.org', '@type': 'FAQPage', url, inLanguage: lang, isPartOf: { '@id': WEBSITE_ID },
    mainEntity: questions.map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } })) }
}

// Deliberately no price, offer, or rating markup: this describes the page and the repository, not an investment.
export function tokenJsonLd(market) {
  const url = `${SITE_URL}/token/${market.mint}`
  const codeRepository = `https://github.com/${market.fullName}`
  return { '@context': 'https://schema.org', '@type': 'WebPage', '@id': url, url, inLanguage: 'en',
    name: `$${market.symbol} · ${market.fullName} — repo.ing`, isPartOf: { '@id': WEBSITE_ID },
    about: { '@type': 'SoftwareSourceCode', name: market.fullName, url: codeRepository, codeRepository,
      ...(market.description ? { description: market.description } : {}),
      identifier: { '@type': 'PropertyValue', propertyID: 'GitHub repository ID', value: String(market.repoId) } } }
}
