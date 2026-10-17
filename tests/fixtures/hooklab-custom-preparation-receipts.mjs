// SYNTHETIC ONLY. Rebind public stage-one roles to deterministic test-only Ed25519 signers.
// Private material exists only inside this fixture function; never returned, persisted or submitted.
// No wallet, RPC, production key, key file, or actual chain transaction is used.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import bs58 from 'bs58'
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { customPreparationFixture } from './hooklab-custom-preparation.mjs'
import { planCustomPreparation } from '../../src/hooklab-custom-preparation.mjs'
const sha = b => createHash('sha256').update(b).digest('hex')
const address = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const pk = a => new PublicKey(a)
const pda = (program, seed, mint) => PublicKey.findProgramAddressSync([Buffer.from(seed), pk(mint).toBuffer()], pk(program))[0].toBase58()
function signer(role) {
  const seed = createHash('sha256').update(`hooklab preparation synthetic fixture ONLY: ${role}`).digest()
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
  const pub = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32)
  return { privateKey, address: new PublicKey(pub).toBase58() }
}
export function customPreparationReceiptFixture({ samePayer = false, lookupTable = false, seedLabel = 'default' } = {}) {
  if (typeof seedLabel !== 'string' || seedLabel.length > 128) throw Error('Invalid synthetic seed label')
  const input = customPreparationFixture({ samePayer }), before = structuredClone(input.request)
  const signers = Object.fromEntries(['creator', 'feePayer', 'mint', 'selectedConfig'].map(role => [role, signer(`${seedLabel}:${role}`)]))
  if (samePayer) signers.feePayer = signers.creator
  for (const role of Object.keys(signers)) input.request[role] = signers[role].address
  const profile = JSON.parse(input.profile.json)
  const replacements = new Map(Object.keys(signers).map(role => [before[role], input.request[role]]))
  for (const seed of ['policy', 'bordrless-hook-accounts']) replacements.set(pda(profile.programs.gate, seed, before.mint), pda(profile.programs.gate, seed, input.request.mint))
  for (const observation of input.observations) for (const entry of observation.accounts) {
    entry.address = replacements.get(entry.address) ?? entry.address
    if (entry.account) entry.account.address = entry.address
  }
  let plan = planCustomPreparation(input)
  if (lookupTable) {
    const addresses = plan.review.accounts.filter(a => !a.signer).map(a => a.address)
    const data = Buffer.alloc(56 + 32 * addresses.length)
    data.writeUInt32LE(1); data.writeBigUInt64LE(0xffffffffffffffffn, 4); data.writeBigUInt64LE(10n, 12)
    addresses.forEach((a, i) => pk(a).toBuffer().copy(data, 56 + 32 * i))
    input.lookupTable = { address: address(130), owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: data.toString('base64'), sha256: sha(data) }
    plan = planCustomPreparation(input)
  }
  const message = VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64'))
  const tx = new VersionedTransaction(message)
  const byAddress = new Map(Object.values(signers).map(s => [s.address, s.privateKey]))
  tx.signatures = plan.review.requiredSigners.map(a => sign(null, message.serialize(), byAddress.get(a)))
  const signedTransactionBase64 = Buffer.from(tx.serialize()).toString('base64'), signature = bs58.encode(tx.signatures[0])
  const gateIdl = JSON.parse(Buffer.from(input.profile.idls.gate, 'base64')), launchIdl = JSON.parse(Buffer.from(input.profile.idls.launch, 'base64'))
  const encode = (idl, name, value, size) => {
    const bytes = Buffer.concat([Buffer.from(idl.accounts.find(a => a.name === name).discriminator), new BorshCoder(idl).types.encode(name, value)])
    return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]).toString('base64')
  }
  const policy = encode(gateIdl, 'Policy', { mint: pk(input.request.mint), blocked_owner: pk(input.request.blockedOwner) }, 72)
  const registry = Buffer.concat([Buffer.from('02daf6662c38c0cd01010000000000', 'hex'), pk(plan.addresses.policy).toBuffer()]).toString('base64')
  const selected = encode(launchIdl, 'LaunchConfig', { version: 1, creator: pk(input.request.creator),
    rules: { holder_fee_buy_bps: 0, holder_fee_sell_bps: 0, burn_buy_bps: 0, burn_sell_bps: 0, max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 },
    creator_fee_bps: 0, custom_hook: pk(profile.programs.gate), custom_hook_flags: 1, label: input.request.label,
    created_at: new BN('1700000001'), author_share_bps: 0, reserved: Array(30).fill(0) }, 176)
  const accounts = [
    { role: 'policy', address: plan.addresses.policy, owner: profile.programs.gate, executable: false, dataBase64: policy, lamports: '1000' },
    { role: 'registry', address: plan.addresses.registry, owner: profile.programs.gate, executable: false, dataBase64: registry, lamports: '2000' },
    { role: 'selectedConfig', address: input.request.selectedConfig, owner: profile.programs.launch, executable: false, dataBase64: selected, lamports: '3000' },
  ]
  const preBalances = plan.review.accounts.map(a => accounts.some(s => s.address === a.address) ? '0' : '20000000')
  const postBalances = preBalances.map((v, i) => {
    const a = plan.review.accounts[i].address, prepared = accounts.find(s => s.address === a)
    return String(BigInt(v) + BigInt(prepared?.lamports ?? '0') - (a === input.request.creator ? 6000n : 0n) - (a === input.request.feePayer ? BigInt(input.recentBlockhash.networkFeeLamports) : 0n))
  })
  const loadedAccounts = plan.review.accounts.slice(message.staticAccountKeys.length)
  const transaction = { slot: 112, blockTime: 1700000000, signedTransactionBase64,
    loadedAddresses: { writable: loadedAccounts.filter(a => a.writable).map(a => a.address), readonly: loadedAccounts.filter(a => !a.writable).map(a => a.address) },
    feeLamports: input.recentBlockhash.networkFeeLamports, err: null, preBalances, postBalances }
  const block = { slot: 112, blockhash: address(160), previousBlockhash: address(161), parentSlot: 111, blockHeight: 112, blockTime: 1700000000, signatures: [signature] }
  const observations = input.profile.providers.map((provider, i) => ({ provider, genesisHash: profile.genesisHash,
    transactionCommitment: 'finalized', transaction: structuredClone(transaction), blockCommitment: 'finalized', block: structuredClone(block),
    snapshot: { slot: 120 + i, commitment: 'finalized', accounts: structuredClone(accounts) },
    programSnapshot: { slot: 120 + i, commitment: 'finalized', accounts: ['launch', 'gate', 'launchProgramData', 'gateProgramData'].map(role => {
      const address = plan.addresses[role], account = input.observations[0].accounts.find(a => a.address === address).account
      return { role, ...structuredClone(account) }
    }) }, errorCode: null }))
  return { preparationInput: input, expectedProfileSha256: input.profile.expectedSha256, signedTransactionBase64,
    expectedProviders: [...input.profile.providers], evidenceMode: 'synthetic-fixture', observations }
}

/** In-memory RPC-shaped sources; only use for read-only collector tests. No network methods exist. */
export { customPreparationRpcProviders } from './hooklab-preparation-rpc-readers.mjs'
