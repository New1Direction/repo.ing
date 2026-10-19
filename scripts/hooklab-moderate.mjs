#!/usr/bin/env node
// Owner moderation of Hooks coins launched through the site. Nothing on chain changes: a delisted coin leaves discovery,
// its page shows the reason, and the site stops offering BUY; selling and the creator's fee claim keep working.
//
//   node scripts/hooklab-moderate.mjs reasons
//   export HOOK_OWNER_APPROVAL_TOKEN="$(security find-generic-password -s repoing-owner-agent -w)"
//   node scripts/hooklab-moderate.mjs delist <mint> --reason <code> [--origin https://repo.ing]        (preview)
//   node scripts/hooklab-moderate.mjs delist <mint> --reason <code> --yes                              (sends)
//   node scripts/hooklab-moderate.mjs relist <mint> [--yes]
import { parseArgs } from 'node:util'
import { DELISTING_REASONS, isDelistingReason, delistedNotice } from '../src/hooklab-coin-moderation.mjs'

const die = message => { console.error(message); process.exit(2) }
const { values: opt, positionals: [command, mint] } = parseArgs({ allowPositionals: true,
  options: { reason: { type: 'string' }, yes: { type: 'boolean', default: false }, origin: { type: 'string', default: 'https://repo.ing' } } })
if (command === 'reasons') { for (const [code, text] of Object.entries(DELISTING_REASONS)) console.log(`${code}\n  ${text}`); process.exit(0) }
if (!['delist', 'relist'].includes(command) || !mint) die('Usage: reasons | delist <mint> --reason <code> [--yes] | relist <mint> [--yes]')
if (command === 'delist' && !isDelistingReason(opt.reason)) die(`Choose a reason: ${Object.keys(DELISTING_REASONS).join(', ')} (run "reasons" to read them)`)
console.log(command === 'delist' ? `DELIST ${mint}\n  the coin page will say: ${delistedNotice(opt.reason)}\n  it leaves discovery and BUY is turned off; SELL and the creator's CLAIM keep working`
  : `RELIST ${mint}\n  it returns to discovery and BUY is offered again`)
if (!opt.yes) { console.log('Preview only: add --yes to send.'); process.exit(0) }
const token = process.env.HOOK_OWNER_APPROVAL_TOKEN
if (!token || token.length < 32) die('Set HOOK_OWNER_APPROVAL_TOKEN (from your Keychain) first.')
const response = await fetch(new URL('/api/hook-lab/coin-moderation', opt.origin), { method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(command === 'delist' ? { action: 'delist', mint, reason: opt.reason } : { action: 'relist', mint }) })
const body = await response.json().catch(() => ({}))
if (!response.ok) die(`Refused: ${body.error ?? `HTTP ${response.status}`}`)
console.log(`Done: ${JSON.stringify(body.moderation)}`)
