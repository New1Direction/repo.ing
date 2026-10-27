// One log line for a Hooks request the server refused behind a generic reply: the error code and a short message,
// with URL credentials, API keys and database URLs removed, plus the top function names. The customer still sees only
// the fixed text.
const SECRETS = [/api-key=[^\s&"']+/gi, /[a-z]+:\/\/[^\s/@]+@[^\s"']+/gi]

export function refusalLine(route, error) {
  let message = String(error?.message ?? '-').split('\n')[0]
  for (const pattern of SECRETS) message = message.replace(pattern, '<redacted>')
  // Function names only (blank check() errors say nothing else): never file paths or values.
  const where = String(error?.stack ?? '').split('\n').slice(1, 4).map(frame => frame.trim().match(/^at ([\w$.<>]+) /)?.[1]).filter(Boolean).join(' < ')
  return `Hook Lab refused ${route}: ${error?.code ?? '-'} ${message}${where ? ` [${where}]` : ''}`.slice(0, 400)
}

// One timing line per signing call: where its time went (revalidation = the chain evidence re-read, database, custody
// signing, send) and the total, in whole milliseconds. Values only; never keys, URLs or signatures.
export function timingLine(route, phases) {
  const ms = value => `${Math.max(0, Math.round(value ?? 0))}ms`
  return `Hook Lab timing ${route}: revalidate ${ms(phases.revalidate)} db ${ms(phases.db)} sign ${ms(phases.sign)} send ${ms(phases.send)} total ${ms(phases.total)}`
}
