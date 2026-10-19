// Brings the whole local native-SOL stack up, and down again: validator (candidate ELFs) -> owner-driver protocol setup
// -> native preflight -> USD bounds + native-launches on -> disposable database -> HTTPS RPC proxies -> local operator
// bundle -> website (production bootstrap, local acceptance) -> owner agent (disposable key file) -> control API.
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
import { ownerDriver, setupProtocol, switchNativeOn } from './owner-setup.mjs'
import { createDatabase } from './database.mjs'
import { startRpcProxies } from './rpc-proxy.mjs'
import { collectLocalBundle } from './bundle.mjs'
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

export async function up({ keep = false } = {}) {
  const log = stageLog('stack'), cleanups = []
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

    const validator = await startValidator({ root, roles, log })
    cleanups.push({ name: 'validator', run: validator.stop })
    const driver = ownerDriver({ validator, root, roles, keys, log })
    await setupProtocol(driver)
    // The release's read-only preflight, on the protocol as it stands before the switch (exit 0 = no native flag yet).
    const preflight = execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/hooklab-native-preflight.mjs'), '--local-test', '--rpc', validator.url, '--rpc2', validator.url2],
      { cwd: REPO_ROOT, env: BASE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    log(`native preflight before the switch: ok=${JSON.parse(preflight).ok}`)
    await switchNativeOn(driver)

    const database = await createDatabase({ log })
    cleanups.push({ name: 'database', run: database.drop })
    const proxies = await startRpcProxies({ upstream: validator.url, tls, auditFile: path.join(root, 'logs', 'rpc-sends.jsonl'), log })
    cleanups.push({ name: 'rpc proxies', run: proxies.stop })

    const tradeTable = JSON.parse(readFileSync(path.join(root, 'owner-journal', validator.genesisHash.slice(0, 16), 'trade-table.public.json'), 'utf8')).address
    const token = randomBytes(32).toString('base64url'), port = await freePort(), https = httpsClient(tls.cert)
    const preload = pathToFileURL(path.join(REPO_ROOT, 'scripts/e2e/hooks-native/offline-preload.mjs')).href
    // One key ring for the whole run, so custody encrypted before a restart stays readable after it.
    const keyRing = { 'local-e2e': randomBytes(32).toString('base64') }
    async function writeBundle() {
      const bundle = await collectLocalBundle({ genesisHash: validator.genesisHash, providers: proxies.providers, tlsCert: tls.cert, tradeTable,
        reviewer: address('admin'), treasury: address('treasury'), build: 'native' })
      const bytes = Buffer.from(JSON.stringify(bundle)), file = path.join(root, `operator-bundle-${sha256(bytes).slice(0, 12)}.json`)
      writeFileSync(file, bytes, { mode: 0o600 })
      log(`local operator bundle ${sha256(bytes).slice(0, 16)}… (profile ${bundle.profile.expectedSha256.slice(0, 16)}…, bundle 3 native pins, trade table ${tradeTable})`)
      return { file, sha256: sha256(bytes), profileSha256: bundle.profile.expectedSha256 }
    }
    // The website and the owner agent, restartable as a deploy would restart them (E2 recovery scenarios use this).
    let app = null, bundleState = null
    async function startApp({ recollect = true, env: overrides = {} } = {}) {
      if (recollect || !bundleState) bundleState = await writeBundle()
      const env = { ...siteEnvironment({ base: BASE_ENV, port, tls, genesisHash: validator.genesisHash, databaseUrl: database.url, proxies: proxies.providers,
        bundle: bundleState, keyRing, ownerTokenSha256: createHash('sha256').update(token).digest('hex'), admin: address('admin'), preload, solUsd: FIXED_SOL_USD }), ...overrides }
      // The production bootstrap, with the website's environment, in a child first: a clear error instead of a one-line refusal.
      // Async: the RPC proxies it reads through live in this process, so a blocking spawn would starve them.
      const check = await runChild(process.execPath, [path.join(REPO_ROOT, 'scripts/e2e/hooks-native/bootstrap-check.mjs')], { cwd: REPO_ROOT, env, timeoutMs: 120_000 })
      if (check.status !== 0 && !(check.status === 3 && overrides.HOOK_NATIVE_TRADING_ENABLED === 'false')) throw Error(`production bootstrap check failed (exit ${check.status}):\n${check.stdout}${check.stderr}`)
      log(`production bootstrap check: ${check.stdout.trim()}`)
      const site = await startSite({ root, env, port, tls, https, log })
      try {
        const agent = await startOwnerAgent({ root, base: BASE_ENV, tls, preload, solUsd: FIXED_SOL_USD, origin: site.origin, proxies: proxies.providers,
          genesisHash: validator.genesisHash, adminKeyFile: keys.admin, token, https, log })
        app = { site, agent, bundle: bundleState }
        return app
      } catch (error) { await site.stop(); throw error }
    }
    async function stopApp() { if (!app) return; const { site, agent } = app; app = null; await agent.stop(); await site.stop() }
    cleanups.push({ name: 'site and owner agent', run: stopApp })
    const controlToken = randomBytes(24).toString('base64url')
    const control = await startControl({ token: controlToken, log, routes: {
      'GET /health': async () => ({ validator: await validator.connection.getSlot('finalized'), site: !!app?.site.alive(), agent: !!app?.agent.alive() }),
      'POST /owner/agent': async ({ line }) => { if (!/^(list|invite \d+( \d+)?|decline \d+|pause|resume)$/.test(line)) throw Error('unsupported agent command'); app.agent.command(line); return { ok: true, at: app.agent.lines.length } },
      'GET /owner/agent/log': async (_, query) => { const from = Number(query.get('from') ?? 0); return { lines: app.agent.lines.slice(from), next: app.agent.lines.length } },
      'POST /owner/customer-grant': async ({ creator }) => {
        const result = await driver.run('customer-grant', ['payer', 'admin'], { extra: ['--creator', creator] })
        return { signature: result.receipt.signature, postconditions: result.receipt.postconditions }
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
    const writeState = () => writeFileSync(stateFile, JSON.stringify({ root, origin: `https://localhost:${port}`, genesisHash: validator.genesisHash,
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
