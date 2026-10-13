#!/usr/bin/env node
// Maintainer fee-recovery campaign pre-flight (docs/outreach/fee-recovery-2026-10/README.md). Read-only: it sends nothing,
// writes nothing and records no funnel event (it never opens /builders?owner=, and a plain GET runs no page beacon).
//
//   node scripts/ops/fee-recovery-check.mjs [--render] [--origin https://repo.ing]
//
// 1. Deployment gate: production serves the claim funnel (GET /api/funnel answers 405, not 404, and a target's claim page
//    carries the claim_view beacon). Exit 2 when it does not: no outreach until the funnel is deployed.
// 2. Each target's next claim from its claim page's on-chain check (/api/claim/<id>/preview) against the operator invite
//    threshold (MAINTAINER_INVITE_MIN_SOL, default 0.5 SOL, src/maintainer-invites.mjs). Below it the target is HOLD.
// 3. --render prints each READY target's drafts with {{available_sol}}, {{checked_at}} and the attributed {{claim_url}}
//    (?src= from the draft's channel, app/lib/claim-funnel.mjs) filled in. Anything else in {{…}} is filled by hand.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { funnelSource, withFunnelSource } from '../../app/lib/claim-funnel.mjs'
import { formatSolDisplay } from '../../app/lib/format.mjs'
import { inviteThreshold } from '../../src/maintainer-invites.mjs'

const args = process.argv.slice(2)
const origin = (args.includes('--origin') ? args[args.indexOf('--origin') + 1] : 'https://repo.ing').replace(/\/$/, '')
const render = args.includes('--render')
const campaign = join(dirname(fileURLToPath(import.meta.url)), '../../docs/outreach/fee-recovery-2026-10')
const { targets } = JSON.parse(await readFile(join(campaign, 'targets.json'), 'utf8'))
const threshold = inviteThreshold()

const get = async path => {
  const response = await fetch(`${origin}${path}`, { redirect: 'manual', headers: { 'user-agent': 'repoing-fee-recovery-check' } })
  return { status: response.status, text: await response.text() }
}

const funnel = await get('/api/funnel')
const claimPage = await get(`/claim/${targets[0].repoId}`)
const deployed = funnel.status === 405 && claimPage.status === 200 && claimPage.text.includes('claim_view')
console.log(`deployment gate: ${deployed ? 'PASS' : 'FAIL'} (GET /api/funnel ${funnel.status}, claim page ${claimPage.status}${claimPage.text.includes('claim_view') ? ', beacon present' : ', no beacon'})`)
if (!deployed) {
  console.log('Production does not serve the claim funnel yet. Do not contact anyone; deploy it first (docs/CLAIM_FUNNEL.md, "Deploying").')
  process.exit(2)
}

const checkedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
console.log(`threshold: ${formatSolDisplay(threshold)} SOL · checked ${checkedAt}\n`)
for (const target of targets) {
  let available = null, note = ''
  try {
    const { status, text } = await get(`/api/claim/${target.repoId}/preview`)
    const body = JSON.parse(text)
    if (status === 200 && typeof body.available === 'string' && /^\d+$/.test(body.available)) available = BigInt(body.available)
    else note = body.error ?? `HTTP ${status}`
  } catch (error) { note = error.message }
  const state = available === null ? 'CHECK' : available >= threshold ? 'READY' : 'HOLD'
  console.log(`${state.padEnd(5)} ${target.fullName} (${target.repoId}) ${available === null ? note : `${formatSolDisplay(available)} SOL`}`)
  for (const message of target.messages) {
    const source = funnelSource(message.source)
    if (!source) throw Error(`${target.fullName}: ${message.source} is not a claim funnel source`)
    const claimUrl = withFunnelSource(`${origin}/claim/${encodeURIComponent(target.repoId)}`, source)
    console.log(`      ${message.channel} (${message.when}): ${claimUrl}`)
    if (!render || state !== 'READY') continue
    const text = (await readFile(join(campaign, message.template), 'utf8'))
      .replaceAll('{{available_sol}}', formatSolDisplay(available)).replaceAll('{{checked_at}}', checkedAt).replaceAll('{{claim_url}}', claimUrl)
    const manual = [...new Set(text.match(/\{\{[a-z_]+\}\}/g) ?? [])]
    console.log(`\n----- ${message.template}${manual.length ? ` (fill by hand: ${manual.join(', ')})` : ''}\n${text.trim()}\n-----\n`)
  }
}
