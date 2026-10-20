// Synthetic bytes only: no chain history, external artifacts, or signing keys.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PublicKey, Keypair } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { encodeOpenCreationReserved } from '../../src/hooklab-launch-config-reserved.mjs'
export const sha = b => createHash('sha256').update(b).digest('hex')
export const pk = v => new PublicKey(v)
export const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
export const pda = (p, ...s) => PublicKey.findProgramAddressSync(s.map(x => typeof x === 'string' ? Buffer.from(x) : x), pk(p))[0].toBase58()
export function fixture() {
  const root = '../../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/'
  const read = n => readFileSync(new URL(root + n, import.meta.url))
  const p = JSON.parse(read('offline-builder-profile.json'))
  const idl = JSON.parse(read('bordrless_launch.json'))
  // Synthetic open-route capability; not represented as reviewed executable evidence.
  idl.instructions.push({ name: 'create_launch_open_v1', discriminator: [...Buffer.alloc(8)], accounts: [], args: [] })
  const launchIdl = Buffer.from(JSON.stringify(idl)), gateIdl = read('hook_max_wallet.json')
  const elf = Buffer.from([127, 69, 76, 70, 7, 9, 3, 2])
  p.idlSha256.launch = sha(launchIdl); p.elfSha256.launch = sha(elf)
  const json = JSON.stringify(p), creator = Keypair.fromSeed(Buffer.alloc(32, 31)).publicKey.toBase58()
  const mint = Keypair.fromSeed(Buffer.alloc(32, 32)).publicKey.toBase58()
  const selectedConfig = Keypair.fromSeed(Buffer.alloc(32, 33)).publicKey.toBase58()
  const hook = key(44), loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
  const account = (address, owner, executable, data = Buffer.alloc(0)) => ({ address, owner, executable, lamports: '10000000', dataBase64: data.toString('base64') })
  const accounts = new Map()
  for (const program of [p.programs.launch, hook]) {
    const address = pda(loader, pk(program).toBuffer()), pb = Buffer.alloc(36), db = Buffer.alloc(45 + elf.length)
    pb.writeUInt32LE(2); pk(address).toBuffer().copy(pb, 4)
    db.writeUInt32LE(3); db.writeBigUInt64LE(50n, 4); elf.copy(db, 45)
    accounts.set(program, account(program, loader, true, pb)); accounts.set(address, account(address, loader, false, db))
  }
  const coder = new BorshCoder(idl)
  const value = type => {
    if (type === 'pubkey') return pk(key(88))
    if (type === 'bool') return false
    if (type === 'u64' || type === 'i64') return new BN(0)
    if (typeof type === 'string') return 0
    if (type.array) return Array(type.array[1]).fill(0)
    return Object.fromEntries(idl.types.find(t => t.name === type.defined.name).type.fields.map(f => [f.name, value(f.type)]))
  }
  const c = value({ defined: { name: 'Config' } })
  Object.assign(c, { version: 1, bump: PublicKey.findProgramAddressSync([Buffer.from('config')], pk(p.programs.launch))[1], quote_mint: pk(p.quoteMint), supply: new BN(1000000), max_creator_fee_bps: 200,
    reserved: [...encodeOpenCreationReserved({ native: true, open: true, creatorFeeBps: [100, 200], capBps: [100] })] })
  c.rule_bounds.max_rules_fee_bps = 200
  const cb = Buffer.alloc(250); Buffer.from(idl.accounts.find(a => a.name === 'Config').discriminator).copy(cb); coder.types.encode('Config', c).copy(cb, 8)
  const config = pda(p.programs.launch, 'config'); accounts.set(config, account(config, p.programs.launch, false, cb))
  const registry = pda(hook, 'bordrless-hook-accounts', pk(mint).toBuffer())
  accounts.set(registry, account(registry, hook, false, Buffer.from('02daf6662c38c0cd0100000000', 'hex')))
  accounts.set(creator, account(creator, '11111111111111111111111111111111', false))
  const inventory = [p.programs.launch, hook, pda(loader, pk(p.programs.launch).toBuffer()), pda(loader, pk(hook).toBuffer()), config, registry, mint, selectedConfig, creator, creator, pda(p.programs.launch, 'launch', pk(mint).toBuffer())]
  return { profile: { json, expectedSha256: sha(json), providers: ['fixture-a', 'fixture-b'], idls: { launch: launchIdl.toString('base64'), gate: gateIdl.toString('base64') }, elfLengths: { launch: elf.length, gate: 8 } },
    hookPin: { program: hook, elfSha256: sha(elf), elfLength: elf.length },
    request: { schema: 'repoing/selected-hook-preparation-request/1', policyKind: 'selected-hook', policyVersion: 2, creator, feePayer: creator, mint, selectedConfig, capBps: 0, label: 'Selected', creatorFeeBps: 100, rules: 'none', hookFlags: 255, selectedHook: { program: hook, flags: 255 }, feeModel: 2, protocolShareBps: 2500 },
    observations: ['fixture-a', 'fixture-b'].map(provider => ({ provider, genesisHash: p.genesisHash, commitment: 'finalized', slot: 100, observedAtMs: 1000, accounts: inventory.map(address => ({ address, account: structuredClone(accounts.get(address) ?? null) })), rentExemptionLamports: { selectedConfig: '2000' } })),
    recentBlockhash: { blockhash: key(77), genesisHash: p.genesisHash, providers: ['fixture-a', 'fixture-b'], observedAtMs: 1000, currentBlockHeight: 100, lastValidBlockHeight: 200, blockhashValid: true, observedSlot: 100, networkFeeLamports: '10000', lamportsPerSignature: '5000' },
    limits: { nowMs: 1000, maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: 150, reviewExpiresAtMs: 6000, maxRentLamports: '2000', maxNetworkFeeLamports: '10000', maxTotalDebitLamports: '12000', computeUnitLimit: 200000, computeUnitPriceMicroLamports: '0' } }
}
export function connections(f) {
  return f.profile.providers.map(provider => ({ provider, connection: {
    rpcEndpoint: `https://${provider}.example.org`,
    async getGenesisHash() { return f.recentBlockhash.genesisHash },
    async getMultipleAccountsInfoAndContext(keys) { return { context: { slot: 100 }, value: keys.map(k => { const a = f.observations[0].accounts.find(a => a.address === k.toBase58()).account; return a && { ...a, owner: pk(a.owner), lamports: Number(a.lamports), data: Buffer.from(a.dataBase64, 'base64') } }) } },
    async getMinimumBalanceForRentExemption(size) { if (size !== 176) throw Error('Unexpected rent'); return 2000 },
    async getLatestBlockhashAndContext() { return { context: { slot: 100 }, value: { blockhash: f.recentBlockhash.blockhash, lastValidBlockHeight: 200 } } },
    async getBlock() { return { blockhash: f.recentBlockhash.blockhash, blockHeight: 50 } },
    async isBlockhashValid() { return { context: { slot: 100 }, value: true } },
    async getBlockHeight() { return 100 },
    async getFeeForMessage(message) { if (message.header.numRequiredSignatures !== 2) throw Error('Unexpected signers'); return { context: { slot: 100 }, value: 10000 } },
  } }))
}
