// Synthetic keys only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { createKit,verifyKit,addressFromSeed,base58 } from '../scripts/hooklab-recovery-kit.mjs'

const synthetic=label=>Keypair.fromSeed(createHash('sha256').update(`RECOVERY KIT TEST ONLY ${label}`).digest())
const a=synthetic('a'),b=synthetic('b')
const expected={'role-a':a.publicKey.toBase58(),'role-b':b.publicKey.toBase58()}
const entries=()=>[{role:'role-a',keypair:[...a.secretKey]},{role:'role-b',keypair:[...b.secretKey]}]
const fast={N:2**10,r:8,p:1,maxmem:64*1024*1024},passphrase='correct horse battery staple'

test('address derivation and base58 match the Solana library',()=>{
 assert.equal(addressFromSeed([...a.secretKey.subarray(0,32)]),a.publicKey.toBase58())
 assert.equal(base58(Uint8Array.from([0,0,1])),'112')
})

test('a kit holds no plaintext secret, round-trips to the exact addresses, and refuses wrong inputs',()=>{
 const kit=createKit({entries:entries(),passphrase,expected,scrypt:fast})
 const text=JSON.stringify(kit)
 assert.ok(!text.includes(JSON.stringify([...a.secretKey].slice(0,8)).slice(1,-1)),'no keypair bytes in the kit')
 assert.deepEqual(kit.entries,[{role:'role-a',address:expected['role-a']},{role:'role-b',address:expected['role-b']}])
 const results=verifyKit({kit,passphrase,expected})
 assert.ok(results.every(r=>r.matchesHeader&&r.matchesExpected))
 assert.ok(!JSON.stringify(results).includes('keypair'),'verify returns public results only')
 assert.throws(()=>verifyKit({kit,passphrase:'wrong passphrase entirely',expected}),/Wrong passphrase or the kit was modified/)
 const relabeled=structuredClone(kit);relabeled.entries[0].address=expected['role-b']
 assert.throws(()=>verifyKit({kit:relabeled,passphrase,expected}),/Wrong passphrase or the kit was modified/,'header is authenticated')
 const flipped=structuredClone(kit),bytes=Buffer.from(flipped.ciphertext,'base64');bytes[3]^=1;flipped.ciphertext=bytes.toString('base64')
 assert.throws(()=>verifyKit({kit:flipped,passphrase,expected}),/Wrong passphrase or the kit was modified/)
 assert.ok(verifyKit({kit,passphrase,expected:{...expected,'role-a':expected['role-b']}}).some(r=>!r.matchesExpected),'a wrong expected address is reported, not hidden')
})

test('creation refuses short passphrases, unknown roles, mismatched keys and duplicates',()=>{
 assert.throws(()=>createKit({entries:entries(),passphrase:'short',expected,scrypt:fast}),/at least 16/)
 assert.throws(()=>createKit({entries:[{role:'unknown',keypair:[...a.secretKey]}],passphrase,expected,scrypt:fast}),/not a known production role/)
 assert.throws(()=>createKit({entries:[{role:'role-a',keypair:[...b.secretKey]}],passphrase,expected,scrypt:fast}),/expected/)
 const tampered=[...a.secretKey];tampered[40]^=1
 assert.throws(()=>createKit({entries:[{role:'role-a',keypair:tampered}],passphrase,expected,scrypt:fast}),/halves disagree/)
 assert.throws(()=>createKit({entries:[...entries(),{role:'role-a',keypair:[...a.secretKey]}],passphrase,expected,scrypt:fast}),/distinct roles/)
})
