// The suite's browser: Playwright's own Chromium (playwright-core's pinned build, already installed for the e2e engine),
// launched headless for the run and driven over CDP like any provider's browser. The only reason it is launched here and
// not by `web()` is TLS: the local site is https://localhost with a throwaway certificate, and this browser trusts
// exactly that certificate's key (--ignore-certificate-errors-spki-list), nothing else. It uses a mock keychain and a
// basic password store, so it never touches the macOS Keychain, and a fresh profile directory that release deletes.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { BrowserLease, BrowserProvider } from '@e2e-dev/web'

const require = createRequire(import.meta.url)

interface LocalLease extends BrowserLease { readonly pid: number; readonly profile: string }

export function localChromium({ spki, root }: { spki: string; root: string }): BrowserProvider {
  return {
    name: 'local-chromium',
    scope: 'worker',
    async acquire(request) {
      const { chromium } = require('playwright-core') as typeof import('playwright-core')
      // Root teardown also catches failed acquisition or a forcibly stopped runner.
      const profile = mkdtempSync(path.join(root, 'chrome-'))
      const child = spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic', '--enable-automation',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--metrics-recording-only',
        '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider', `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank'],
      { stdio: ['ignore', 'ignore', 'pipe'], detached: false })
      const cdpEndpoint = await new Promise<string>((resolve, reject) => {
        let text = ''
        const timer = setTimeout(() => reject(new Error('Chromium did not open its DevTools endpoint within 30 s')), 30_000)
        child.stderr.on('data', chunk => {
          text += chunk
          const found = /DevTools listening on (ws:\/\/\S+)/.exec(text)
          if (found) { clearTimeout(timer); resolve(found[1]) }
        })
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`Chromium exited ${code}: ${text.slice(-500)}`)) })
        request.signal.addEventListener('abort', () => { child.kill('SIGKILL'); reject(new Error('aborted')) })
      })
      request.log(`local Chromium pid ${child.pid} trusting only the stack certificate`)
      return { id: String(child.pid), cdpEndpoint, pid: child.pid as number, profile } satisfies LocalLease
    },
    async release(lease) {
      const { pid, profile } = lease as LocalLease
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
      for (let i = 0; i < 25; i++) { try { process.kill(pid, 0) } catch { break } await new Promise(r => setTimeout(r, 200)) }
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
      rmSync(profile, { recursive: true, force: true })
    },
  }
}
