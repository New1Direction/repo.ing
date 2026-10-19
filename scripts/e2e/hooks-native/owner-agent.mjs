// The REAL owner agent (scripts/hooklab-owner-agent.mjs) in --local-acceptance mode: the disposable admin key FILE
// from the stack's temporary root, the local genesis pinned, both loopback proxies, its ledgers in the temporary root,
// and HOME pointed there too. The owner approves exactly as in production, by typing `invite N` into the agent.
import path from 'node:path'
import { REPO_ROOT, waitFor } from './common.mjs'
import { startProcess } from './process.mjs'

export async function startOwnerAgent({ root, base, tls, preload, solUsd, origin, proxies, genesisHash, adminKeyFile, token, https, log }) {
  const home = path.join(root, 'owner-home'), stateDir = path.join(root, 'owner-agent')
  const env = { ...base, HOME: home, NODE_EXTRA_CA_CERTS: tls.cert, NODE_OPTIONS: `--import ${preload}`, HOOKS_E2E_SOL_USD: solUsd, HOOK_OWNER_APPROVAL_TOKEN: token, E2E_TELEMETRY_DISABLED: '1' }
  const agent = startProcess('owner-agent', process.execPath, [path.join(REPO_ROOT, 'scripts/hooklab-owner-agent.mjs'), '--local-acceptance', '--genesis', genesisHash,
    '--state-dir', stateDir, '--admin-key', adminKeyFile, '--origin', origin, '--rpc', proxies[0].origin, '--rpc2', proxies[1].origin, '--poll-ms', '500', '--invite-minutes', '15'],
  { cwd: REPO_ROOT, env, logFile: path.join(root, 'logs', 'owner-agent.log'), stdin: 'pipe' })
  try {
    await waitFor('the owner agent to come online', async () => {
      if (!agent.alive()) throw Error(`owner agent exited: ${agent.lines.slice(-5).join(' | ')}`)
      return (await https(`${origin}/api/hook-lab/launch-requests`)).json?.online === true
    }, { timeoutMs: 60_000, intervalMs: 500 })
    log?.(`owner agent online (pid ${agent.pid}): ${agent.lines.find(line => line.startsWith('Owner agent for')) ?? ''}`)
    return { ...agent, command: line => agent.write(`${line}\n`) }
  } catch (error) { await agent.stop(); throw error }
}
