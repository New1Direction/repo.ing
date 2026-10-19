#!/usr/bin/env node
// Read-only: rewrites an approved production bundle so its quote-mint pin tolerates supply changes (mint-supply-v1).
// The bridged-SOL quote mint's `supply` moves with every wrap and unwrap anyone makes through the public bridge, so an
// exact-bytes pin drifts within seconds and refuses every launch and trade. Nothing else changes: the reviewed snapshot
// must hash to the bundle's existing quote-mint pin, so no new chain observation is trusted.
//
//   node scripts/hooklab-production-bundle-rebind.mjs --bundle config/hooklab-production-bundle.json \
//     --approved-quote-mint tests/fixtures/hooklab-quote-mint-mainnet.b64 --out config/hooklab-production-bundle-2.json
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { productionDossierSchema, quoteMintSupplyBinding } from '../src/hooklab-production-observer.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const die = message => { console.error(message); process.exit(2) }
export function rebindQuoteMint(bundle, approvedQuoteMint) {
  const dossier = JSON.parse(bundle.dossierJson)
  const pin = dossier.accounts.find(a => a.role === 'quote-mint')
  if (!pin) throw Error('bundle has no quote-mint pin')
  if (pin.binding) throw Error(`quote-mint pin already has binding ${pin.binding}`)
  if (sha(approvedQuoteMint) !== pin.dataSha256) throw Error('approved quote-mint bytes do not hash to the reviewed pin')
  if (bundle.config.dossierSha256 !== sha(bundle.dossierJson)) throw Error('bundle dossier differs from its own dossierSha256')
  const next = { ...dossier, accounts: dossier.accounts.map(a => a === pin ? { ...a, ...quoteMintSupplyBinding(approvedQuoteMint) } : a) }
  productionDossierSchema.parse(next)
  const dossierJson = JSON.stringify(next)
  return { ...bundle, config: { ...bundle.config, dossierSha256: sha(dossierJson) }, dossierJson }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: opt } = parseArgs({ options: { bundle: { type: 'string' }, 'approved-quote-mint': { type: 'string' }, out: { type: 'string' } } })
  if (!opt.bundle || !opt['approved-quote-mint'] || !opt.out) die('Required: --bundle FILE --approved-quote-mint BASE64_FILE --out FILE')
  if (existsSync(opt.out)) die(`${opt.out} exists; refusing to overwrite`)
  try {
    const before = readFileSync(opt.bundle)
    const next = rebindQuoteMint(JSON.parse(before), Buffer.from(readFileSync(opt['approved-quote-mint'], 'utf8').trim(), 'base64'))
    const bytes = Buffer.from(JSON.stringify(next))
    writeFileSync(opt.out, bytes, { flag: 'wx', mode: 0o644 })
    console.log(`Rebound ${opt.bundle} (sha256 ${sha(before)}) -> ${opt.out}`)
    console.log('Railway variables for this bundle:')
    console.log(`  HOOKLAB_PRODUCTION_BUNDLE_FILE=${opt.out}`)
    console.log(`  HOOKLAB_PRODUCTION_BUNDLE_SHA256=${sha(bytes)}`)
  } catch (error) { die(`Bundle not written: ${error.message}`) }
}
