import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { nativePinned } from './fixtures/hooklab-native-bundle.mjs'

test('native runtime admits catalog-policy quotes without a singleton only when explicitly enabled', async t => {
  t.mock.module('../src/hooklab-native-trade-resolver.mjs', { namedExports: {
    nativeTradeResolver: ({ selectedNativeTradingEnabled }) => ({
      estimate: async () => {
        if (!selectedNativeTradingEnabled) throw Error('selected trading closed')
        return { quote: { delivered: '97' }, canSign: false, canSubmit: false }
      },
    }),
  } })
  const { createInclusiveTradeRuntime } = await import('../app/lib/hooklab-inclusive-trade-runtime.mjs')
  const bundle = nativePinned(JSON.parse(readFileSync(new URL('../config/hooklab-production-bundle-2.json', import.meta.url))))
  const policyRelease = { schema: 'repoing/selected-hook-release/2', approvalReference: 'synthetic policy',
    sourceCommit: JSON.parse(bundle.profile.json).sourceCommit, profileSha256: bundle.config.profileSha256,
    dossierSha256: bundle.config.dossierSha256, acceptanceSha256: 'a'.repeat(64), releaseVerificationSha256: 'b'.repeat(64),
    compatibilityPolicy: { schema: 'repoing/selected-hook-compatibility/2', referenceCommit: '7fde54001d7f0c88b17c87babf73fb40be07b3cb',
      abi: { family: 'bordrless-token-hook-v1', tokenFlagsMask: 255, registryVersion: 1, registryDiscriminator: '02daf6662c38c0cd', maxRegistryExtras: 32, allowExtraSigners: false },
      authority: { immutable: true, timelock: { program: 'BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ', minDelaySeconds: 259200, requireIdle: true }, trustedUpgradeAuthorities: [] } } }
  const settings = { ...bundle, origin: 'https://repo.ing', ownerTradingApproved: true, operatorDeploymentApproved: true,
    economicsApproved: true, nativeTradingEnabled: true, limits: { maxAgeMs: 60000, maxSlotLag: 16 },
    connections: bundle.profile.providers.map((provider, i) => ({ provider, connection: {
      rpcEndpoint: `${bundle.config.providerTrustDomains[i].origin}rpc`,
    } })) }
  // The collector owns policy/authority validation; this boundary must pass the switch through, never synthesize a pin.
  for (const release of [null, policyRelease]) {
    for (const enabled of [false, true]) {
      const runtime = createInclusiveTradeRuntime({}, { ...settings, selectedNativeTradingEnabled: enabled,
        config: { ...bundle.config, ...(release ? { selectedHookRelease: release } : {}) } })
      if (release && enabled) assert.deepEqual(await runtime.nativeEstimate({}), {
        quote: { delivered: '97' }, canSign: false, canSubmit: false,
      })
      else await assert.rejects(runtime.nativeEstimate({}), /selected trading closed/)
    }
  }
})
