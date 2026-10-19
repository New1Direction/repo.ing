// Health check run by the stack before the website starts, with the website's exact environment: the PRODUCTION
// bootstrap (src/hooklab-production-bootstrap.mjs) loads the local bundle and installs the launch, trade and claim
// runtimes, and this prints what it installed or the full error (instrumentation.js only logs a one-line refusal).
import { bootstrapProductionHooks } from '../../../src/hooklab-production-bootstrap.mjs'

try {
  const result = await bootstrapProductionHooks()
  console.log(`BOOTSTRAP_OK ${JSON.stringify(result)}`)
  process.exit(result?.nativeTrading === true ? 0 : 3)
} catch (error) {
  console.error(`BOOTSTRAP_FAILED ${error?.code ?? ''} ${error?.stack ?? error}${error?.cause ? `\ncause: ${error.cause.code ?? ''} ${error.cause.stack ?? error.cause}` : ''}`)
  process.exit(1)
}
