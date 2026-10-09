import { chain, creatorSigner, database } from '../app/lib/server.mjs'
import { cancelBundleRaise } from '../src/bundle-cancel.mjs'

// Cancels one Bundle raise (src/bundle-cancel.mjs): for a raise that should not hold its repository, one opened only to block
// it or one the maintainer opted out of. Backers then take their SOL back, and the worker frees the repository on its next pass.
// DRY RUN BY DEFAULT: reads the bundle and simulates the signed cancel; --execute sends it. Runs on the web service, where the
// Bundle admin (the creator signer) is set:
//
//   railway ssh --project … --environment production --service web -- node scripts/cancel-bundle.mjs <bundle id> [--execute]
const [id, ...rest] = process.argv.slice(2)
if (!id || rest.some(arg => arg !== '--execute')) {
  console.error('Usage: node scripts/cancel-bundle.mjs <bundle id> [--execute]')
  process.exit(2)
}
const pool = database()
try {
  const result = await cancelBundleRaise({ connection: chain(), admin: creatorSigner(), pool, id, execute: rest.includes('--execute') })
  console.log(JSON.stringify(result.signature ? { ...result, signature: `https://solscan.io/tx/${result.signature}` } : result, null, 2))
  if (result.cancellable === false || result.cancelled === false) process.exitCode = 1
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await pool?.end()
}
