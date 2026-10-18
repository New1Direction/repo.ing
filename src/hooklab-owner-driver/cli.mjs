// Command-line front end for the owner driver. See scripts/hooklab-owner.mjs.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, STAGES, STAGE_ORDER } from './context.mjs'
import { plan } from './plan.mjs'
import { execute } from './execute.mjs'
import { renderPreview } from './preview.mjs'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const USAGE = `usage:
  node scripts/hooklab-owner.mjs plan STAGE [--rpc URL --rpc2 URL] [--config PATH] [--runs DIR] [--local-test]
  node scripts/hooklab-owner.mjs execute STAGE --message-sha256 HEX --key ROLE=PATH [--key ROLE=PATH ...]
       [--approved STAGE:SHA256] [--run DIR] [--prep-slot N] [--rpc URL --rpc2 URL] [--config PATH] [--runs DIR] [--journal DIR] [--local-test]
  (one-send journal default: ~/.hooklab-owner/journal/<genesis>; never delete it while any attempt is unresolved)
  node scripts/hooklab-owner.mjs status [--rpc URL --rpc2 URL] [--config PATH] [--local-test]
stages (in order): ${STAGE_ORDER.join(', ')}
roles: admin guardian treasury upgrade payer creator mint selectedConfig
mainnet: reads verify genesis 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d on two HTTPS providers; plan never signs or sends.`

const repeatable = new Set(['--key', '--approved'])
const flags = new Set(['--local-test'])
const valued = new Set(['--rpc', '--rpc2', '--config', '--runs', '--journal', '--message-sha256', '--run', '--prep-slot', ...repeatable])
export function parseArgs(argv) {
  const [command, maybeStage, ...rest] = argv
  const stage = command === 'status' ? 'status' : maybeStage
  const tail = command === 'status' ? [maybeStage, ...rest].filter(x => x !== undefined) : rest
  const out = { command, stage, key: [], approved: [] }
  for (let i = 0; i < tail.length; i++) {
    const name = tail[i]
    if (flags.has(name)) { out[name.slice(2)] = true; continue }
    if (!valued.has(name) || i + 1 >= tail.length) throw Error(`Unsupported or incomplete argument ${name}\n${USAGE}`)
    const v = tail[++i], field = name.slice(2)
    if (repeatable.has(name)) out[field].push(v); else { if (out[field] !== undefined) throw Error(`Duplicate ${name}`); out[field] = v }
  }
  if (!['plan', 'execute', 'status'].includes(command)) throw Error(USAGE)
  if (!STAGES[stage]) throw Error(`Unknown stage ${stage}\n${USAGE}`)
  return out
}
export async function main(argv, { log = console.log, confirm } = {}) {
  const args = parseArgs(argv)
  const ctx = await createContext({ configPath: path.resolve(args.config ?? path.join(REPO_ROOT, 'hooklab-owner.config.json')), rpc: args.rpc, rpc2: args.rpc2,
    localTest: !!args['local-test'], runsRoot: path.resolve(args.runs ?? path.join(REPO_ROOT, 'hooklab-owner-runs')),
    journalRoot: path.resolve(args.journal ?? path.join(os.homedir(), '.hooklab-owner', 'journal')), options: { prepSlot: args['prep-slot'] } })
  if (args.command === 'status' || args.stage === 'status') {
    const built = await STAGES.status.build(ctx)
    const text = renderPreview({ stage: 'status', network: ctx.network, genesisHash: ctx.genesis, observedSlot: built.observedSlot, providers: ctx.readers.map(r => `${r.provider}=${r.url}`), sections: built.sections })
    log(text); return { built, text }
  }
  if (args.command === 'plan') return plan(ctx, args.stage, { log })
  return execute(ctx, args.stage, { messageSha256: args['message-sha256'], keys: args.key, approved: args.approved, runDir: args.run ? path.resolve(args.run) : undefined, log, confirm })
}
