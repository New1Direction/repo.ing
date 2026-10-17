import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { nativeSignerCustodyCodec,verifyNativeAdminSignerIdentity } from '../src/hooklab-native-signer-custody.mjs'
const key=n=>Keypair.fromSeed(Buffer.alloc(32,n)),signers=()=>({mint:key(2),selectedConfig:key(3)})
const identity={schema:'repoing/native-signer-custody/1',operationId:randomUUID(),custodySessionId:randomUUID(),owner:key(1).publicKey.toBase58(),profileSha256:'a'.repeat(64),mint:key(2).publicKey.toBase58(),selectedConfig:key(3).publicKey.toBase58(),stage:'reserved'}
const ring={test_v1:Buffer.alloc(32,7),test_v2:Buffer.alloc(32,8)},codec=()=>nativeSignerCustodyCodec({enabled:true,keyRing:ring,activeKeyId:'test_v1'})
test('strict opt-in AES-GCM seals both signer keys with fresh IVs and no plaintext envelope',()=>{
 const c=codec(),one=c.seal(identity,signers()),two=c.seal(identity,signers());assert.notEqual(one.iv,two.iv);assert.notEqual(one.ciphertext,two.ciphertext)
 const restored=c.open(identity,one);assert.equal(restored.mint.publicKey.toBase58(),identity.mint);assert.equal(restored.selectedConfig.publicKey.toBase58(),identity.selectedConfig)
 for(const value of Object.values(signers()))assert.ok(!JSON.stringify(one).includes(Buffer.from(value.secretKey).toString('base64')))
 assert.throws(()=>nativeSignerCustodyCodec({keyRing:ring,activeKeyId:'test_v1'}).seal(identity,signers()),/custody unavailable/)
})
test('owner/profile/stage/session/operation/mint/config and ciphertext/key/tag/IV mutations fail with redacted errors',()=>{
 const c=codec(),sealed=c.seal(identity,signers())
 for(const change of [{owner:key(4).publicKey.toBase58()},{profileSha256:'b'.repeat(64)},{stage:'preparation-reviewed'},{custodySessionId:randomUUID()},{operationId:randomUUID()},{mint:key(4).publicKey.toBase58()},{selectedConfig:key(4).publicKey.toBase58()}])assert.throws(()=>c.open({...identity,...change},sealed),error=>error.code==='NATIVE_CUSTODY_UNAVAILABLE'&&error.message==='Native signer custody unavailable or changed')
 for(const change of [{keyId:'missing'},{keyId:'test_v2'},{iv:Buffer.alloc(12).toString('base64')},{tag:Buffer.alloc(16).toString('base64')},{ciphertext:Buffer.alloc(128).toString('base64')},{extra:true}])assert.throws(()=>c.open(identity,{...sealed,...change}),/custody unavailable/)
})
test('explicit key rotation changes envelope key/nonce and old-key-only reader cannot open new record',()=>{
 const old=codec(),sealed=old.seal(identity,signers()),next=nativeSignerCustodyCodec({enabled:true,keyRing:ring,activeKeyId:'test_v2'}),rotated=next.rotate(identity,sealed)
 assert.equal(rotated.keyId,'test_v2');assert.notEqual(rotated.iv,sealed.iv);assert.equal(next.open(identity,rotated).mint.publicKey.toBase58(),identity.mint)
 assert.throws(()=>nativeSignerCustodyCodec({enabled:true,keyRing:{test_v1:ring.test_v1},activeKeyId:'test_v1'}).open(identity,rotated))
 assert.equal(old.open(identity,sealed).mint.publicKey.toBase58(),identity.mint)
})
test('launch admin must be separately configured, exact observed signer and nonaliased',()=>{
 const fields={configuredAdmin:key(4).publicKey.toBase58(),observedAdmin:key(4).publicKey.toBase58(),owner:identity.owner,mint:identity.mint,selectedConfig:identity.selectedConfig}
 assert.equal(verifyNativeAdminSignerIdentity(fields).canSign,false)
 for(const change of [{configuredAdmin:key(5).publicKey.toBase58()},{configuredAdmin:undefined},{configuredAdmin:identity.owner,observedAdmin:identity.owner}])assert.throws(()=>verifyNativeAdminSignerIdentity({...fields,...change}))
})
