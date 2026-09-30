import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'

const MAX_BYTES = 40 * 1024

test('every /parts illustration the browse page references ships as a small WebP', () => {
  const source = readFileSync('app/components/parts-browse.jsx', 'utf8')
  const refs = [...new Set(source.match(/\/parts\/[a-z-]+\.webp/g))]
  assert.ok(refs.includes('/parts/empty-cat-box.webp'))
  assert.equal(refs.length, 5)
  for (const ref of refs) {
    const file = `public${ref}`
    const bytes = readFileSync(file)
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP', ref)
    assert.ok(statSync(file).size < MAX_BYTES, `${ref} is ${statSync(file).size} bytes`)
  }
})
