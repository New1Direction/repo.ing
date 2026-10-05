import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every module that talks to the GitHub API checks its repository ids with assertGithubRepoId (src/market-identity.mjs),
// so a Hugging Face market id never reaches GitHub, where a 404 could become a decision about the market.
// tests/market-identity-matrix.test.mjs checks that each guard throws before any request.
const GUARDED = ['app/api/repo-logo/[repo]/route.js', 'app/lib/repo-images.mjs', 'app/lib/server.mjs', 'src/dev-pulse.mjs',
  'src/github-app-auth.mjs', 'src/github-release.mjs', 'src/github-verification.mjs', 'src/github.mjs', 'src/repo-lineage.mjs', 'src/trend-sources.mjs',
  'src/verification-bonus-accrual.mjs']

const sources = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? (entry.name === 'node_modules' ? [] : sources(join(dir, entry.name)))
  : /\.(mjs|js|jsx)$/.test(entry.name) ? [join(dir, entry.name)] : [])

test('every module that calls the GitHub API is on the guarded list', () => {
  const callers = ['app', 'src', 'scripts'].flatMap(sources)
    .filter(file => /api\.github\.com|\bgithubApiHeaders\(/.test(readFileSync(file, 'utf8'))).sort()
  assert.deepEqual(callers, GUARDED, 'a module that calls GitHub must call assertGithubRepoId and be listed in GUARDED')
})

test('every guarded module imports and calls assertGithubRepoId', () => {
  for (const file of GUARDED) {
    const source = readFileSync(file, 'utf8')
    assert.match(source, /import \{[^}]*\bassertGithubRepoId\b[^}]*\} from '(?:\.\/|(?:\.\.\/)+src\/)market-identity\.mjs'/, `${file} imports the guard`)
    assert.match(source.replace(/^import .*$/gm, ''), /\bassertGithubRepoId\(/, `${file} calls the guard`)
  }
})
