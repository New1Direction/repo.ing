import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { ART, artSource } from '../app/lib/art.mjs'

const MAX_BYTES = 35 * 1024
const USERS = ['app/components/waiting-board.jsx', 'app/components/wallet-overview.jsx', 'app/components/find-repos.jsx',
  'app/components/builder-dashboard.jsx', 'app/components/repository-flow.jsx', 'app/(site)/claim/[repo]/page.jsx']

// Width and height of a lossy (VP8) or lossless (VP8L) WebP.
function webpSize(bytes) {
  const chunk = bytes.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8 ') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
  if (chunk === 'VP8L') { const bits = bytes.readUInt32LE(21); return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1] }
  if (chunk === 'VP8X') return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1]
  throw new Error(`unknown WebP chunk ${chunk}`)
}

test('every icon-pack illustration ships as a small, square WebP of its declared size', () => {
  for (const [name, { size, background }] of Object.entries(ART)) {
    const file = `public${artSource(name)}`
    const bytes = readFileSync(file)
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', name)
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP', name)
    assert.ok(statSync(file).size < MAX_BYTES, `${name} is ${statSync(file).size} bytes`)
    assert.deepEqual(webpSize(bytes), [size, size], name)
    assert.match(background, /^#[0-9a-f]{6}$/, name)
  }
})

test('public/art holds only illustrations the UI references, and every reference is known', () => {
  const source = USERS.map(file => readFileSync(file, 'utf8')).join('\n')
  const referenced = new Set([...source.matchAll(/'([a-z0-9-]+)'/g), ...source.matchAll(/name="([a-z0-9-]+)"/g)]
    .map(match => match[1]).filter(name => name in ART))
  assert.deepEqual([...referenced].sort(), Object.keys(ART).sort())
  for (const match of source.matchAll(/name="([a-z0-9-]+)"/g)) assert.ok(match[1] in ART, `unknown art ${match[1]}`)
  assert.deepEqual(readdirSync('public/art').sort(), Object.keys(ART).map(name => `${name}.webp`).sort())
})
