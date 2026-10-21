import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { selectedHookSettings } from '../src/hooklab-production-bootstrap.mjs'
import * as economic from '../scripts/e2e/hooks-native/economic-fixture.mjs'
import { selectedLaunchCollectorFixture } from './fixtures/selected-hook-launch.mjs'
import { validateSelectedHookReleaseBindings } from '../src/hooklab-max-wallet-launch-collector.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
test('economic candidate inventory requires separately pinned candidate IDLs, never historical fallback', () => {
  const pin = name => [`target/creator-selected-v1-candidate/${name}`, 'a'.repeat(64)]
  const candidate = {
    schema: 'repoing/local-economic-candidate/1', sourceCommit: 'b'.repeat(40),
    pins: Object.fromEntries(['launch', 'swap', 'token', 'gate', 'selected', 'alternate'].map(role => [role, pin(`${role}.so`)])),
    idls: Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, pin(`${role}.json`)])),
    hooks: [
      { role: 'selected', program: '8KoeKiwydKzdH65uD4Z6uJgR9uKnj2w22HXRSdCXGhF2', flags: 65, name: 'Economic transfer tax' },
      { role: 'alternate', program: '4P9UnqR2FgD1XjkcpyWzabQCrhPDTQkZy8631jvTnYqL', flags: 3, name: 'Transfer receipt (no economic fee)' },
    ],
  }
  const rebuiltToken = structuredClone(candidate)
  assert.throws(() => economic.economicInventorySchema.parse(rebuiltToken), 'V1 cannot silently substitute a rebuilt token')
  candidate.pins.token = ['.amp/in/elf-deployed-token/bordrless_token.so', '5fbbb2ebca32ed3df4c0299da3376141969ac6088700c86390d8b05d0c451dab']
  assert.deepEqual(economic.economicInventorySchema.parse(candidate), candidate)
  for (const mutate of [v => delete v.idls, v => delete v.idls.swap,
    v => { v.idls.launch[0] = 'idl/independent/bordrless_launch.json' },
    v => { v.pins.token[1] = 'a9670ffa6a9a5289de39aa40292ced307781ddf260d350e31ae90f17808fcd89' },
    v => { v.idls.launch[1] = '' }, v => { v.idls.gate[0] = 'target/creator-selected-v1-candidate/../gate.json' }]) {
    const invalid = structuredClone(candidate); mutate(invalid)
    assert.throws(() => economic.economicInventorySchema.parse(invalid))
  }
})
function localEnv(genesisHash) {
  return { NODE_ENV: 'development', HOOK_LOCAL_ACCEPTANCE: 'true', HOOK_LOCAL_SELECTED_HOOKS_ENABLED: 'true',
    HOOK_LOCAL_ACCEPTANCE_GENESIS: genesisHash, HOOK_WALLET_IDENTITY_ORIGIN: 'https://localhost:8000',
    HOOK_WALLET_IDENTITY_DATABASE_URL: 'postgres://localhost/hooks_local_economic',
    HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY: 'https://localhost:8001', HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY: 'https://localhost:8002' }
}
function fixture() {
  const f = selectedLaunchCollectorFixture(), d = JSON.parse(f.dossierJson), env = localEnv('11111111111111111111111111111111')
  f.p.genesisHash = env.HOOK_LOCAL_ACCEPTANCE_GENESIS; d.genesisHash = f.p.genesisHash
  f.p.schema = 'hook-lab/local-inclusive-max-wallet-builder-profile/1'
  f.profile.json = JSON.stringify(f.p); f.config.profileSha256 = sha(f.profile.json); f.profile.expectedSha256 = f.config.profileSha256
  d.artifacts.profileSha256 = f.config.profileSha256
  d.schema = 'repoing/local-validator-observation/1'; d.topology = 'single-local-validator-two-proxies'
  for (const a of d.accounts.filter(a => ['launch-config', 'swap-config'].includes(a.role))) Object.assign(a, {
    binding: 'config-counters-v1', approvedDataBase64: f.accounts.get(a.address).dataBase64, idlSha256: f.p.idlSha256[a.role.split('-')[0]] })
  f.dossierJson = JSON.stringify(d); f.config.dossierSha256 = sha(f.dossierJson)
  f.config.providerTrustDomains.forEach((p, i) => { p.origin = `${env[i ? 'HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY' : 'HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY']}/`; p.trustDomain = 'single-local-validator'; f.connections[i].connection.rpcEndpoint = p.origin })
  delete f.config.selectedHookPin
  delete f.config.selectedHookRelease
  return { f, env }
}
test('economic bundle adopts local-only policy release without singleton or fabricated independent readers', () => {
  const { f, env } = fixture()
  const bundle = economic.localEconomicPolicyBundle(f)
  assert.equal(bundle.config.selectedHookPin, undefined)
  assert.equal(bundle.config.selectedHookRelease.schema, 'repoing/selected-hook-release/2')
  assert.equal(bundle.config.selectedHookRelease.profileSha256, f.config.profileSha256)
  assert.equal(bundle.config.selectedHookRelease.dossierSha256, sha(f.dossierJson))
  assert.deepEqual(bundle.config.providerTrustDomains, f.config.providerTrustDomains)
  assert.equal(f.config.selectedHookRelease, undefined, 'do not mutate collected input')
  const settings = selectedHookSettings({ env, stack: bundle, open: true, connections: f.connections })
  assert.equal(settings.selectedHooksEnabled, true)
  assert.equal(settings.selectedHookPin, null)
  assert.deepEqual(settings.selectedHookRelease, bundle.config.selectedHookRelease)
  for (const changes of [{ HOOK_LOCAL_ACCEPTANCE: 'false' }, { NODE_ENV: 'production' }, { HOOK_LOCAL_ACCEPTANCE_GENESIS: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }, { HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY: 'https://remote.invalid' }, { HOOK_SELECTED_HOOKS_ENABLED: 'true' }, { HOOK_LOCAL_SELECTED_HOOK_PIN_JSON: '{}' }]) {
    assert.throws(() => selectedHookSettings({ env: { ...env, ...changes }, stack: bundle, open: true, connections: f.connections }))
  }
  bundle.config.selectedHookRelease.dossierSha256 = '0'.repeat(64)
  assert.throws(() => selectedHookSettings({ env, stack: bundle, open: true, connections: f.connections }))
})
test('local policy wrapper refuses production dossiers and singleton pin injection', () => {
  const { f } = fixture()
  f.config.selectedHookPin = { program: f.request.selectedHook.program }
  assert.throws(() => economic.localEconomicPolicyBundle(f))
  delete f.config.selectedHookPin
  const d = JSON.parse(f.dossierJson); d.schema = 'repoing/production-observation/2'; f.dossierJson = JSON.stringify(d)
  assert.throws(() => economic.localEconomicPolicyBundle(f))
})
test('collector accepts the explicitly enabled local policy without admitting it in production', () => {
  const { f, env } = fixture(), bundle = economic.localEconomicPolicyBundle(f), before = { ...process.env }
  try {
    Object.assign(process.env, env)
    const bound = validateSelectedHookReleaseBindings(bundle)
    assert.equal(bound.dossier.topology, 'single-local-validator-two-proxies')
    process.env.NODE_ENV = 'production'
    assert.throws(() => validateSelectedHookReleaseBindings(bundle))
    process.env.NODE_ENV = 'development'; process.env.HOOK_LOCAL_ACCEPTANCE = 'false'
    assert.throws(() => validateSelectedHookReleaseBindings(bundle))
  } finally {
    for (const key of Object.keys(env)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] }
  }
})
test('local policy refuses drift, relabeling, missing stable config pins and false trust claims', () => {
  for (const mutate of [
    b => { b.config.selectedHookRelease.profileSha256 = '0'.repeat(64) },
    b => { b.config.selectedHookRelease.sourceCommit = '0'.repeat(40) },
    b => { b.config.selectedHookPin = {} },
    b => { b.config.providerTrustDomains[1].trustDomain = 'pretend-independent' },
    b => { b.connections[1].provider = b.connections[0].provider },
    b => { b.connections[1].connection.rpcEndpoint += '?override=1' },
    b => { const d = JSON.parse(b.dossierJson); delete d.topology; b.dossierJson = JSON.stringify(d) },
    b => { const d = JSON.parse(b.dossierJson); delete d.accounts.find(a => a.role === 'launch-config').binding; b.dossierJson = JSON.stringify(d); b.config.dossierSha256 = sha(b.dossierJson); b.config.selectedHookRelease.dossierSha256 = sha(b.dossierJson) },
  ]) {
    const { f, env } = fixture(), bundle = economic.localEconomicPolicyBundle(f)
    mutate(bundle)
    assert.throws(() => selectedHookSettings({ env, stack: bundle, open: true, connections: bundle.connections }))
  }
})
