import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, cp, symlink, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as sdk from '@repo-ing/hooklab-readonly'
import { HOOK_LAB_COMMIT, HOOK_LAB_INTEGRATION_COMMIT, HOOK_LAB_MANIFEST_SHA256 } from '../src/direct-coins.mjs'

test('vendored contract preserves provenance, all assets and only the six read-only exports', async () => {
  assert.deepEqual(Object.keys(sdk).sort(), ['inspectDevnetIntegration', 'integrationCapabilities', 'integrationCompatibility', 'integrationIdlRefusals', 'integrationManifest', 'previewHookLabIntegration'])
  const root = new URL('../vendor/hooklab-readonly/', import.meta.url)
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)))
  assert.equal(provenance.revision, HOOK_LAB_INTEGRATION_COMMIT)
  assert.equal(provenance.abiSourceCommit, HOOK_LAB_COMMIT)
  assert.equal(provenance.manifestSha256, HOOK_LAB_MANIFEST_SHA256)
  assert.equal(Object.keys(provenance.files).filter(p => p.startsWith('idl/')).length, 11)
  for (const [file, hash] of Object.entries(provenance.files)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(file, root))).digest('hex'), hash, file)
    const installed = new URL('../', import.meta.resolve('@repo-ing/hooklab-readonly'))
    assert.equal(createHash('sha256').update(await readFile(new URL(file, installed))).digest('hex'), hash, `installed ${file}`)
  }
  assert.deepEqual(sdk.integrationIdlRefusals(), [])
  const manifest = sdk.integrationManifest()
  assert.deepEqual(sdk.integrationCompatibility(manifest), [])
  manifest.extraField = 'not approved'
  assert.equal(sdk.integrationCompatibility(manifest)[0].code, 'CONTRACT_MISMATCH')
  assert.equal(sdk.integrationManifest().extraField, undefined)
  const noRpc = { getGenesisHash() { throw new Error('No RPC permitted') } }
  const unconfirmed = await sdk.inspectDevnetIntegration(noRpc, { confirmedNetwork: '', manifest: sdk.integrationManifest() })
  assert.deepEqual(unconfirmed.refusals.map(r => r.code), ['NETWORK_CONFIRMATION_REQUIRED'])
})

test('relocated bundle detects raw IDL tampering before inspection and does not infer readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hooklab-readonly-'))
  try {
    await cp(new URL('../vendor/hooklab-readonly/', import.meta.url), join(directory, 'package'), { recursive: true })
    await symlink(resolve('node_modules'), join(directory, 'node_modules'))
    const relocated = await import(pathToFileURL(join(directory, 'package/dist/index.mjs')))
    assert.deepEqual(relocated.integrationIdlRefusals(), [])
    await appendFile(join(directory, 'package/idl/bordrless_token.json'), '\n')
    const inspection = await relocated.inspectDevnetIntegration({}, { confirmedNetwork: 'devnet', manifest: relocated.integrationManifest() })
    assert.deepEqual(inspection.refusals.map(r => [r.code, r.subject]), [['IDL_MISMATCH', 'bordrless_token']])
    assert.equal(inspection.observedSlot, null)
    await appendFile(join(directory, 'package/integration/devnet.json'), '\n')
    assert.throws(() => relocated.integrationManifest(), /manifest checksum mismatch/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
