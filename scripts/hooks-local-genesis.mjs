// Synthetic genesis balances only. No RPC, deployment, or production key access.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import BN from 'bn.js'
import { localArtifacts, localKey, loader, pda, pk, sha, stateDirectory } from './hooks-local-common.mjs'
const state = stateDirectory(), bundle = await localArtifacts(), { profile, coders } = bundle
const wallet = localKey('wallet').publicKey.toBase58(), treasury = localKey('collector').publicKey.toBase58()
const quote = profile.quoteMint, token = profile.programs.token, amount = new BN('10000000000000')
const encode = (name, value, size) => {
  const bytes = Buffer.concat([Buffer.from(sha(`account:${name}`), 'hex').subarray(0, 8), coders.token.types.encode(name, value)])
  if (bytes.length > size) throw Error('Genesis account size differs')
  const padded = Buffer.alloc(size); bytes.copy(padded); return padded
}
const mint = encode('Mint', { version: 1, decimals: 9, supply: amount, max_supply: amount,
  mint_authority: null, freeze_authority: null, hook_authority: null, metadata_authority: null, hook_program: null,
  hook_flags: 0, name: 'LOCAL synthetic quote', symbol: 'LOCALQ', uri: '', created_at: new BN(0), creator: pk(wallet), hook_signer_bump: 0, reserved: Array(31).fill(0) }, 519)
await mkdir(`${state}/genesis`, { recursive: true, mode: 0o700 })
async function account(name, pubkey, data, {owner=token,executable=false,lamports=1000000000}={}) {
  await writeFile(`${state}/genesis/${name}.json`, JSON.stringify({ pubkey, account: { lamports,
    data: [data.toString('base64'), 'base64'], owner, executable, rentEpoch: 0 } }), { mode: 0o600 })
}
// Agave 4.3's genesis "none" flag writes Some(default_pubkey), not None.
// Seed canonical immutable loader accounts instead; the actual ELF is hash-checked.
for(const role of ['gate','token']){
  const file=role==='gate'?'hook_max_wallet':'bordrless_token',elf=await readFile(`${state}/rebuilt-inclusive/elf/${file}.so`)
  const expected=role==='gate'?profile.elfSha256.gate:profile.dependencyObservation.tokenElfSha256
  if(sha(elf)!==expected)throw Error('Immutable genesis executable differs from reviewed build')
  const address=profile.programs[role],programData=pda(loader,pk(address).toBuffer()),program=Buffer.alloc(36),data=Buffer.alloc(45+elf.length)
  program.writeUInt32LE(2);pk(programData).toBuffer().copy(program,4)
  data.writeUInt32LE(3);elf.copy(data,45) // slot=0, canonical Option::None, 32 bytes reserved padding
  await account(`${role}-program`,address,program,{owner:loader,executable:true})
  await account(`${role}-program-data`,programData,data,{owner:loader,lamports:10000000000})
}
// Keep the interactive wallet's native balance exactly representable by the RPC/JS boundary.
await writeFile(`${state}/genesis/wallet-native.json`, JSON.stringify({ pubkey: wallet, account: { lamports: 10000000000000,
  data: ['', 'base64'], owner: '11111111111111111111111111111111', executable: false, rentEpoch: 0 } }), { mode: 0o600 })
await account('quote-mint', quote, mint)
for (const [name, owner, balance] of [['wallet-quote', wallet, amount], ['collector-quote', treasury, new BN(0)]]) {
  const [holding, bump] = (await import('@solana/web3.js')).PublicKey.findProgramAddressSync([Buffer.from('holding'), pk(quote).toBuffer(), pk(owner).toBuffer()], pk(token))
  await account(name, holding.toBase58(), encode('Holding', { version: 1, bump, mint: pk(quote), owner: pk(owner), amount: balance,
    delegate: null, delegated_amount: new BN(0), frozen: false, hook_data: Array(64).fill(0), reserved: Array(16).fill(0) }, 204))
}
const roles = Object.fromEntries(['wallet','admin','upgrade','guardian','collector'].map(role => [role, localKey(role).publicKey.toBase58()]))
await writeFile(`${state}/local-identities.public.json`, JSON.stringify({ scope: 'deterministic-public-LOCAL-TEST-identities-only', roles, quoteMint: quote,
  note: 'Synthetic local quote allocations have no bridge backing and no real funds. Existing production custody is never opened.' }, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ genesisAssetsPrepared: true, roles, quoteMint: quote, quoteHolding: pda(token, 'holding', pk(quote).toBuffer(), pk(wallet).toBuffer()) }))
