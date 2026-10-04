import { AgentLaunchError } from './agent-launch-draft.mjs'
import { readLimitedBody } from './token-image.mjs'

// POST /api/cli/launch, for `repoing launch` (cli/): the existing signed launch draft (src/agent-launch.mjs) for the repository
// the CLI found. It signs and sends nothing; the launch still needs the browser review and the wallet's approval. The CLI has
// its own rate-limit buckets in agent_request_limits ('cli:' scopes), apart from the MCP's, so neither can use up the other's.
export const CLI_QUOTA = Object.freeze({ prefix: 'cli', globalLimit: 60, clientLimit: 10 })
export const CLI_BODY_LIMIT = 4096
const INPUT_KEYS = new Set(['repository', 'tokenName', 'tokenSymbol', 'initialBuy'])
const NO_STORE = { 'Cache-Control': 'no-store' }

// As the MCP's: the first forwarded address. Not authentication; the global cap bounds callers that rotate it.
export function cliClientId(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

export function validateCliLaunchInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentLaunchError('Invalid launch request.')
  for (const key of Object.keys(value)) if (!INPUT_KEYS.has(key)) throw new AgentLaunchError(`Unsupported field: ${key}.`)
  if (typeof value.repository !== 'string' || value.repository.length < 3 || value.repository.length > 256) {
    throw new AgentLaunchError('Use a public GitHub repository URL or owner/repository.')
  }
  if (value.tokenName !== undefined && (typeof value.tokenName !== 'string' || value.tokenName.trim().length < 1 || value.tokenName.length > 32)) {
    throw new AgentLaunchError('Token name must be 1–32 characters.')
  }
  if (value.tokenSymbol !== undefined && (typeof value.tokenSymbol !== 'string' || !/^[A-Z0-9]{1,10}$/.test(value.tokenSymbol))) {
    throw new AgentLaunchError('Ticker must be 1–10 uppercase letters or numbers.')
  }
  if (value.initialBuy !== undefined && !['none', '100', '200', '300'].includes(value.initialBuy)) {
    throw new AgentLaunchError('Initial buy must be none, 1%, 2%, or 3%.')
  }
  return value
}

async function readJson(request) {
  let body
  try { body = await readLimitedBody(request, CLI_BODY_LIMIT) } catch { throw new AgentLaunchError('The launch request is empty or too large.') }
  return JSON.parse(body.toString('utf8'))
}

// setup: agentLaunchService(request.url) or null when launch reviews are off; quota(client) → whether this request may proceed.
export function createCliLaunchHandler({ setup, quota, log = (...args) => console.warn(...args) }) {
  return async function POST(request) {
    if (!setup) return Response.json({ error: 'Launch reviews are currently unavailable.' }, { status: 503, headers: NO_STORE })
    try {
      if (!await quota(cliClientId(request))) {
        return Response.json({ error: 'Too many requests. Try again in a minute.' }, { status: 429, headers: { 'Retry-After': '60', ...NO_STORE } })
      }
      const body = validateCliLaunchInput(await readJson(request))
      const result = await setup.service.createDraft({ ...body, tokenName: body.tokenName?.trim(), initialBuy: body.initialBuy ?? 'none' })
      return Response.json(result, { headers: NO_STORE })
    } catch (error) {
      if (error instanceof AgentLaunchError || error instanceof SyntaxError) {
        return Response.json({ error: error instanceof SyntaxError ? 'Invalid JSON request.' : error.message }, { status: 400, headers: NO_STORE })
      }
      log('cli_launch_draft_failed', { code: error?.code ?? error?.name ?? 'error' })
      return Response.json({ error: 'Repository service is temporarily unavailable. Try again later.' }, { status: 503, headers: NO_STORE })
    }
  }
}
