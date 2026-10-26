import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { HOOK_GOVERNANCE_PROGRAMS, acceptAdminInstruction, assertHookAdminAccept } from '../src/hooklab-admin-handover.mjs'

const vault = new PublicKey('3dHCTpgdx15yXyVGh7DK1woQ1XisQpmFCxncURrq63Gs')
const config = new PublicKey('6nDeDNTsX2b6YJXoVDEYUGbYjuh79ytAVA5SSZSZ5Rvn'), governance = new PublicKey('nStGGzMSiky1JK9eQVebg3HEjnnXW6EpvW5qsFmfWPv')
const launch = new PublicKey(HOOK_GOVERNANCE_PROGRAMS.launch)
const expected = Buffer.alloc(32, 7)
const accept = () => acceptAdminInstruction({ programId: launch, authority: vault, config, governance, expected })

test('the vault may carry only AcceptAdmin, signed by the vault alone, on the Hook launch or swap program', () => {
  const ix = accept()
  assert.equal(ix.data.length, 8 + 1 + 32 + 1)
  assert.equal(ix.data[ix.data.length - 1], 4, 'Action::AcceptAdmin')
  assert.doesNotThrow(() => assertHookAdminAccept([ix], vault))
  const bad = (change, pattern) => assert.throws(() => assertHookAdminAccept([change(accept())], vault), pattern)
  bad(ix => new TransactionInstruction({ ...ix, programId: new PublicKey('11111111111111111111111111111111') }), /program/)
  bad(ix => { const data = Buffer.from(ix.data); data[data.length - 1] = 3; return new TransactionInstruction({ ...ix, data }) }, /AcceptAdmin/)
  bad(ix => { const data = Buffer.from(ix.data); data[0] ^= 1; return new TransactionInstruction({ ...ix, data }) }, /governance_action/)
  bad(ix => new TransactionInstruction({ ...ix, data: Buffer.concat([ix.data, Buffer.from([0])]) }), /AcceptAdmin/)
  bad(ix => new TransactionInstruction({ ...ix, keys: [{ ...ix.keys[0], pubkey: config }, ...ix.keys.slice(1)] }), /vault/)
  bad(ix => new TransactionInstruction({ ...ix, keys: ix.keys.map((k, i) => i === 1 ? { ...k, isSigner: true } : k) }), /signer/)
  assert.throws(() => assertHookAdminAccept([], vault), /one to two/)
  assert.throws(() => assertHookAdminAccept([accept(), accept(), accept()], vault), /one to two/)
})
