import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// scripts/ops/deploy.sh refuses a bad call before it reads git or Railway (these cases never reach the fetch).
const run = (...args) => spawnSync('bash', ['scripts/ops/deploy.sh', ...args], { encoding: 'utf8', env: { ...process.env, RAILWAY_PROJECT_ID: 'none' } })

test('the deploy script needs the expected commit and known services, web before worker', () => {
  for (const [args, message] of [
    [[], /usage: deploy\.sh <expected short sha> <service>/],
    [['88426c8'], /name at least one service: web, worker/],
    [['88426c8', 'api'], /unknown service: api/],
    [['88426c8', 'worker', 'web'], /name web before worker/],
  ]) {
    const result = run(...args)
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`)
    assert.match(result.stderr, message)
    assert.doesNotMatch(result.stdout, /disk free/, 'refused before any git or Railway step')
  }
})
