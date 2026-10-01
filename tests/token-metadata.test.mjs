import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenMetadataJson } from '../app/lib/token-metadata.mjs'

const mint = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const origin = 'https://repo.ing'

test('repo.ing\'s own token gets the official description, the home page and repo.ing\'s X account', () => {
  const json = tokenMetadataJson({ mint, origin, market: { repoId: '1388219884', name: 'repo.ing', symbol: 'REPOING', hasImage: true, fullName: 'New1Direction/repo.ing' } })
  assert.equal(json.description, 'The official token of repo.ing, the market layer for open source. Every trade pays builders, and 60% of platform fees buy back $REPOING.')
  assert.doesNotMatch(json.description, /does not imply endorsement/)
  assert.equal(json.external_url, origin)
  assert.equal(json.website, origin)
  assert.equal(json.github, 'https://github.com/New1Direction/repo.ing')
  assert.equal(json.twitter, 'https://x.com/repodoting')
  assert.deepEqual(json.extensions, { website: json.website, github: json.github, twitter: json.twitter })
  assert.equal(json.image, `${origin}/api/token-image/${mint}`)
})

test('metadata without a synced repository keeps the numeric-id description and omits GitHub', () => {
  const json = tokenMetadataJson({ mint: 'E859MeM9CYWAoQGcNLQYgg8qHPim1EQN4LYqveubrJ6A', origin, market: { repoId: '42', name: 'x', symbol: 'X', hasImage: false, fullName: null } })
  assert.equal(json.description, 'Token for public GitHub repository 42 on repo.ing.')
  assert.equal(json.github, undefined)
  assert.equal(json.image, `${origin}/api/repo-logo/42?v=3`)
})

test('community tokens for other repositories never carry repo.ing\'s X account', () => {
  const json = tokenMetadataJson({ mint: 'E859MeM9CYWAoQGcNLQYgg8qHPim1EQN4LYqveubrJ6A', origin, market: { repoId: '9', name: 'x', symbol: 'X', hasImage: true, fullName: 'someone/project' } })
  assert.equal(json.twitter, undefined)
  assert.equal(json.extensions.twitter, undefined)
})

test('community tokens name their repository, keep the disclaimer and link their market page', () => {
  const other = 'E859MeM9CYWAoQGcNLQYgg8qHPim1EQN4LYqveubrJ6A'
  const json = tokenMetadataJson({ mint: other, origin, market: { repoId: '9', name: 'x', symbol: 'X', hasImage: true, fullName: 'someone/project' } })
  assert.match(json.description, /^\$X is the repo\.ing market for github\.com\/someone\/project\./)
  assert.match(json.description, /does not imply endorsement/)
  assert.equal(json.external_url, `${origin}/token/${other}`)
  assert.equal(json.website, `${origin}/token/${other}`)
})
