// Creates only disposable local validator state and local PostgreSQL schemas.
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import BN from 'bn.js'
import pg from 'pg'
import { AddressLookupTableProgram, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js'
import { localArtifacts, localKey, localConnection, assertLocalChain, sendLocal, localInstruction, pda, pk, sha, loader, stateDirectory } from './hooks-local-common.mjs'
const state=stateDirectory(),bundle=await localArtifacts(),connection=localConnection(),genesis=await assertLocalChain(connection)
if(await connection.getSlot('finalized')===0)throw Error('Wait for the first finalized local slot before initialization; no funding was submitted')
const roles=Object.fromEntries(['wallet','admin','upgrade','guardian','collector'].map(role=>[role,localKey(role)]))
const addresses=Object.fromEntries(Object.entries(roles).map(([role,key])=>[role,key.publicKey.toBase58()]))
const receipts=[]
const send=async(label,instructions,signers)=>{const signature=await sendLocal(connection,instructions,signers,genesis);receipts.push({label,signature});console.log(label,signature)}
for(const role of ['swap','launch'])if(await connection.getAccountInfo(pk(pda(bundle.profile.programs[role],'config')),'finalized'))throw Error('Local config already initialized; preserve this ledger instead of funding or initializing again')
// Fund synthetic role accounts from the synthetic genesis wallet; never a production payer.
await send('local-role-funding',Object.values(roles).filter(key=>key!==roles.wallet).map(key=>SystemProgram.transfer({fromPubkey:roles.wallet.publicKey,toPubkey:key.publicKey,lamports:10000000000})),[roles.wallet])
const retained=JSON.parse(await readFile(`${state}/build-inputs/accounts.json`,'utf8'))
const configRaw=role=>Buffer.from(retained.accounts.find(a=>a.role===`${role}_config`).dataBase64,'base64')
for(const role of ['swap','launch']){
 const old=bundle.coders[role].accounts.decode('Config',configRaw(role))
 const args=role==='swap'?{admin:roles.admin.publicKey,treasury:roles.collector.publicKey,fee_collector:roles.collector.publicKey,
  protocol_fee_bps:0,pool_creation_fee_lamports:new BN(0),paused:true,launch_protocol_share_bps:2500}
 :{...old,admin:roles.admin.publicKey,treasury:roles.collector.publicKey,quote_mint:pk(bundle.profile.quoteMint),
   launch_fee_lamports:new BN(0),lp_fee_bps:0,max_creator_fee_bps:100,sniper_window_secs:new BN(0),sniper_start_bps:0,
   paused:true,rule_bounds:{...old.rule_bounds,max_rules_fee_bps:100}}
 await send(`${role}-initialize-config`,[localInstruction(bundle,role,'init_config',{args},{authority:addresses.upgrade})],[roles.upgrade])
 await send(`${role}-initialize-governance`,[localInstruction(bundle,role,'init_governance',{args:{genesis:[...pk(genesis).toBuffer()],guardian:roles.guardian.publicKey,
  custody_digest:[...createHash('sha256').update('disposable LOCAL custody only').digest()]}},{admin:addresses.admin,payer:addresses.wallet})],[roles.wallet,roles.admin])
 const governance=bundle.coders[role].accounts.decode('Governance',(await connection.getAccountInfo(pk(pda(bundle.profile.programs[role],'governance')),'finalized')).data)
 const expected=[...createHash('sha256').update('hook-lab/governance-state/1\0').update(bundle.coders[role].types.encode('State',governance.state)).digest()]
 await send(`${role}-open-LOCAL-test-gates`,[localInstruction(bundle,role,'governance_action',{expected,action:{SetGates:[{creation:false,trading:false}]}},{authority:addresses.admin})],[roles.admin])
}
const L=bundle.profile.programs.launch
const launchGov=bundle.coders.launch.accounts.decode('Governance',(await connection.getAccountInfo(pk(pda(L,'governance')),'finalized')).data)
const commitment=[...createHash('sha256').update('hook-lab/governance-state/1\0').update(bundle.coders.launch.types.encode('State',launchGov.state)).digest()]
await send('authorize-LOCAL-synthetic-creator',[localInstruction(bundle,'launch','init_creator_authorization',{creator:roles.wallet.publicKey,
 args:{enabled:true,expires_at_slot:new BN('18446744073709551615'),max_launches:new BN(1000)},expected_governance:commitment},
 {admin:addresses.admin,payer:addresses.wallet,authorization:pda(L,'creator-authorization',roles.wallet.publicKey.toBuffer())})],[roles.wallet,roles.admin])
// A real address lookup table, not an injected ALT snapshot.
const slotHashes=(await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY,'finalized'))?.data
if(!slotHashes||slotHashes.readBigUInt64LE(0)===0n)throw Error('A real finalized slot-hash ancestor is required for ALT creation')
const recentSlot=Number(slotHashes.readBigUInt64LE(8))
if(!Number.isSafeInteger(recentSlot))throw Error('Local ALT slot exceeds the exact integer boundary')
const [createTable,table]=AddressLookupTableProgram.createLookupTable({authority:roles.wallet.publicKey,payer:roles.wallet.publicKey,recentSlot})
await send('local-lookup-table-create',[createTable],[roles.wallet])
const inventory=[...new Set([...Object.values(bundle.profile.programs),bundle.profile.quoteMint,
 ...['launch','swap','gate','token'].flatMap(role=>{const program=bundle.profile.programs[role];return [pda(loader,pk(program).toBuffer()),pda(program,'__event_authority')]}),
 ...['launch','swap'].flatMap(role=>[pda(bundle.profile.programs[role],'config'),pda(bundle.profile.programs[role],'governance')]),
 pda(L,'creator-authorization',roles.wallet.publicKey.toBuffer()),pda(L,'hook-authority'),pda(bundle.profile.programs.swap,'hook-authority',pk(L).toBuffer()),
 pda(bundle.profile.programs.token,'hook-authority',pk(bundle.profile.programs.gate).toBuffer()),'11111111111111111111111111111111'])].map(pk)
for(let i=0;i<inventory.length;i+=20)await send('local-lookup-table-extend',[AddressLookupTableProgram.extendLookupTable({authority:roles.wallet.publicKey,payer:roles.wallet.publicKey,lookupTable:table,addresses:inventory.slice(i,i+20)})],[roles.wallet])
const databaseName=`hooks_local_${genesis.slice(0,12).toLowerCase()}`,databaseUrl=`postgresql://postgres@127.0.0.1:55432/${databaseName}`
const administrator=new pg.Client({connectionString:'postgresql://postgres@127.0.0.1:55432/postgres'})
try{await administrator.connect();await administrator.query(`CREATE DATABASE "${databaseName}" ENCODING 'UTF8' TEMPLATE template0`)}
finally{await administrator.end()}
const pool=new pg.Pool({connectionString:databaseUrl})
const schemas=['hooklab-wallet-principal-schema.sql','hooklab-wallet-preparation-schema.sql','hooklab-native-signer-custody-schema.sql','hooklab-new-mint-preparation-schema.sql',
 'hooklab-native-signing-schema.sql','hooklab-native-signing-attempt-schema.sql','hooklab-native-signing-context-schema.sql','hooklab-native-signing-refresh-schema.sql',
 'hooklab-native-launch-context-schema.sql','hooklab-native-signing-trade-schema.sql','hooklab-native-signing-wallet-request-schema.sql','hooklab-wallet-identity-quota-schema.sql','hooklab-local-signing-schema.sql']
const db=await pool.connect()
try{await db.query('begin');for(const file of schemas)await db.query(await readFile(new URL(`../src/${file}`,import.meta.url),'utf8'));await db.query('commit')}
catch(error){await db.query('rollback');throw error}finally{db.release();await pool.end()}
let custodyFile
try{custodyFile=await lstat(`${state}/local-custody-key.bin`)}catch(error){if(error.code!=='ENOENT')throw error}
if(custodyFile){if(!custodyFile.isFile()||custodyFile.size!==32||custodyFile.uid!==process.getuid()||(custodyFile.mode&0o077)!==0)throw Error('Existing disposable custody key must be a private owner-only 32-byte file')}
else await writeFile(`${state}/local-custody-key.bin`,randomBytes(32),{mode:0o600,flag:'wx'})
await writeFile(`${state}/local-chain.public.json`,JSON.stringify({scope:'disposable-local-validator-only',genesisHash:genesis,roles:addresses,lookupTable:table.toBase58(),
 databaseUrl,feeModel:{creatorFeeBps:100,protocolShareBps:2500,platformRule:'floor(gross creator fee / 4)',creatorRule:'gross - platform',surchargeBps:0},receipts},null,2),{mode:0o600,flag:'wx'})
console.log('Local protocol initialization finalized; public bindings retained. No production state was touched.')
