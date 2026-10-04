import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeGithubRepository,
  normalizeInitialBuy,
  parseArgs,
  requestLaunchDraft,
} from '../src/core.mjs'

test('normalizes common GitHub remotes', () => {
  const expected = 'https://github.com/openai/openai'
  assert.equal(normalizeGithubRepository('openai/openai'), expected)
  assert.equal(normalizeGithubRepository('https://github.com/openai/openai.git'), expected)
  assert.equal(normalizeGithubRepository('git@github.com:openai/openai.git'), expected)
  assert.equal(normalizeGithubRepository('ssh://git@github.com/openai/openai.git'), expected)
})

test('rejects non-repository and non-GitHub remotes', () => {
  assert.throws(() => normalizeGithubRepository('https://gitlab.com/openai/openai'))
  assert.throws(() => normalizeGithubRepository('https://github.com/openai/openai/issues'))
  assert.throws(() => normalizeGithubRepository('https://github.com/openai/openai?tab=readme'))
})

test('normalizes launch buy presets', () => {
  assert.equal(normalizeInitialBuy('none'), 'none')
  assert.equal(normalizeInitialBuy('0%'), 'none')
  assert.equal(normalizeInitialBuy('1%'), '100')
  assert.equal(normalizeInitialBuy('2'), '200')
  assert.equal(normalizeInitialBuy('300'), '300')
  assert.throws(() => normalizeInitialBuy('4'))
})

test('parses launch command without silently enabling a buy', () => {
  const parsed = parseArgs(['launch', 'openai/openai', '--symbol', 'repo', '--no-open'])
  assert.equal(parsed.repository, 'openai/openai')
  assert.equal(parsed.tokenSymbol, 'REPO')
  assert.equal(parsed.initialBuy, 'none')
  assert.equal(parsed.open, false)
})

test('posts only launch preferences to the CLI endpoint', async () => {
  let request
  const fetchImpl = async (url, init) => {
    request = { url, init }
    return new Response(JSON.stringify({
      repoId: '1296269',
      draftCreated: true,
      reviewUrl: 'https://repo.ing/launch/1296269?draft=x',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const result = await requestLaunchDraft({
    origin: 'https://repo.ing',
    repository: 'https://github.com/openai/openai',
    tokenSymbol: 'OPENAI',
    initialBuy: 'none',
    fetchImpl,
  })
  assert.equal(result.repoId, '1296269')
  assert.equal(request.url, 'https://repo.ing/api/cli/launch')
  assert.deepEqual(JSON.parse(request.init.body), {
    repository: 'https://github.com/openai/openai',
    tokenSymbol: 'OPENAI',
    initialBuy: 'none',
  })
})
