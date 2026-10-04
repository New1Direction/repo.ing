const GITHUB_HOST = 'github.com'
export const DEFAULT_ORIGIN = 'https://repo.ing'
export const VERSION = '0.1.0'

function cleanRepoPath(pathname) {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part) || /^\.+$/.test(part))) {
    throw new Error('Use a GitHub repository like owner/repo or https://github.com/owner/repo.')
  }
  const repo = parts[1].replace(/\.git$/i, '')
  if (!repo || /^\.+$/.test(repo)) throw new Error('Invalid GitHub repository name.')
  return `${parts[0]}/${repo}`
}

export function normalizeGithubRepository(input) {
  const value = String(input ?? '').trim()
  if (!value) throw new Error('No repository supplied.')

  if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(value)) {
    return `https://${GITHUB_HOST}/${cleanRepoPath(value)}`
  }

  const scp = value.match(/^git@github\.com:([^?#]+)$/i)
  if (scp) return `https://${GITHUB_HOST}/${cleanRepoPath(scp[1])}`

  let url
  try { url = new URL(value) } catch {
    throw new Error('Use a GitHub repository like owner/repo or https://github.com/owner/repo.')
  }

  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname.toLowerCase() !== GITHUB_HOST ||
      url.port || url.search || url.hash) {
    throw new Error('Only GitHub repository remotes are supported.')
  }
  return `https://${GITHUB_HOST}/${cleanRepoPath(url.pathname)}`
}

export function normalizeInitialBuy(value = 'none') {
  const normalized = String(value).trim().toLowerCase().replace('%', '')
  if (normalized === 'none' || normalized === '0') return 'none'
  if (normalized === '1' || normalized === '100') return '100'
  if (normalized === '2' || normalized === '200') return '200'
  if (normalized === '3' || normalized === '300') return '300'
  throw new Error('Initial buy must be none, 0, 1, 2, or 3%.')
}

export function parseArgs(argv) {
  const args = [...argv]
  if (!args.length) return { command: 'help' }
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') return { command: 'help' }
  if (args[0] === '--version' || args[0] === '-v') return { command: 'version' }
  const command = args.shift()
  if (command !== 'launch') throw new Error(`Unknown command: ${command}`)

  const out = {
    command,
    repository: null,
    tokenName: undefined,
    tokenSymbol: undefined,
    initialBuy: 'none',
    open: true,
    json: false,
    origin: process.env.REPOING_ORIGIN || DEFAULT_ORIGIN,
  }

  while (args.length) {
    const arg = args.shift()
    if (!arg.startsWith('-') && !out.repository) {
      out.repository = arg
      continue
    }
    if (arg === '--name') out.tokenName = requiredValue(args, arg)
    else if (arg === '--symbol' || arg === '-s') out.tokenSymbol = requiredValue(args, arg).toUpperCase()
    else if (arg === '--buy') out.initialBuy = normalizeInitialBuy(requiredValue(args, arg))
    else if (arg === '--no-open') out.open = false
    else if (arg === '--json') { out.json = true; out.open = false }
    else if (arg === '--origin') out.origin = requiredValue(args, arg)
    else if (arg === '--help' || arg === '-h') return { command: 'help' }
    else throw new Error(`Unknown option: ${arg}`)
  }

  if (out.tokenName !== undefined && (out.tokenName.trim().length < 1 || out.tokenName.length > 32)) {
    throw new Error('Token name must be 1–32 characters.')
  }
  if (out.tokenSymbol !== undefined && !/^[A-Z0-9]{1,10}$/.test(out.tokenSymbol)) {
    throw new Error('Ticker must be 1–10 letters or numbers.')
  }
  validateOrigin(out.origin)
  return out
}

function requiredValue(args, option) {
  const value = args.shift()
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`)
  return value
}

export function validateOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid repo.ing origin.') }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if ((!local && url.protocol !== 'https:') || (local && !['http:', 'https:'].includes(url.protocol)) || url.username || url.password) {
    throw new Error('repo.ing origin must use HTTPS (HTTP is allowed only for localhost).')
  }
  return url.origin
}

export async function requestLaunchDraft({ origin, repository, tokenName, tokenSymbol, initialBuy, fetchImpl = fetch }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetchImpl(`${validateOrigin(origin)}/api/cli/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `repoing-cli/${VERSION}` },
      body: JSON.stringify({
        repository,
        ...(tokenName ? { tokenName } : {}),
        ...(tokenSymbol ? { tokenSymbol } : {}),
        initialBuy: initialBuy ?? 'none',
      }),
      signal: controller.signal,
    })
    let body
    try { body = await response.json() } catch { body = null }
    if (!response.ok) throw new Error(body?.error || `repo.ing returned HTTP ${response.status}.`)
    if (!body || typeof body !== 'object') throw new Error('repo.ing returned an invalid response.')
    return body
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('repo.ing did not respond in time.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export const HELP = `repoing — launch an open-source market from your terminal

Usage:
  repoing launch [owner/repo|github-url] [options]

If no repository is supplied, repoing reads the current git origin.

Options:
  --name <name>       Token name (1–32 chars)
  -s, --symbol <sym>  Ticker (1–10 letters/numbers)
  --buy <0|1|2|3>     Optional initial buy percentage; default 0
  --no-open           Print the review URL without opening a browser
  --json              Machine-readable output; implies --no-open
  --origin <url>      Override repo.ing origin (dev/testing)
  -h, --help          Show help
  -v, --version       Show version

Nothing is launched until you review current costs and approve in your wallet.`
