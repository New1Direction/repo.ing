#!/usr/bin/env node
// Read-only native-SOL upgrade preflight (src/hooklab-native-preflight.mjs). Run it before the swap and launch programs
// are upgraded to the reviewed native builds: it exits 0 only when no Pool or Launch carries a native flag and the launch
// Config's reserved bytes 186..249 are all zero. Two independent providers, finalized reads, same genesis checks as the
// owner driver; never signs or sends.
//
//   node scripts/hooklab-native-preflight.mjs --rpc "$HELIUS_URL" --rpc2 https://solana-rpc.publicnode.com
//   node scripts/hooklab-native-preflight.mjs --rpc http://127.0.0.1:8899 --rpc2 http://localhost:8899 --local-test
import { parseArgs } from 'node:util'
import { makeReaders, verifyGenesis } from '../src/hooklab-owner-driver/rpc.mjs'
import { scanNativePreflight } from '../src/hooklab-native-preflight.mjs'

const { values: opt } = parseArgs({ options: { rpc: { type: 'string' }, rpc2: { type: 'string' }, 'local-test': { type: 'boolean', default: false } } })
try {
  const readers = makeReaders({ rpc: opt.rpc, rpc2: opt.rpc2, localTest: opt['local-test'] }), genesisHash = await verifyGenesis(readers, { localTest: opt['local-test'] })
  const report = { ...await scanNativePreflight(readers), genesisHash }
  console.log(JSON.stringify(report, null, 2))
  console.error(report.ok ? 'PREFLIGHT OK: no native flag is set; the upgrade may proceed.' : `PREFLIGHT REFUSED: ${report.reasons.join('; ')}`)
  process.exit(report.ok ? 0 : 1)
} catch (error) {
  // RPC errors can carry the provider URL and its API key.
  console.error(`Preflight could not run: ${String(error.message).replace(/https?:\/\/\S+/g, '<rpc>')}`)
  process.exit(2)
}
