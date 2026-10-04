import { agentLaunchService } from '../../../lib/agent-launch.mjs'
import { takeAgentQuota } from '../../../../src/agent-launch-http.mjs'
import { AgentLaunchError } from '../../../../src/agent-launch-draft.mjs'
import { readLimitedBody } from '../../../../src/token-image.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INPUT_KEYS = new Set(['repository', 'tokenName', 'tokenSymbol', 'initialBuy'])

function clientId(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

function validateInput(value) {
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

export async function POST(request) {
  const setup = agentLaunchService(request.url)
  if (!setup) {
    return Response.json({ error: 'Launch reviews are currently unavailable.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  try {
    if (!await takeAgentQuota(setup.pool, clientId(request), setup.secret)) {
      return Response.json({ error: 'Too many requests. Try again in a minute.' }, {
        status: 429,
        headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
      })
    }

    const body = validateInput(JSON.parse((await readLimitedBody(request, 4096)).toString('utf8')))
    const result = await setup.service.createDraft({
      ...body,
      tokenName: body.tokenName?.trim(),
      initialBuy: body.initialBuy ?? 'none',
    })
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof AgentLaunchError || error instanceof SyntaxError) {
      return Response.json({ error: error instanceof SyntaxError ? 'Invalid JSON request.' : error.message }, {
        status: 400,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    console.warn('cli_launch_draft_failed', { code: error?.code ?? error?.name ?? 'error' })
    return Response.json({ error: 'Repository service is temporarily unavailable. Try again later.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}

export function GET() {
  return new Response('Use POST.', { status: 405, headers: { Allow: 'POST' } })
}
