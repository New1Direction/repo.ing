import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import { swapAccountEvidence } from '../src/hooklab-inclusive-max-wallet-swap.mjs'

// 2026-10-27: AcceptAdmin cleared each Hook governance's pending nomination (Some -> None encodes 40 bytes shorter) and the
// programs left the old candidate and expiry after the data. The strict decoder then refused both governances, so every Hooks
// trade and launch review was refused. Exactly that remnant is accepted; any other trailing byte still refuses.
const bundle = JSON.parse(readFileSync(new URL('../config/hooklab-stack-bundle.json', import.meta.url)))
const fixture = JSON.parse(readFileSync(new URL('./fixtures/hooklab-governance-cleared-nomination.json', import.meta.url)))
const binding = role => { const idl = JSON.parse(Buffer.from(bundle.profile.idls[role], 'base64')); return { idl, coder: new BorshCoder(idl) } }
const { decoded } = swapAccountEvidence

for (const role of ['launch', 'swap']) test(`the live ${role} governance decodes despite its cleared nomination's 40 stale bytes`, () => {
  const bytes = Buffer.from(fixture.accounts[role].dataBase64, 'base64')
  const value = decoded(binding(role), 'Governance', bytes)
  assert.equal(value.state.pending_admin, null)
  assert.equal(value.state.roles.admin.toBase58(), '3dHCTpgdx15yXyVGh7DK1woQ1XisQpmFCxncURrq63Gs')
})

test('any other trailing bytes are still refused', () => {
  const bytes = Buffer.from(fixture.accounts.swap.dataBase64, 'base64')
  const longer = Buffer.concat([bytes, Buffer.from([1])])
  assert.throws(() => decoded(binding('swap'), 'Governance', longer), /Noncanonical/)
  const value = binding('swap').coder.accounts.decode('Governance', bytes)
  const encodedLength = binding('swap').coder.types.encode('Governance', value).length
  const shortTail = Buffer.concat([bytes.subarray(0, 8 + encodedLength), Buffer.alloc(39, 7)])
  assert.throws(() => decoded(binding('swap'), 'Governance', shortTail), /Noncanonical/)
})
