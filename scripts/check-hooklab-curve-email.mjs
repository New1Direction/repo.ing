import { resolve } from 'node:path'
import { createCurveEmailSender, runCurveEmailDrill } from '../src/hooklab-curve-email.mjs'

const args = process.argv.slice(2)
try {
  if (!args.length) {
    console.log(JSON.stringify({ configured: Boolean(createCurveEmailSender()), sendsEmail: false, canSubmit: false }))
  } else {
    if (args.length !== 2 || args[0] !== '--send') throw Error('Usage: node scripts/check-hooklab-curve-email.mjs [--send UUID]')
    const result = await runCurveEmailDrill({ id: args[1], directory: resolve('.amp/hooklab-curve-email-drills') })
    console.log(JSON.stringify(result))
    if (result.status !== 'sent') process.exitCode = 1
  }
} catch {
  // Do not print provider exceptions, addresses, credentials or filesystem contents.
  console.error('Drill refused or unresolved. Check private configuration and retained drill record; do not resend an existing claim.')
  process.exitCode = 1
}
