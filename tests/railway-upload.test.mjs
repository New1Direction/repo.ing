// Railway uploads the repo filtered by .railwayignore (gitignore rules; it wins over .gitignore's exceptions). A pinned
// file the running app reads but the upload drops fails only in production, while every test here still passes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FILES } from '../src/hooklab-owner-driver/artifacts.mjs'

const KEY_FILES = ['wallet.json', 'deploy-keypair.json', 'vendor/hooklab-event-abi/inclusive-max-wallet-candidate/admin-wallet.json']

test('every pinned Hook Lab artifact reaches the Railway upload, and wallet and key files still do not', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'railway-upload-'))
  try {
    execFileSync('git', ['init', '-q', dir])
    copyFileSync('.railwayignore', path.join(dir, '.gitignore'))
    for (const file of [...Object.values(FILES), ...KEY_FILES]) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), '')
    }
    const ignored = file => {
      try { execFileSync('git', ['-c', 'core.excludesFile=/dev/null', '-C', dir, 'check-ignore', '-q', file]); return true }
      catch (error) { if (error.status === 1) return false; throw error }
    }
    for (const file of Object.values(FILES)) assert.equal(ignored(file), false, `${file} is left out of the Railway upload`)
    for (const file of KEY_FILES) assert.equal(ignored(file), true, `${file} would be uploaded`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
