import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { HF_DISCLAIMER, HF_DISCLAIMER_BADGE, HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'

test('the disclaimer copy is exact and the short variant keeps both halves of it', () => {
  assert.equal(HF_DISCLAIMER, "Community launch — not endorsed by the model's creators. Not affiliated with Hugging Face.")
  assert.equal(HF_DISCLAIMER_BADGE, 'Community launch')
  assert.equal(HF_DISCLAIMER_SHORT, 'Community launch · Not endorsed by the creators · Not affiliated with Hugging Face')
})

test('the copy and URL modules stay dependency-free so client components can import them', () => {
  for (const file of ['src/hf-copy.mjs', 'src/hf-url.mjs']) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /^\s*import\b|\brequire\(/m, file)
  }
})
