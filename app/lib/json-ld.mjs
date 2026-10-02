import { OFFICIAL_TOKEN } from './official-token.mjs'
import { HF_DISCLAIMER, isModelMarket, modelPageUrl } from './hf-model-display.mjs'
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
  if (isModelMarket(market)) return modelJsonLd(market)
  const url = `${SITE_URL}/token/${market.mint}`
  const codeRepository = `https://github.com/${market.fullName}`
  return { '@context': 'https://schema.org', '@type': 'WebPage', '@id': url, url, inLanguage: 'en',
    name: `$${market.symbol} · ${market.fullName} — repo.ing`, isPartOf: { '@id': WEBSITE_ID },
    about: { '@type': 'SoftwareSourceCode', name: market.fullName, url: codeRepository, codeRepository,
      ...(market.description ? { description: market.description } : {}),
      identifier: { '@type': 'PropertyValue', propertyID: 'GitHub repository ID', value: String(market.repoId) } } }
}

// A Hugging Face model market page. The description leads with the disclaimer; the model is a CreativeWork (schema.org has
// no model type) linked to its Hugging Face page and identified by its repo.ing market id.
function modelJsonLd(market) {
  const url = `${SITE_URL}/token/${market.mint}`, modelUrl = modelPageUrl(market.fullName)
  return { '@context': 'https://schema.org', '@type': 'WebPage', '@id': url, url, inLanguage: 'en',
    name: `$${market.symbol} · ${market.fullName} — repo.ing`, isPartOf: { '@id': WEBSITE_ID },
    description: `${HF_DISCLAIMER} $${market.symbol} is the repo.ing market for the Hugging Face model ${market.fullName}.`,
    about: { '@type': 'CreativeWork', name: market.fullName, ...(modelUrl ? { url: modelUrl } : {}),
      ...(market.description ? { description: market.description } : {}),
      identifier: { '@type': 'PropertyValue', propertyID: 'repo.ing model market ID', value: String(market.repoId) } } }
}
