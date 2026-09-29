import assert from 'node:assert/strict'
import test from 'node:test'
import { faqJsonLd, serializeJsonLd, siteJsonLd, tokenJsonLd } from '../app/lib/json-ld.mjs'

const hostile = 'Fast </script><script>alert(1)</script> <!-- & \u2028\u2029 done'
const market = { mint: 'So11111111111111111111111111111111111111112', symbol: 'CAT', fullName: 'owner/repo', repoId: '123', description: hostile }

test('serialized JSON-LD cannot close its script tag and parses back unchanged', () => {
  const data = tokenJsonLd(market)
  const html = serializeJsonLd(data)
  assert.doesNotMatch(html, /[<>&\u2028\u2029]/)
  assert.deepEqual(JSON.parse(html), data)
  assert.equal(JSON.parse(html).about.description, hostile)
})

test('token pages describe the repository without price, offer, or rating markup', () => {
  const data = tokenJsonLd({ ...market, description: null })
  assert.equal(data['@type'], 'WebPage')
  assert.equal(data.url, `https://repo.ing/token/${market.mint}`)
  assert.deepEqual([data.about['@type'], data.about.codeRepository], ['SoftwareSourceCode', 'https://github.com/owner/repo'])
  assert.equal('description' in data.about, false)
  assert.doesNotMatch(JSON.stringify(data), /offers|price|aggregateRating|review/i)
})

test('site and FAQ graphs carry the expected schema.org types', () => {
  assert.deepEqual(siteJsonLd()['@graph'].map(node => node['@type']), ['Organization', 'WebSite'])
  const faq = faqJsonLd({ url: 'https://repo.ing/ja', lang: 'ja', questions: [['Q?', 'A.']] })
  assert.equal(faq['@type'], 'FAQPage')
  assert.deepEqual(faq.mainEntity[0], { '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } })
})
