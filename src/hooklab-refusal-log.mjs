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
