// Real-browser e2e suite for the repo.ing Hooks native-SOL release. Run it through the stack, which brings up the local
// validator, database, site and owner agent and tears them down after:
//
//   node scripts/e2e/hooks-native-stack.mjs test
//
// Deterministic locators and chain/database assertions only: no agent steps and no model (agents: {}).
import { readFileSync } from 'node:fs'
import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
import { localChromium } from './support/local-chromium.ts'

const stateFile = process.env.HOOKS_E2E_STACK
if (!stateFile) throw new Error('HOOKS_E2E_STACK is not set: run the suite with `node scripts/e2e/hooks-native-stack.mjs test`')
const stack = JSON.parse(readFileSync(stateFile, 'utf8')) as { origin: string; tls: { spki: string } }

export default {
  projectId: 'repoing-hooks-native-e2e',
  tests: ['**/*.e2e.ts'], // relative to this directory, the project root
  output: '.e2e',
  targets: [{ name: 'chromium-local', engine: web({ browser: localChromium({ spki: stack.tls.spki }), viewport: { width: 1280, height: 900 } }), app: { url: stack.origin } }],
  // One ordered flow on one chain: serial, no retries (a retry would re-spend), long timeouts for finalized reads.
  workers: 1,
  retries: 0,
  timeout: 900_000,
  actionTimeout: 30_000,
  assertionTimeout: 30_000,
  cache: 'off',
} satisfies E2EConfig
