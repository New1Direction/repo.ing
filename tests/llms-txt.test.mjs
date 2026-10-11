import test from 'node:test'
import assert from 'node:assert/strict'
import { llmsText } from '../app/llms.txt/route.js'

test('llms.txt names Hugging Face models and Group launch only while their switches are on', () => {
  const off = llmsText(null)
  assert.match(off, /repo\.ing turns public GitHub repositories into Solana token markets\./)
  assert.doesNotMatch(off, /Hugging Face|Group launch|resolve_model/)
  const on = llmsText(null, { models: true, groups: true })
  assert.match(on, /repositories and Hugging Face models into Solana token markets\./)
  assert.match(on, /^- Hugging Face models: /m)
  assert.match(on, /^- Group launch: /m)
  assert.match(on, /^- resolve_model, create_model_launch_draft, get_model_launch_status: /m)
  assert.ok(on.indexOf('- resolve_model') < on.indexOf('- get_launch_status'))
})

test('llms.txt states the discovery, fork and referral rules and the read-only MCP server', () => {
  const text = llmsText(null)
  assert.match(text, /Stock pairs carry no discovery reward\./)
  assert.match(llmsText(null, { groups: true }), /Group launches and stock pairs carry no discovery reward\./)
  assert.match(text, /^- One market per project: /m)
  assert.match(text, /^- Referrals: .*SOL-paired markets pay you 4%/m)
  assert.match(text, /https:\/\/repo\.ing\/api\/mcp\/readonly/)
})
