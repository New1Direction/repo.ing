// Coin profile for owner-approved launches: what a creator types for links is normalized once, the same way in the
// launch form and on the server, and the metadata repo.ing serves for the coin is built from it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { COIN_DESCRIPTION_MAX, coinImageUrl, coinLinks, coinMetadataJson, coinMetadataUri, coinProfileFields, xHandle, telegramHandle, websiteUrl } from '../src/hooklab-coin-profile.mjs'
import { coinMetadataAlias, coinMetadataId, selectedCoinMetadataUri } from '../src/hooklab-coin-profile.mjs'

test('compact metadata IDs are strict canonical UUID bytes and save 40 URI bytes', () => {
  const id = '6f1c3b0e-3b7a-4c55-9d7e-2d7d1b6a9c10', origin = 'https://localhost:22466'
  const alias = coinMetadataAlias(id)
  assert.equal(alias, 'bxw7Djt6TFWdfi19G2qcEA')
  assert.equal(coinMetadataId(alias), id)
  assert.equal(selectedCoinMetadataUri(origin, id), `${origin}/h/${alias}`)
  assert.equal(Buffer.byteLength(coinMetadataUri(origin, id)), 88)
  assert.equal(Buffer.byteLength(selectedCoinMetadataUri(origin, id)), 48)
  // Nonzero unused trailing bits decode to the same bytes in permissive base64 decoders.
  for (const bad of [alias.slice(0,-1)+'B', alias+'==', alias+'x', alias.slice(1), '', 'A'.repeat(21)+'!', ' '.concat(alias), '_'.repeat(22)])
    assert.throws(() => coinMetadataId(bad), /Invalid/, bad)
  for (const bad of [id.toUpperCase(), id.replaceAll('-', ''), 'not-a-uuid', id.replace('-4c55-', '-0c55-')])
    assert.throws(() => coinMetadataAlias(bad), /Invalid/, bad)
})

test('an X account can be typed the way people copy it', () => {
  for (const typed of ['repocat', '@repocat', 'x.com/repocat', 'https://x.com/repocat', 'https://twitter.com/repocat/', 'www.x.com/repocat?s=21', ' @repocat '])
    assert.equal(xHandle(typed), 'repocat', typed)
  assert.equal(xHandle(''), null)
  for (const bad of ['repo cat', '@', 'x.com/', 'sixteen_chars_xx', 'https://evil.com/repocat', 'x.com/repocat/status/1'])
    assert.throws(() => xHandle(bad), /X account/, bad)
})

test('a Telegram link or handle becomes its handle', () => {
  for (const typed of ['repocat', '@repocat', 't.me/repocat', 'https://t.me/repocat', 'https://telegram.me/repocat/'])
    assert.equal(telegramHandle(typed), 'repocat', typed)
  assert.equal(telegramHandle(''), null)
  for (const bad of ['abc', 't.me/+invitecode', 'https://example.com/repocat', 'has space']) assert.throws(() => telegramHandle(bad), /Telegram/, bad)
})

test('a website gets https when left out and must be a public https address', () => {
  assert.equal(websiteUrl('repo.ing'), 'https://repo.ing/')
  assert.equal(websiteUrl('https://my-coin.xyz/about'), 'https://my-coin.xyz/about')
  assert.equal(websiteUrl(''), null)
  for (const bad of ['http://repo.ing', 'localhost', 'https://user:pw@repo.ing', 'javascript:alert(1)', 'https://' + 'a'.repeat(200) + '.com', 'not a site'])
    assert.throws(() => websiteUrl(bad), /website/, bad)
})

test('coinProfileFields returns stored values and explains the first problem in plain words', () => {
  assert.deepEqual(coinProfileFields({ description: '  The cat that ships.  ', x: '@repocat', website: 'repo.ing', telegram: '' }),
    { description: 'The cat that ships.', x: 'repocat', website: 'https://repo.ing/', telegram: null })
  assert.deepEqual(coinProfileFields({}), { description: '', x: null, website: null, telegram: null })
  assert.throws(() => coinProfileFields({ description: 'x'.repeat(COIN_DESCRIPTION_MAX + 1) }), new RegExp(`${COIN_DESCRIPTION_MAX} characters`))
  assert.equal(coinProfileFields({ description: '🐈'.repeat(COIN_DESCRIPTION_MAX) }).description.length, COIN_DESCRIPTION_MAX * 2, 'counts characters, not UTF-16 units')
})

test('links and metadata point at repo.ing-hosted files for the request', () => {
  const id = '6f1c3b0e-3b7a-4c55-9d7e-2d7d1b6a9c10', origin = 'https://repo.ing'
  assert.equal(coinMetadataUri(origin, id), `https://repo.ing/api/hook-lab/coins/${id}/metadata`)
  assert.ok(Buffer.byteLength(coinMetadataUri(origin, id)) <= 200, 'fits the on-chain uri limit')
  assert.equal(coinImageUrl(origin, id, 128), `https://repo.ing/api/hook-lab/coins/${id}/image?w=128`)
  const profile = { description: 'The cat that ships.', x: 'repocat', website: 'https://repo.ing/', telegram: 'repocat' }
  assert.deepEqual(coinLinks(profile), { x: 'https://x.com/repocat', website: 'https://repo.ing/', telegram: 'https://t.me/repocat' })
  assert.deepEqual(coinMetadataJson({ origin, request: { id, name: 'Repo Cat', symbol: 'RCAT' }, profile }), {
    name: 'Repo Cat', symbol: 'RCAT', description: 'The cat that ships.', image: `https://repo.ing/api/hook-lab/coins/${id}/image`,
    external_url: 'https://repo.ing/', website: 'https://repo.ing/', twitter: 'https://x.com/repocat', telegram: 'https://t.me/repocat',
    extensions: { website: 'https://repo.ing/', twitter: 'https://x.com/repocat', telegram: 'https://t.me/repocat' } })
  const bare = coinMetadataJson({ origin, request: { id, name: 'Repo Cat', symbol: 'RCAT' }, profile: { description: '', x: null, website: null, telegram: null } })
  assert.equal(bare.description, '$RCAT launched on repo.ing.')
  assert.deepEqual(bare.extensions, {})
  assert.ok(!('twitter' in bare) && !('external_url' in bare))
})

test('a description is one clean line: no newlines, controls or bidi overrides that could fake rows in the owner terminal', () => {
  assert.equal(coinProfileFields({ description: 'line one\n\n 1. queued LEGIT ‮evil\u0085 end\u0007' }).description, 'line one 1. queued LEGIT evil end')
  assert.equal(coinProfileFields({ description: 'Tabs\tand   spaces' }).description, 'Tabs and spaces')
})
