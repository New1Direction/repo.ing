import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenMetadataJson } from '../app/lib/token-metadata.mjs'

const mint = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const origin = 'https://repo.ing'

test('metadata names the repository and links the market and GitHub for aggregators', () => {
  const json = tokenMetadataJson({ mint, origin, market: { repoId: '1388219884', name: 'repo.ing', symbol: 'REPOING', hasImage: true, fullName: 'New1Direction/repo.ing' } })
  assert.match(json.description, /github\.com\/New1Direction\/repo\.ing/)
  assert.match(json.description, /does not imply endorsement/)
  assert.equal(json.external_url, `${origin}/token/${mint}`)
  assert.equal(json.website, `${origin}/token/${mint}`)
  assert.equal(json.github, 'https://github.com/New1Direction/repo.ing')
  assert.equal(json.twitter, 'https://x.com/repodoting')
  assert.deepEqual(json.extensions, { website: json.website, github: json.github, twitter: json.twitter })
  assert.equal(json.image, `${origin}/api/token-image/${mint}`)
})

test('metadata without a synced repository keeps the numeric-id description and omits GitHub', () => {
  const json = tokenMetadataJson({ mint, origin, market: { repoId: '42', name: 'x', symbol: 'X', hasImage: false, fullName: null } })
  assert.equal(json.description, 'Token for public GitHub repository 42 on repo.ing.')
  assert.equal(json.github, undefined)
  assert.equal(json.image, `${origin}/api/repo-logo/42?v=3`)
})

test('community tokens for other repositories never carry repo.ing\'s X account', () => {
  const json = tokenMetadataJson({ mint: 'E859MeM9CYWAoQGcNLQYgg8qHPim1EQN4LYqveubrJ6A', origin, market: { repoId: '9', name: 'x', symbol: 'X', hasImage: true, fullName: 'someone/project' } })
  assert.equal(json.twitter, undefined)
  assert.equal(json.extensions.twitter, undefined)
})
