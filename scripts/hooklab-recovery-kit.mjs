#!/usr/bin/env node
// Hook Lab encrypted recovery kit. Self-contained (Node built-ins only) so the verify step can run
// on a separate Mac with just this file and the kit.
//
// Create (on the owner's Mac; keys arrive through the frozen key pipes, one Keychain prompt each):
//   ~/Documents/ChatGPT/hooks-local-state/keyserve/with-custody-keys.sh \
//     "auth=$C/production-upgrade-authority-v1/material/primary:production-upgrade-authority" ... \
//     -- node hooklab-recovery-kit.mjs create --out /Volumes/Untitled/hooklab-recovery.kit \
//          --key production-upgrade-authority='{auth}' --key hook-gate='{gate}' ...
// Verify (anywhere; prints only public addresses):
//   node hooklab-recovery-kit.mjs verify --kit /Volumes/Untitled/hooklab-recovery.kit
//
// The passphrase is typed (hidden) and never written anywhere. Secrets are never printed.
// Encryption: scrypt(N=2^17,r=8,p=1) -> AES-256-GCM, with the public header as associated data.
import { createCipheriv,createDecipheriv,createPrivateKey,createPublicKey,randomBytes,scryptSync } from 'node:crypto'
import { existsSync,readFileSync,writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

export const KIT_SCHEMA='repoing/hooklab-recovery-kit/1'
// Production roles and their public addresses. A kit may hold any subset; every entry must match.
export const EXPECTED=Object.freeze({
 'production-upgrade-authority':'9GCfczwLVfyGTE4RRrEHbGqSdHGD35U3Z5ifo7YEN1md',
 'hook-gate':'BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb',
 'owner-admin':'DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5',
 'backup-pause':'CT4SioSvVFHcnuJbJMfcVgdR3GHAyK7VmrjvR6y3RmEY',
 'treasury':'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i',
 'operational-payer':'3eCFwDiKetHe9pg1zNEkTohUECu2vtsZDRMZ3jeR4g5o',
 'launch-program':'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft',
 'swap-program':'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk',
})
const SCRYPT={N:2**17,r:8,p:1,maxmem:256*1024*1024}
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const fail=message=>{throw Object.assign(Error(message),{code:'RECOVERY_KIT'})}

export function base58(bytes){
 let n=BigInt('0x'+(Buffer.from(bytes).toString('hex')||'0')),out=''
 while(n>0n){out=ALPHABET[Number(n%58n)]+out;n/=58n}
 for(const b of bytes){if(b!==0)break;out='1'+out}
 return out
}
// Public address derived from the 32-byte seed alone (never trusts the stored public half).
export function addressFromSeed(seed){
 const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(seed)]),format:'der',type:'pkcs8'})
 return base58(createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32))
}
function checkedEntry(role,keypair,expected){
 if(!Array.isArray(keypair)||keypair.length!==64||!keypair.every(b=>Number.isInteger(b)&&b>=0&&b<=255))fail(`${role}: not a 64-byte Solana keypair`)
 const address=addressFromSeed(keypair.slice(0,32))
 if(address!==base58(keypair.slice(32)))fail(`${role}: keypair halves disagree`)
 if(expected[role]!==undefined&&expected[role]!==address)fail(`${role}: derives ${address}, expected ${expected[role]}`)
 if(expected[role]===undefined)fail(`${role}: not a known production role`)
 return {role,address}
}
const header=kit=>Buffer.from(JSON.stringify({schema:kit.schema,createdAt:kit.createdAt,kdf:kit.kdf,entries:kit.entries}))

export function createKit({entries,passphrase,expected=EXPECTED,createdAt=new Date().toISOString(),scrypt=SCRYPT}){
 if(typeof passphrase!=='string'||passphrase.length<16)fail('Passphrase must be at least 16 characters')
 if(!entries.length||new Set(entries.map(e=>e.role)).size!==entries.length)fail('Kit needs distinct roles')
 const publicEntries=entries.map(({role,keypair})=>checkedEntry(role,keypair,expected))
 const salt=randomBytes(16),nonce=randomBytes(12)
 const kit={schema:KIT_SCHEMA,createdAt,kdf:{name:'scrypt',N:scrypt.N,r:scrypt.r,p:scrypt.p,salt:salt.toString('base64')},entries:publicEntries}
 const key=scryptSync(passphrase.normalize('NFKC'),salt,32,scrypt)
 const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(header(kit))
 const plaintext=Buffer.from(JSON.stringify(entries.map(({role,keypair})=>({role,keypair}))))
 const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);plaintext.fill(0);key.fill(0)
 return {...kit,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')}
}

// Decrypts the kit in memory: [{role,keypair}]. The caller must zero every keypair when done.
export function openKit({kit,passphrase}){
 if(kit?.schema!==KIT_SCHEMA||kit.kdf?.name!=='scrypt')fail('Not a Hook Lab recovery kit')
 const {N,r,p}=kit.kdf,key=scryptSync(passphrase.normalize('NFKC'),Buffer.from(kit.kdf.salt,'base64'),32,{N,r,p,maxmem:SCRYPT.maxmem})
 let plaintext
 try{
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(kit.nonce,'base64'));decipher.setAAD(header(kit));decipher.setAuthTag(Buffer.from(kit.tag,'base64'))
  plaintext=Buffer.concat([decipher.update(Buffer.from(kit.ciphertext,'base64')),decipher.final()])
 }catch{fail('Wrong passphrase or the kit was modified')}finally{key.fill(0)}
 try{
  const secret=JSON.parse(plaintext)
  if(secret.length!==kit.entries.length)fail('Kit entry count differs from its header')
  return secret
 }finally{plaintext.fill(0)}
}

// Returns only public results: [{role,address,matchesHeader,matchesExpected}]
export function verifyKit({kit,passphrase,expected=EXPECTED}){
 return openKit({kit,passphrase}).map(({role,keypair},i)=>{
  const address=addressFromSeed(keypair.slice(0,32));keypair.fill(0)
  return {role,address,matchesHeader:kit.entries[i].role===role&&kit.entries[i].address===address,matchesExpected:expected[role]===address}
 })
}

async function hiddenPrompt(question){
 if(!process.stdin.isTTY)fail('Run this in a terminal so the passphrase can be typed hidden')
 process.stdout.write(question);process.stdin.setRawMode(true);process.stdin.resume()
 return new Promise((resolve,reject)=>{let value='';const onData=chunk=>{for(const char of chunk.toString('utf8')){
  if(char==='\r'||char==='\n'){process.stdin.setRawMode(false);process.stdin.pause();process.stdin.off('data',onData);process.stdout.write('\n');return resolve(value)}
  if(char==='\u0003'){process.stdin.setRawMode(false);return reject(fail('Cancelled'))}
  if(char==='\u007f')value=value.slice(0,-1);else value+=char}};process.stdin.on('data',onData)})
}
function report(results){
 for(const r of results)console.log(`${r.matchesHeader&&r.matchesExpected?'PASS':'FAIL'} ${r.role.padEnd(30)} ${r.address}`)
 const ok=results.every(r=>r.matchesHeader&&r.matchesExpected);console.log(ok?`ALL ${results.length} ADDRESSES MATCH`:'MISMATCH: do not rely on this kit');return ok
}

async function main(){
 const [command,...rest]=process.argv.slice(2)
 const {values}=parseArgs({args:rest,options:{out:{type:'string'},kit:{type:'string'},key:{type:'string',multiple:true}}})
 if(command==='create'){
  if(!values.out||!values.key?.length)fail('usage: create --out FILE --key ROLE=PATH [--key ROLE=PATH ...]')
  if(existsSync(values.out))fail('Refusing to overwrite an existing kit')
  const entries=values.key.map(spec=>{const i=spec.indexOf('=');return {role:spec.slice(0,i),keypair:JSON.parse(readFileSync(spec.slice(i+1),'utf8'))}})
  const passphrase=await hiddenPrompt('New kit passphrase (16+ characters, write it down offline): ')
  if(passphrase!==await hiddenPrompt('Type it again: '))fail('Passphrases differ')
  const kit=createKit({entries,passphrase});for(const e of entries)e.keypair.fill(0)
  writeFileSync(values.out,JSON.stringify(kit,null,1),{flag:'wx',mode:0o600})
  console.log(`Wrote ${values.out}. Re-opening it to verify:`)
  if(!report(verifyKit({kit:JSON.parse(readFileSync(values.out,'utf8')),passphrase})))process.exit(1)
  console.log('Keep your original backups until this kit is verified on a separate computer.')
 }else if(command==='verify'){
  if(!values.kit)fail('usage: verify --kit FILE')
  const kit=JSON.parse(readFileSync(values.kit,'utf8'))
  console.log(`Kit created ${kit.createdAt}, ${kit.entries.length} roles.`)
  if(!report(verifyKit({kit,passphrase:await hiddenPrompt('Kit passphrase: ')})))process.exit(1)
 }else fail('usage: create ... | verify --kit FILE')
}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(error.code==='RECOVERY_KIT'?error.message:'Recovery kit operation failed');process.exit(2)})
