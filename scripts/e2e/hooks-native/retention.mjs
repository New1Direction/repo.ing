// Keep small diagnostic evidence, not validator ledgers, synthetic secrets or site caches.
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './common.mjs'

export function createRunCleanup({ root, cleanups = [], keep = false, log = () => {},
  artifactsDir = process.env.HOOKS_E2E_ARTIFACT_DIR ?? path.join(REPO_ROOT, '.amp/in/artifacts/hooks-native-runs') }) {
  root = path.resolve(root); artifactsDir = path.resolve(artifactsDir)
  if (!/^hooks-native-e2e-[A-Za-z0-9]+$/.test(path.basename(root)) || lstatSync(root).isSymbolicLink()) throw Error('Not an owned e2e scratch directory')
  if (artifactsDir === root || artifactsDir.startsWith(root + path.sep)) throw Error('Evidence must be outside the disposable root')
  let stopping
  return function down({ status = 'stopped' } = {}) {
    return stopping ??= (async () => {
      const errors = []
      for (const cleanup of [...cleanups].reverse()) {
        try { await cleanup.run() } catch (error) { errors.push(error); log(`teardown ${cleanup.name}: ${error.message}`) }
      }
      const evidence = path.join(artifactsDir, path.basename(root))
      try {
        mkdirSync(artifactsDir, { recursive: true, mode: 0o700 })
        mkdirSync(evidence, { mode: 0o700 })
        for (const name of ['logs', 'owner-runs', 'owner-own-runs', 'owner-journal', 'owner-own-journal']) {
          const source = path.join(root, name)
          if (!existsSync(source)) continue
          cpSync(source, path.join(evidence, name), { recursive: true, force: false, errorOnExist: true,
            filter: file => {
              const stat = lstatSync(file)
              if (stat.isSymbolicLink()) return false
              return stat.isDirectory() || (stat.isFile() && (name === 'logs' ||
                /^(plan\.json|preview\.(json|txt)|unsigned-tx\.base64|receipt-[a-f0-9]+\.json)$/.test(path.basename(file)) || file.endsWith('.public.json')))
            } })
        }
        writeFileSync(path.join(evidence, 'run.json'), JSON.stringify({ root, status, completedAt: new Date().toISOString(),
          scratchRetained: keep || errors.length > 0, cleanupFailed: errors.length > 0 }, null, 2), { mode: 0o600, flag: 'wx' })
        log(`diagnostic evidence ${evidence}`)
      } catch (error) { errors.push(error) }
      if (!keep && !errors.length) rmSync(root, { recursive: true, force: true })
      log(keep || errors.length ? `stopped; kept ${root}` : `stopped; removed ${root}`)
      if (errors.length) throw new AggregateError(errors, `Cleanup incomplete; scratch preserved at ${root}`)
    })()
  }
}
