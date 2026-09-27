import http from 'node:http'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { createGitHubAppVerifier } from '../src/github-verification.mjs'

const CALLBACK_PATH = '/api/github/callback'

export function createCallbackHandler({ verifier, githubRepoId, expectedState, onResult = () => {} }) {
  let used = false
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    const url = new URL(request.url, 'http://localhost')
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end(JSON.stringify({ error: 'not found' }))
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state || used) {
      response.writeHead(400).end(JSON.stringify({ error: 'invalid or already used callback' }))
      return
    }
    used = true
    try {
      const result = await verifier.verifyCallback({ githubRepoId, expectedGithubRepoId: githubRepoId,
        code, state, expectedState })
      const body = { githubRepoId: result.githubRepoId.toString(), githubUserId: result.githubUserId.toString(),
        githubLogin: result.githubLogin, permission: result.permission, adminAccepted: result.verified }
      response.writeHead(200).end(JSON.stringify(body))
      onResult(body)
    } catch (error) {
      const safe = /^(GitHub|Repository|Current public GitHub)/.test(error.message) ? error.message : 'verification failed'
      response.writeHead(400).end(JSON.stringify({ error: safe }))
      onResult({ error: safe })
    }
  }
}

async function main() {
  const { GITHUB_APP_CLIENT_ID: clientId, GITHUB_APP_CLIENT_SECRET: clientSecret,
    GITHUB_TEST_REPO_ID: repoId, DATABASE_URL: databaseUrl } = process.env
  const port = Number(process.env.GITHUB_CALLBACK_PORT ?? '3001')
  if (!clientId || !clientSecret || !repoId || !databaseUrl || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_TEST_REPO_ID, DATABASE_URL, and a valid callback port are required')
  }
  const githubRepoId = BigInt(repoId)
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const verifier = createGitHubAppVerifier({ pool, clientId, clientSecret, redirectUri })
  const authorization = verifier.authorizationUrl({ githubRepoId })
  const server = http.createServer(createCallbackHandler({ verifier, githubRepoId,
    expectedState: authorization.state, onResult: result => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      server.close()
      void pool.end()
    } }))
  server.on('error', error => {
    process.stderr.write(error.code === 'EADDRINUSE' ? `Callback port ${port} is already in use\n` : 'Callback server failed\n')
    void pool.end()
  })
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`GitHub App authorization URL for repository ID ${githubRepoId}:\n${authorization.url}\n`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('GitHub callback setup failed\n'); process.exitCode = 1 })
}
