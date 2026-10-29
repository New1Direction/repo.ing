import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dependency = (consumer, name) => createRequire(require.resolve(consumer))(name)

test('Anchor TOML parsing accepts workspace configuration but cannot traverse scalar prototypes', () => {
  // GHSA-v5mp-jgw5-2x6j: a scalar table path reaches Object.prototype in toml 3.0.0.
  const payload = '[a.b]\ny=1\n[a.b.y.__proto__.__proto__]\nneuronSecurityProbe="polluted"\n'
  for (const consumer of ['@anchor-lang/core', '@coral-xyz/anchor']) {
    const { parse } = dependency(consumer, 'toml')
    const config = parse(Buffer.from('[provider]\ncluster="localnet"\n[programs.localnet]\nexample="11111111111111111111111111111111"\n'))
    assert.equal(config.provider.cluster, 'localnet')
    assert.equal(config.programs.localnet.example, '11111111111111111111111111111111')
    try {
      assert.throws(() => parse(payload))
      assert.equal(Object.prototype.neuronSecurityProbe, undefined)
    } finally { delete Object.prototype.neuronSecurityProbe }
  }
})

test('SPL bigint conversion preserves exact values and inputs for empty and large unaligned buffers', () => {
  const layoutRequire = createRequire(require.resolve('@solana/spl-token'))
  const conversion = createRequire(layoutRequire.resolve('@solana/buffer-layout-utils'))('bigint-buffer')
  const bytes = Buffer.alloc(1025); bytes[0] = 0x34; bytes[1] = 0x12; bytes[1024] = 1
  const original = Buffer.from(bytes), expected = (1n << 8192n) + 0x1234n
  assert.equal(conversion.toBigIntLE(bytes), expected)
  assert.deepEqual(bytes, original)
  assert.equal(conversion.toBigIntBE(Buffer.from(bytes).reverse()), expected)
  assert.deepEqual(conversion.toBufferLE(expected, 1025), original)
  assert.deepEqual(conversion.toBufferBE(expected, 1025), Buffer.from(original).reverse())
  assert.equal(conversion.toBigIntLE(Buffer.alloc(0)), 0n)
  assert.equal(conversion.toBigIntBE(Buffer.alloc(0)), 0n)
})
