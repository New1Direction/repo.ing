#!/usr/bin/env node
// Read-only operator tool. Deliberately has no key loading, funding or send option.
import { readFile } from 'node:fs/promises'
import { Connection } from '@solana/web3.js'
import { inspectFreshPlain, verifyFreshHltestPreview, simulateFreshHltest, recoverFreshHltest } from '../src/hooklab-fresh-plain.mjs'

const [mode, confirmation, previewFile, evidenceOrSignature, ...extra] = process.argv.slice(2)
if (confirmation !== '--confirm-devnet' || extra.length || !['inspect', 'verify', 'simulate', 'recover'].includes(mode)
  || (mode !== 'inspect' && !previewFile) || (['simulate', 'recover'].includes(mode) && !evidenceOrSignature)
  || (['inspect', 'verify'].includes(mode) && evidenceOrSignature)) {
  console.error('Usage: node scripts/inspect-hooklab-fresh.mjs inspect --confirm-devnet [deployment.json]\n'
    + '       node scripts/inspect-hooklab-fresh.mjs verify --confirm-devnet preview.json\n'
    + '       node scripts/inspect-hooklab-fresh.mjs simulate --confirm-devnet preview.json deployment.json\n'
    + '       node scripts/inspect-hooklab-fresh.mjs recover --confirm-devnet preview.json SIGNATURE')
  process.exit(2)
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
try {
  const options = { confirmedNetwork: 'devnet' }
  let result
  if (mode === 'verify') {
    const { message, ...publicResult } = verifyFreshHltestPreview(await readJson(previewFile), options)
    result = publicResult
  } else {
    const file = mode === 'inspect' ? previewFile : mode === 'simulate' ? evidenceOrSignature : null
    if (file) options.deployment = await readJson(file)
    const connection = new Connection(process.env.DIRECT_COINS_DEVNET_RPC_URL || 'https://api.devnet.solana.com', {
      commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20000) }),
    })
    result = mode === 'inspect' ? await inspectFreshPlain(connection, options)
      : mode === 'simulate' ? await simulateFreshHltest(connection, await readJson(previewFile), options)
      : await recoverFreshHltest(connection, await readJson(previewFile), evidenceOrSignature, options)
  }
  console.log(JSON.stringify(result, null, 2))
  if (result.refusals?.length || ['unresolved', 'simulation-failed'].includes(result.status)) process.exitCode = 1
} catch {
  // Do not print arbitrary RPC URLs or input contents, which might contain secrets.
  console.error('Fresh plain verification refused. Check public package inputs, deployment evidence and RPC availability. Nothing signed or sent.')
  process.exitCode = 1
}
