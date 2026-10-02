import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createAgentMcpHandler } from '../src/agent-launch-http.mjs'
import { AgentLaunchError } from '../src/agent-launch-draft.mjs'
import { HF_DISCLAIMER } from '../src/hf-copy.mjs'

// The repository tools every agent sees are frozen: tests/fixtures/mcp-repository-tools.json was listed from main before
// Hugging Face model markets. The model tools appear only when the service carries them (HF_MARKETS_ENABLED), next to
// unchanged repository tools.
const frozen = JSON.parse(readFileSync(new URL('./fixtures/mcp-repository-tools.json', import.meta.url), 'utf8'))
const repositoryService = { findRepos: async () => ({ candidates: [] }), resolveRepo: async () => ({ repoId: '123' }),
  createDraft: async () => ({ state: 'awaiting_browser_review', live: false }), getStatus: async () => ({ state: 'not_launched', live: false }) }

async function connect(service) {
  const handler = createAgentMcpHandler({ service, origin: 'https://repo.ing', quota: async () => true })
  const client = new Client({ name: 'repoing-schema-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('https://repo.ing/api/mcp'), { fetch: async (url, init) => {
    const request = new Request(url, init); request.headers.set('host', 'repo.ing'); return handler(request)
  } }))
  return client
}

test('with model markets off, the MCP server lists exactly the frozen repository tools', async () => {
  const client = await connect(repositoryService)
  try {
    assert.deepEqual((await client.listTools()).tools, frozen.tools)
    assert.equal(client.getInstructions(), frozen.instructions)
  } finally { await client.close() }
})

test('with model markets on, the repository tools are unchanged and the three model tools are added', async () => {
  const calls = []
  const service = { ...repositoryService,
    resolveModel: async input => { calls.push(['resolve', input]); return { marketId: '4503599627370497', live: false } },
    createModelDraft: async input => { calls.push(['draft', input]); return { state: 'awaiting_browser_review', draftCreated: true, live: false } },
    getModelStatus: async input => { calls.push(['status', input]); if (input.marketId === '4503599627370498') throw new AgentLaunchError('Use the marketId that resolve_model returned.'); return { state: 'not_launched', live: false } } }
  const client = await connect(service)
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.filter(tool => frozen.tools.some(f => f.name === tool.name)), frozen.tools)
    assert.deepEqual(tools.map(tool => tool.name), [...frozen.tools.map(tool => tool.name), 'resolve_model', 'create_model_launch_draft', 'get_model_launch_status'])
    assert.equal(client.getInstructions(), frozen.instructions)
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
    for (const name of ['resolve_model', 'create_model_launch_draft']) assert.ok(byName[name].description.includes(HF_DISCLAIMER), name)
    assert.deepEqual(byName.resolve_model.inputSchema.required, ['model'])
    assert.equal(byName.resolve_model.inputSchema.properties.model.maxLength, 2048)
    assert.equal(byName.resolve_model.annotations.readOnlyHint, false)
    assert.deepEqual(byName.create_model_launch_draft.inputSchema.properties.initialBuy.enum.sort(), ['100', '200', '300', 'none'])
    assert.equal(byName.create_model_launch_draft.inputSchema.additionalProperties, false)
    assert.equal(byName.get_model_launch_status.inputSchema.properties.marketId.pattern, '^[1-9]\\d{15}$')
    assert.equal(byName.get_model_launch_status.annotations.readOnlyHint, true)

    assert.equal((await client.callTool({ name: 'resolve_model', arguments: { model: 'huggingface.co/openai-community/gpt2' } })).structuredContent.marketId, '4503599627370497')
    assert.equal((await client.callTool({ name: 'create_model_launch_draft', arguments: { model: 'openai-community/gpt2' } })).structuredContent.draftCreated, true)
    assert.deepEqual(calls.at(-1), ['draft', { model: 'openai-community/gpt2', initialBuy: 'none' }])
    // A repository id, an extra field and a private key never reach the service.
    for (const [name, args] of [['get_model_launch_status', { marketId: '1296269' }], ['create_model_launch_draft', { model: 'a/b', privateKey: 'x' }],
      ['create_model_launch_draft', { model: 'a/b', tokenSymbol: 'lower' }], ['resolve_model', { model: 'a' }]]) {
      assert.equal((await client.callTool({ name, arguments: args })).isError, true, `${name} ${JSON.stringify(args)}`)
    }
    const refused = await client.callTool({ name: 'get_model_launch_status', arguments: { marketId: '4503599627370498' } })
    assert.equal(refused.isError, true)
    assert.equal(refused.content[0].text, 'Use the marketId that resolve_model returned.')
    assert.equal(calls.length, 3)
  } finally { await client.close() }
})
