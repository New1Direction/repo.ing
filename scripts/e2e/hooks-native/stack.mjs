// Brings one local stack up, and down again: validator (one program set) -> owner-driver protocol setup for the mode ->
// disposable database -> HTTPS RPC proxies -> local operator bundle -> website (production bootstrap, local acceptance)
// -> owner agent (disposable key file; not in self-serve mode) -> control API. Modes (scripts/e2e/hooks-native/modes.mjs):
// native (the owner-approved native-SOL release, E1/E2), legacy (what mainnet runs today, bridged SOL) and self-serve.
// Everything lives under one temporary root that teardown deletes, keys included.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PublicKey } from '@solana/web3.js'
import { syntheticRoles, writeKeyFiles } from '../../../tests/fixtures/hooklab-owner-local.mjs'
import { FIXED_SOL_USD, REPO_ROOT, freePort, sha256, stageLog } from './common.mjs'
import { makeLocalCertificate } from './tls.mjs'
import { startValidator } from './validator.mjs'
import { ownerDriver, setupForMode, setupOwnStack } from './owner-setup.mjs'
import { MODES } from './modes.mjs'
import { ownStackSet, programSet } from './program-sets.mjs'
import { createDatabase } from './database.mjs'
import { startRpcProxies } from './rpc-proxy.mjs'
import { collectLocalBundle, collectLocalStackBundle } from './bundle.mjs'
import { siteEnvironment, startSite } from './site.mjs'
import { startOwnerAgent } from './owner-agent.mjs'
import { startControl } from './control.mjs'
import { httpsClient } from './https-client.mjs'

// Child processes get only what they need, never this shell's credentials or RPC URLs. Captured before the owner driver
// enters its in-process local scope (it sets HOOK_LOCAL_ACCEPTANCE* on process.env).
const BASE_ENV = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'LOGNAME', 'SHELL'].filter(k => process.env[k]).map(k => [k, process.env[k]]))

/** Runs a child to completion without blocking this process (the stack's proxies and control API keep serving). */
function runChild(command, args, { cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('exit', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

export async function up({ keep = false, mode: modeName = 'native' } = {}) {
  const mode = MODES[modeName]
  if (!mode) throw Error(`unknown stack mode ${modeName}; known: ${Object.keys(MODES).join(', ')}`)
  const log = stageLog(`stack ${modeName}`), cleanups = []
  const root = mkdtempSync(path.join(process.env.HOOKS_E2E_ROOT ?? tmpdir(), 'hooks-native-e2e-'))
  mkdirSync(path.join(root, 'logs'), { mode: 0o700 })
  const down = async () => {
    for (const cleanup of cleanups.reverse()) { try { await cleanup.run() } catch (error) { console.error(`teardown ${cleanup.name}: ${error.message}`) } }
    if (!keep) rmSync(root, { recursive: true, force: true })
    log(keep ? `stopped; kept ${root}` : `stopped; removed ${root}`)
  }
  try {
    log(`root ${root}`)
    const tls = makeLocalCertificate(path.join(root, 'tls'))
    const roles = syntheticRoles(), keys = writeKeyFiles(path.join(root, 'keys'), roles)
    const address = role => roles[role].publicKey.toBase58()

    const set = programSet(mode.set()), own = mode.own ? await ownStackSet({ upgradeAuthority: address('upgrade') }) : null
    const validator = await startValidator({ root, roles, set, own, log })
    cleanups.push({ name: 'validator', run: validator.stop })
    const driver = ownerDriver({ validator, root, roles, keys, log, decisions: mode.decisions })
    // The release's read-only preflight runs inside the setup, on the protocol as it stands before the native switch.
    const preflight = () => JSON.parse(execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/hooklab-native-preflight.mjs'), '--local-test', '--rpc', validator.url, '--rpc2', validator.url2],
      { cwd: REPO_ROOT, env: BASE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).ok
    const tables = await setupForMode(driver, modeName, { preflight, log })
    // Our own stack's first-time setup, through the owner driver's --stack mode (self-serve).
    const ownDriver = own ? ownerDriver({ validator, root, roles, keys, log, decisions: mode.ownDecisions, own }) : null
    const ownTables = own ? await setupOwnStack(ownDriver) : null

    const database = await createDatabase({ log })
    cleanups.push({ name: 'database', run: database.drop })
    const proxies = await startRpcProxies({ upstream: validator.url, tls, auditFile: path.join(root, 'logs', 'rpc-sends.jsonl'), log })
    cleanups.push({ name: 'rpc proxies', run: proxies.stop })

    const tradeTable = tables.tradeTable, launchTable = ownTables?.launchTable ?? tables.launchTable ?? null
    const token = randomBytes(32).toString('base64url'), port = await freePort(), https = httpsClient(tls.cert)
    const preload = pathToFileURL(path.join(REPO_ROOT, 'scripts/e2e/hooks-native/offline-preload.mjs')).href
    // One key ring for the whole run, so custody encrypted before a restart stays readable after it.
    const keyRing = { 'local-e2e': randomBytes(32).toString('base64') }
    async function writeBundle() {
      const bundle = await collectLocalBundle({ genesisHash: validator.genesisHash, providers: proxies.providers, tlsCert: tls.cert, tradeTable, launchTable: own ? null : launchTable,
        reviewer: address('admin'), treasury: address('treasury'), build: set.bundle.build })
      const bytes = Buffer.from(JSON.stringify(bundle)), file = path.join(root, `operator-bundle-${sha256(bytes).slice(0, 12)}.json`)
      writeFileSync(file, bytes, { mode: 0o600 })
      log(`local operator bundle ${sha256(bytes).slice(0, 16)}… (build ${set.bundle.build}, profile ${bundle.profile.expectedSha256.slice(0, 16)}…, trade table ${tradeTable}${launchTable && !own ? `, launch table ${launchTable}` : ''})`)
      let stackBundle = null
      if (own) {
        const ownBundle = await collectLocalStackBundle({ own, genesisHash: validator.genesisHash, providers: proxies.providers, tlsCert: tls.cert, tradeTable: ownTables.tradeTable,
          launchTable: ownTables.launchTable, reviewer: address('admin'), treasury: address('treasury') })
        const ownBytes = Buffer.from(JSON.stringify(ownBundle)), ownFile = path.join(root, `stack-bundle-${sha256(ownBytes).slice(0, 12)}.json`)
        writeFileSync(ownFile, ownBytes, { mode: 0o600 })
        log(`our stack's bundle ${sha256(ownBytes).slice(0, 16)}… (${own.name}, profile ${ownBundle.profile.expectedSha256.slice(0, 16)}…, trade table ${ownTables.tradeTable}, launch table ${ownTables.launchTable})`)
        stackBundle = { file: ownFile, sha256: sha256(ownBytes), profileSha256: ownBundle.profile.expectedSha256 }
      }
      return { file, sha256: sha256(bytes), profileSha256: bundle.profile.expectedSha256, stack: stackBundle }
    }
    // The website and the owner agent, restartable as a deploy would restart them (E2 recovery scenarios use this).
    let app = null, bundleState = null
    async function startApp({ recollect = true, env: overrides = {} } = {}) {
      if (recollect || !bundleState) bundleState = await writeBundle()
      const env = { ...siteEnvironment({ base: BASE_ENV, port, tls, genesisHash: validator.genesisHash, databaseUrl: database.url, proxies: proxies.providers,
        bundle: bundleState, keyRing, ownerTokenSha256: createHash('sha256').update(token).digest('hex'), admin: address('admin'), preload, solUsd: FIXED_SOL_USD }), ...mode.env,
        ...(bundleState.stack ? { HOOKLAB_STACK_BUNDLE_FILE: bundleState.stack.file, HOOKLAB_STACK_BUNDLE_SHA256: bundleState.stack.sha256, HOOK_STACK_ADMIN_ADDRESS: address('admin') } : {}), ...overrides }
      // The production bootstrap, with the website's environment, in a child first: a clear error instead of a one-line refusal.
      // Async: the RPC proxies it reads through live in this process, so a blocking spawn would starve them.
      const check = await runChild(process.execPath, [path.join(REPO_ROOT, 'scripts/e2e/hooks-native/bootstrap-check.mjs')], { cwd: REPO_ROOT, env, timeoutMs: 120_000 })
      if (check.status !== 0 && !(check.status === 3 && env.HOOK_NATIVE_TRADING_ENABLED === 'false')) throw Error(`production bootstrap check failed (exit ${check.status}):\n${check.stdout}${check.stderr}`)
      log(`production bootstrap check: ${check.stdout.trim()}`)
      const site = await startSite({ root, env, port, tls, https, log })
      try {
        // Self-serve mode has NO owner agent process at all (ownerless launches).
        const agent = mode.ownerAgent ? await startOwnerAgent({ root, base: BASE_ENV, tls, preload, solUsd: FIXED_SOL_USD, origin: site.origin, proxies: proxies.providers,
          genesisHash: validator.genesisHash, adminKeyFile: keys.admin, token, https, log }) : null
        if (!agent) log('no owner agent in this mode')
        app = { site, agent, bundle: bundleState }
        return app
      } catch (error) { await site.stop(); throw error }
    }
    async function stopApp() { if (!app) return; const { site, agent } = app; app = null; await agent?.stop(); await site.stop() }
    cleanups.push({ name: 'site and owner agent', run: stopApp })
    const controlToken = randomBytes(24).toString('base64url')
    const control = await startControl({ token: controlToken, log, routes: {
      'GET /health': async () => ({ mode: modeName, validator: await validator.connection.getSlot('finalized'), site: !!app?.site.alive(), agent: !!app?.agent?.alive() }),
      'POST /owner/agent': async ({ line }) => {
        if (!app?.agent) throw Error('no owner agent runs in this mode')
        if (!/^(list|invite \d+( \d+)?|decline \d+|pause|resume)$/.test(line)) throw Error('unsupported agent command'); app.agent.command(line); return { ok: true, at: app.agent.lines.length }
      },
      'GET /owner/agent/log': async (_, query) => { if (!app?.agent) throw Error('no owner agent runs in this mode'); const from = Number(query.get('from') ?? 0); return { lines: app.agent.lines.slice(from), next: app.agent.lines.length } },
      'POST /owner/customer-grant': async ({ creator }) => {
        const result = await driver.run('customer-grant', ['payer', 'admin'], { extra: ['--creator', creator] })
        return { signature: result.receipt.signature, postconditions: result.receipt.postconditions }
      },
      // The owner's own-stack stages a test may run (self-serve): the guardian's pauses, the admin reopening, the platform
      // fee collection. Each is the owner driver's plan -> execute with its exact approval, as the owner runs it.
      'POST /owner/stage': async ({ stage, pause = null, mint = null }) => {
        if (!ownDriver) throw Error('no own stack in this mode')
        const plan = { 'guardian-pause': [['payer', 'guardian'], { extra: ['--pause', pause] }], 'open-launches': [['payer', 'admin'], { approve: true }],
          'open-trading': [['payer', 'admin'], { approve: true }], 'collect-native': [['payer'], { approve: true, extra: ['--mint', mint] }] }[stage]
        if (!plan || (stage === 'guardian-pause' && !['creation', 'trading', 'both'].includes(pause))) throw Error('unsupported owner stage')
        const result = await ownDriver.run(stage, ...plan)
        return { signature: result.receipt.signature, postconditions: result.receipt.postconditions }
      },
      // The owner's moderation tool (scripts/hooklab-moderate.mjs), as the owner runs it, with the owner token.
      'POST /owner/moderate': async ({ action, mint, reason = null }) => {
        if (!['delist', 'relist'].includes(action)) throw Error('unsupported moderation action')
        const args = [path.join(REPO_ROOT, 'scripts/hooklab-moderate.mjs'), action, mint, ...(reason ? ['--reason', reason] : []), '--origin', app.site.origin, '--yes']
        const result = await runChild(process.execPath, args, { cwd: REPO_ROOT, env: { ...BASE_ENV, HOOK_OWNER_APPROVAL_TOKEN: token, NODE_EXTRA_CA_CERTS: tls.cert }, timeoutMs: 60_000 })
        if (result.status !== 0) throw Error(`moderation refused: ${result.stderr.trim() || result.stdout.trim()}`)
        return { output: result.stdout.trim() }
      },
      'GET /rpc/sends': async () => proxies.sends(),
      'POST /rpc/faults': async ({ loseNextSendResponse = false, holdNextSendMs = 0, lowerLastValidBlockHeight = null }) => {
        Object.assign(proxies.faults, { loseNextSendResponse: loseNextSendResponse === true, holdNextSendMs: Math.min(Number(holdNextSendMs) || 0, 120_000),
          lowerLastValidBlockHeight: lowerLastValidBlockHeight && ['local-a', 'local-b'].includes(lowerLastValidBlockHeight.provider) ? { provider: lowerLastValidBlockHeight.provider, by: Number(lowerLastValidBlockHeight.by) } : null })
        return { ...proxies.faults }
      },
      // Which exact (unbound) dossier pins of the deployed bundle no longer match the chain (the site refuses every review then).
      'GET /site/bundle-drift': async () => {
        const dossier = JSON.parse(JSON.parse(readFileSync(app.bundle.file, 'utf8')).dossierJson)
        const { value } = await validator.connection.getMultipleAccountsInfoAndContext(dossier.accounts.map(a => new PublicKey(a.address)), 'finalized')
        return { drifted: dossier.accounts.filter((pin, i) => !pin.binding && sha256(Buffer.from(value[i]?.data ?? [])) !== pin.dataSha256).map(pin => pin.role) }
      },
      // A deploy: stop the site and agent, optionally re-collect the bundle, restart with HOOK_* switch overrides.
      'POST /site/restart': async ({ recollect = false, env = {} }) => {
        if (!Object.entries(env).every(([key, value]) => /^HOOK_[A-Z_]+$/.test(key) && ['true', 'false'].includes(value))) throw Error('only HOOK_* true/false overrides')
        await stopApp(); const started = await startApp({ recollect, env }); return { bundle: started.bundle }
      },
    } })
    cleanups.push({ name: 'control', run: control.stop })
    // The control API is up before the app, so a held failure can be retried with POST /site/restart.
    const stateFile = path.join(root, 'stack.json')
    const writeState = () => writeFileSync(stateFile, JSON.stringify({ mode: modeName, programSet: own ? `${set.name} + ${own.name}` : set.name, programs: own ? own.ids : set.ids, quoteMint: own ? own.quoteMint : set.quoteMint,
      legacyPrograms: own ? set.ids : null, ownTradeTable: ownTables?.tradeTable ?? null, launchTable,
      idlDir: own ? path.join(root, 'own-stack', 'idl') : null, root, origin: `https://localhost:${port}`, genesisHash: validator.genesisHash,
      validator: { url: validator.url, faucetPort: validator.faucetPort }, database: { url: database.url, name: database.name }, rpc: proxies.providers,
      control: { url: control.url, token: controlToken }, tls: { cert: tls.cert, spki: tls.spki }, roles: Object.fromEntries(Object.keys(roles).map(role => [role, address(role)])),
      tradeTable, bundle: app ? { sha256: app.bundle.sha256, profileSha256: app.bundle.profileSha256 } : null, solUsd: FIXED_SOL_USD }, null, 2), { mode: 0o600 })
    writeState()
    log(`control state ${stateFile}`)
    await startApp()
    writeState()

    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    log(`READY ${state.origin} · genesis ${validator.genesisHash} · state ${stateFile}`)
    return { state, stateFile, down, log }
  } catch (error) {
    // HOOKS_E2E_HOLD_ON_FAILURE=1 keeps whatever is running for debugging until Ctrl-C, then tears it all down.
    if (process.env.HOOKS_E2E_HOLD_ON_FAILURE === '1') {
      log(`FAILED, holding for debugging (Ctrl-C tears down; root ${root}): ${error.stack ?? error.message}`)
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
    }
    await down(); throw error
  }
}
