// The Hooks revenue report (src/hooklab-revenue-report.mjs): per-market ledgers, reconciliation findings, an unsigned
// collection plan, as JSON on stdout. Read only: no key, no signing, no writes.
//   node scripts/hooks-revenue-report.mjs [--rpc-file FILE] [--recording FILE] [--records FILE]
//     --rpc-file   a file holding the RPC URL (never printed); default SOLANA_RPC_URL, else the public mainnet RPC
//     --recording  replay recorded responses instead of the network (tests/fixtures/hooklab-revenue-mainnet.json)
//     --records    a JSON array of our own payment records ({ signature, kind, amount }) to reconcile against the chain
//   exit 1 when any market does not reconcile.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Connection } from '@solana/web3.js'
import { loadHooksMarkets, buildHooksRevenueReport } from '../src/hooklab-revenue-report.mjs'
import { recordedConnection } from '../src/recorded-rpc.mjs'

const TREASURY = 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i'
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com'
const bundle = JSON.parse(readFileSync(new URL('../config/hooklab-stack-bundle.json', import.meta.url), 'utf8'))
const idl = role => JSON.parse(Buffer.from(bundle.profile.idls[role], 'base64'))

async function main() {
  const { values } = parseArgs({ options: { 'rpc-file': { type: 'string' }, recording: { type: 'string' }, records: { type: 'string' } } })
  const recording = values.recording ? JSON.parse(readFileSync(values.recording, 'utf8')) : null
  const connection = recording ? recordedConnection(recording)
    : new Connection(values['rpc-file'] ? readFileSync(values['rpc-file'], 'utf8').trim() : process.env.SOLANA_RPC_URL || PUBLIC_RPC, 'finalized')
  const programs = JSON.parse(bundle.profile.json).programs, idls = { swap: idl('swap'), launch: idl('launch') }
  const markets = await loadHooksMarkets({ connection, programs, idls, treasury: TREASURY })
  const report = buildHooksRevenueReport({ markets, expected: { collector: TREASURY, treasury: TREASURY },
    records: values.records ? JSON.parse(readFileSync(values.records, 'utf8')) : null,
    now: recording ? Date.parse(`${recording.fetchedAt}T23:59:59Z`) : Date.now() })
  console.log(JSON.stringify(report, null, 1))
  if (report.totals.reconciled !== report.totals.markets) process.exitCode = 1
}
main().catch(error => { console.error(`REPORT_FAILED ${String(error?.message ?? error).replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 200)}`); process.exitCode = 1 })
