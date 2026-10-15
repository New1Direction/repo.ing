// Synthetic ABI fixtures, ephemeral signers, no chain access and no owner identities used as signers.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import { Keypair, PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { PRODUCTION_PROGRAMS, productionCandidateManifest, mainnetLaunchAddresses } from '@repo-ing/hooklab-production-candidate'
import { preparePlainReview } from '../../src/hooklab-plain.mjs'
import { plainRecoveryInventory } from '../../src/hooklab-plain-receipts.mjs'

const sha = b => createHash('sha256').update(b).digest('hex')
const pk = v => new PublicKey(v)
// Independent minimal Borsh fixture encoder against retained raw IDLs, not the decoder under test.
export function accountBytes(program, name, values, size) {
  const idl = JSON.parse(readFileSync(new URL(`../../vendor/hooklab-production-candidate/idl/bordrless_${program}.json`, import.meta.url)))
  const encode = (type, value) => {
    if (typeof type === 'object') {
      if (type.defined) return encode(idl.types.find(t => t.name === type.defined.name).type, value)
      if (type.kind === 'struct') return Buffer.concat(type.fields.map(f => encode(f.type, value?.[f.name])))
      if (type.option) return value == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), encode(type.option, value)])
      if (type.array) return Buffer.concat(Array.from({ length: type.array[1] }, (_, i) => encode(type.array[0], value?.[i])))
      throw new Error(`Unsupported fixture type ${JSON.stringify(type)}`)
    }
    if (type === 'pubkey') return value ? pk(value).toBuffer() : Buffer.alloc(32)
    if (type === 'string') { const b = Buffer.from(value ?? ''), n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]) }
    if (type === 'bool') return Buffer.from([value ? 1 : 0])
    const n = Number(type.slice(1)) / 8, b = Buffer.alloc(n)
    if (n === 8) type[0] === 'i' ? b.writeBigInt64LE(BigInt(value ?? 0)) : b.writeBigUInt64LE(BigInt(value ?? 0))
    else if (n === 16) { b.writeBigUInt64LE(BigInt(value ?? 0) & 0xffffffffffffffffn); b.writeBigUInt64LE(BigInt(value ?? 0) >> 64n, 8) }
    else b.writeUIntLE(Number(value ?? 0), 0, n)
    return b
  }
  const bytes = Buffer.concat([Buffer.from(idl.accounts.find(a => a.name === name).discriminator), encode({ defined: { name } }, values)])
  if (bytes.length > size) throw new Error(`Fixture size ${name}: ${bytes.length}>${size}`)
  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)])
}

export function plainFixture({ samePayer = false } = {}) {
  const creator = Keypair.generate(), mint = Keypair.generate(), payer = samePayer ? creator : Keypair.generate()
  const profile = productionCandidateManifest(), p = PRODUCTION_PROGRAMS
  const a = Object.fromEntries(Object.entries(mainnetLaunchAddresses(mint.publicKey, p.quoteMint, 30, p)).map(([k, v]) => [k, v.toBase58()]))
  const config = { version: 1, admin: profile.requestedRolesNotDeployed.ownerAdmin, treasury: profile.requestedRolesNotDeployed.treasuryAndCollector,
    quote_mint: profile.quoteMint, launch_fee_lamports: 73, lp_fee_bps: 30, sniper_window_secs: 30, sniper_start_bps: 8000,
    curve_bps: 7500, supply: 1000000000000000n, decimals: 6, min_virtual_quote: 1000, max_virtual_quote: 2000000000n, launches: 4 }
  const swapConfig = { version: 1, admin: config.admin, treasury: config.treasury, fee_collector: config.treasury,
    pool_creation_fee_lamports: 19, launch_protocol_share_bps: 2500, pools_created: 7, paused: true }
  const altAddresses = [...new Set([...Object.values(profile.programs), ...Object.values(profile.pdas), ...Object.values(a), config.treasury, profile.quoteMint])]
  const alt = Buffer.alloc(56 + 32 * altAddresses.length); alt.writeUInt32LE(1); alt.writeBigUInt64LE(0xffffffffffffffffn, 4); alt.writeBigUInt64LE(10n, 12)
  altAddresses.forEach((a, i) => pk(a).toBuffer().copy(alt, 56 + i * 32))
  const intent = { schema: 'repoing/plain-intent/1', creator: creator.publicKey.toBase58(), feePayer: payer.publicKey.toBase58(), mint: mint.publicKey.toBase58(),
    name: 'Offline fixture', symbol: 'FIXTURE', uri: '', virtualQuote: '1000000000', deadlineSlot: '150',
    maxLaunchFeeLamports: '73', maxPoolCreationFeeLamports: '19', maxRentLamports: '16000', maxInstructionDebitLamports: '16092',
    maxNetworkFeeLamports: samePayer ? '10000' : '15000', computeUnitLimit: 600000, computeUnitPriceMicroLamports: '0' }
  const observed = { slot: 100, nowMs: 1000, reviewExpiresAtMs: 2000, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 170,
    networkFeeLamports: intent.maxNetworkFeeLamports, launchConfigBase64: accountBytes('launch', 'Config', config, 250).toString('base64'),
    swapConfigBase64: accountBytes('swap', 'Config', swapConfig, 189).toString('base64'), governanceCommitment: 'a'.repeat(64),
    creatorGrant: { creator: intent.creator, enabled: true, expiresAtSlot: '151', maxLaunches: '3', consumed: '1', revision: '9' },
    lookupTables: [{ address: Keypair.generate().publicKey.toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: alt.toString('base64'), sha256: sha(alt) }] }
  const plan = preparePlainReview(intent, observed)
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64')))
  tx.sign(samePayer ? [creator, mint] : [creator, payer, mint])
  const signed = Buffer.from(tx.serialize()).toString('base64'), accounts = {}, inventory = plainRecoveryInventory(plan)
  const add = (role, program, name, fields, size) => {
    accounts[role] = { address: inventory[role], owner: p[program].toBase58(), executable: false, dataBase64: accountBytes(program, name, { version: 1, ...fields }, size).toString('base64') }
  }
  const kit = PublicKey.findProgramAddressSync([Buffer.from('kit'), mint.publicKey.toBuffer()], pk('AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm'))[0]
  const holder = PublicKey.findProgramAddressSync([Buffer.from('holding'), p.quoteMint.toBuffer(), kit.toBuffer()], p.token)[0]
  // Rust HookAccountList Borsh layout, independently serialized without the SDK helper.
  const registry = Buffer.concat([Buffer.from('02daf6662c38c0cd01040000000101', 'hex'), p.launch.toBuffer(),
    Buffer.from('0200000000060000006c61756e636801020101', 'hex'), p.token.toBuffer(),
    Buffer.from('030000000007000000686f6c64696e67010301050100', 'hex'), holder.toBuffer(), Buffer.from([0, 0]), kit.toBuffer()])
  accounts.poolRegistry = { address: a.poolRegistry, owner: p.launch.toBase58(), executable: false, dataBase64: registry.toString('base64') }
  add('mint', 'token', 'Mint', { name: intent.name, symbol: intent.symbol, uri: '', creator: intent.creator, supply: config.supply, max_supply: config.supply, decimals: 6 }, 519)
  add('launch', 'launch', 'Launch', { creator: intent.creator, mint: intent.mint, pool: a.pool, quote_mint: profile.quoteMint,
    kit_config: kit, holder_vault: holder, graduation_quote: 2000000000n,
    lp_fee_bps: 30, sniper_window_secs: 30, sniper_start_bps: 8000, virtual_quote: 1000000000, virtual_base: 375000000000000n,
    curve_tokens: 750000000000000n, reserve_tokens: 250000000000000n, reserve_holding: a.launchReserve, quote_holding: a.launchQuote, lp_holding: a.launchLp }, 565)
  add('pool', 'swap', 'Pool', { creator: a.launch, base_mint: intent.mint, quote_mint: profile.quoteMint, lp_mint: a.lpMint,
    base_vault: a.baseVault, quote_vault: a.quoteVault, hook_program: p.launch.toBase58(), hook_flags: 1985, lp_fee_bps: 30,
    base_reserve: 750000000000000n, virtual_base: 375000000000000n, virtual_quote: 1000000000, curve: true, fee_model: 1, protocol_share_bps: 2500 }, 411)
  add('lpMint', 'token', 'Mint', { mint_authority: a.pool }, 519)
  for (const [role, mintAddress, owner, amount] of [['launchReserve', intent.mint, a.launch, 250000000000000n], ['launchQuote', profile.quoteMint, a.launch, 0],
    ['baseVault', intent.mint, a.pool, 750000000000000n], ['quoteVault', profile.quoteMint, a.pool, 0], ['launchLp', a.lpMint, a.launch, 0]]) {
    add(role, 'token', 'Holding', { mint: mintAddress, owner, amount }, 204)
  }
  add('launchConfig', 'launch', 'Config', { ...config, launches: 5 }, 250)
  add('swapConfig', 'swap', 'Config', { ...swapConfig, pools_created: 8 }, 189)
  const grant = Buffer.alloc(73)
  createHash('sha256').update('account:CreatorAuthorization').digest().subarray(0, 8).copy(grant)
  creator.publicKey.toBuffer().copy(grant, 8); grant[40] = 1
  grant.writeBigUInt64LE(151n, 41); grant.writeBigUInt64LE(3n, 49); grant.writeBigUInt64LE(2n, 57); grant.writeBigUInt64LE(9n, 65)
  accounts.creatorGrant = { address: inventory.creatorGrant, owner: p.launch.toBase58(), executable: false, dataBase64: grant.toString('base64') }
  const created = [intent.mint, ...Object.values(a)], rent = created.length * 1000, debit = rent + 92
  const deltas = new Map(created.map(a => [a, 1000]))
  const delta = (key, n) => deltas.set(key, (deltas.get(key) ?? 0) + n)
  delta(intent.creator, -debit); delta(intent.feePayer, -Number(intent.maxNetworkFeeLamports)); delta(config.treasury, 92)
  const balances = plan.review.accounts.map(({ address }) => ({ address, before: created.includes(address) ? 0 : 50000000,
    after: (created.includes(address) ? 0 : 50000000) + (deltas.get(address) ?? 0) }))
  return { plan, signed, tx, creator, payer, mint, config, swapConfig, accounts, balances, debit,
    current: { genesisHash: profile.genesisHash, wallet: intent.creator, profileSha256: plan.review.profileSha256, policySha256: plan.review.policySha256,
      slot: 101, blockHeight: 110, nowMs: 1500, blockhashValid: true, feeLamports: observed.networkFeeLamports,
      lookupTableHashes: plan.review.lookupTables.map(({ address, sha256 }) => ({ address, sha256 })) } }
}

export function plainObservations(fixture) {
  const { plan, signed, accounts, balances, tx } = fixture
  // This receipt is synthetic, not a finalized chain acceptance record.
  return ['alpha', 'beta'].map(provider => ({ provider, snapshot: { slot: 105, accounts: structuredClone(accounts) },
    receipt: { genesisHash: plan.review.genesisHash, signature: bs58.encode(tx.signatures[0]),
      messageSha256: plan.review.messageSha256, signedTransactionBase64: signed, slot: 104,
      confirmationStatus: 'finalized', feeLamports: plan.outerPayerNetworkFee, error: null, balances: structuredClone(balances) } }))
}
