// SYNTHETIC SIGNED RECEIPTS ONLY. The retained public SBF/IDL/profile pins are real fixture artifacts;
// inclusion, balances and account reads below are manufactured, never network or production evidence.
// Test-only signing material stays inside the fixture function and is never returned or saved.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { planMaxWalletPreparation, deriveMaxWalletPreparedAccounts } from '../../src/hooklab-max-wallet-preparation.mjs'
import { maxWalletPreparationFixture } from './hooklab-max-wallet-preparation.mjs'
import { customPreparationRpcProviders } from './hooklab-preparation-rpc-readers.mjs'
const pk = value => new PublicKey(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const pda = (program, seed, mint) => PublicKey.findProgramAddressSync([Buffer.from(seed), pk(mint).toBuffer()], pk(program))[0].toBase58()
const publicAddress = n => pk(Buffer.alloc(32, n)).toBase58()
function syntheticSigner(label) {
  const seed = createHash('sha256').update(`max-wallet RECEIPT TEST FIXTURE ONLY: ${label}`).digest()
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), type: 'pkcs8', format: 'der' })
  const publicBytes = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32)
  return { privateKey, address: pk(publicBytes).toBase58() }
}
export function maxWalletPreparationReceiptFixture({ samePayer = false, lookupTable = false, capBps = 100, seedLabel = 'default' } = {}) {
  if (typeof seedLabel !== 'string' || seedLabel.length > 128) throw Error('Invalid synthetic seed label')
  const input = maxWalletPreparationFixture(), before = { ...input.request }, profile = JSON.parse(input.profile.json)
  const signers = Object.fromEntries(['creator', 'feePayer', 'mint', 'selectedConfig'].map(role => [role, syntheticSigner(`${seedLabel}:${role}`)]))
  if (samePayer) signers.feePayer = signers.creator
  for (const role of Object.keys(signers)) input.request[role] = signers[role].address
  input.request.capBps = capBps
  const replacements = new Map(['creator', 'mint', 'selectedConfig'].map(role => [before[role], input.request[role]]))
  for (const seed of ['policy', 'bordrless-hook-accounts']) replacements.set(pda(profile.programs.gate, seed, before.mint), pda(profile.programs.gate, seed, input.request.mint))
  replacements.set(pda(profile.programs.launch, 'launch', before.mint), pda(profile.programs.launch, 'launch', input.request.mint))
  for (const observation of input.observations) {
    for (const entry of observation.accounts) {
      entry.address = replacements.get(entry.address) ?? entry.address
      if (entry.account) entry.account.address = entry.address
    }
    // The retained Rust fixture used one payer; a separate synthetic fee payer is explicitly rebound.
    observation.accounts[10] = { address: input.request.feePayer,
      account: { ...structuredClone(observation.accounts[9].account), address: input.request.feePayer } }
  }
  input.recentBlockhash.networkFeeLamports = samePayer ? '15000' : '20000'
  input.limits.maxNetworkFeeLamports = input.recentBlockhash.networkFeeLamports
  input.limits.maxTotalDebitLamports = String(BigInt(input.limits.maxRentLamports) + BigInt(input.recentBlockhash.networkFeeLamports))
  let plan = planMaxWalletPreparation(input)
  if (lookupTable) {
    const addresses = plan.review.accounts.filter(a => !a.signer).map(a => a.address), bytes = Buffer.alloc(56 + 32 * addresses.length)
    bytes.writeUInt32LE(1); bytes.writeBigUInt64LE(0xffffffffffffffffn, 4); bytes.writeBigUInt64LE(BigInt(input.observations[0].slot - 1), 12)
    addresses.forEach((a, i) => pk(a).toBuffer().copy(bytes, 56 + 32 * i))
    input.lookupTable = { address: publicAddress(210), owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: bytes.toString('base64'), sha256: sha(bytes) }
    plan = planMaxWalletPreparation(input)
  }
  const message = VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64')), tx = new VersionedTransaction(message)
  const privateKeys = new Map(Object.values(signers).map(s => [s.address, s.privateKey]))
  tx.signatures = plan.review.requiredSigners.map(address => sign(null, message.serialize(), privateKeys.get(address)))
  const signedTransactionBase64 = Buffer.from(tx.serialize()).toString('base64'), signature = bs58.encode(tx.signatures[0])
  const expected = deriveMaxWalletPreparedAccounts({ profile: { json: input.profile.json, expectedSha256: input.profile.expectedSha256, idls: input.profile.idls },
    request: input.request, launchConfig: input.observations[0].accounts[4].account, observedCreatedAtUnixSeconds: '1700000001' })
  const rentQuotes = input.observations[0].rentExemptionLamports, rent = BigInt(input.limits.maxRentLamports), fee = BigInt(input.recentBlockhash.networkFeeLamports)
  const accounts = Object.entries(expected.accounts).map(([role, a]) => ({ role, address: a.address, owner: a.owner,
    executable: a.executable, dataBase64: a.dataBase64, lamports: rentQuotes[role] }))
  const preBalances = plan.review.accounts.map(a => accounts.some(s => s.address === a.address) ? '0'
    : input.observations[0].accounts.find(s => s.address === a.address)?.account?.lamports ?? '10000000')
  const postBalances = preBalances.map((value, i) => {
    const address = plan.review.accounts[i].address, prepared = accounts.find(a => a.address === address)
    return String(BigInt(value) + BigInt(prepared?.lamports ?? '0') - (address === input.request.creator ? rent : 0n) - (address === input.request.feePayer ? fee : 0n))
  })
  const loaded = plan.review.accounts.slice(message.staticAccountKeys.length), slot = input.observations[0].slot + 2
  const transaction = { slot, blockTime: 1700000000, signedTransactionBase64,
    loadedAddresses: { writable: loaded.filter(a => a.writable).map(a => a.address), readonly: loaded.filter(a => !a.writable).map(a => a.address) },
    feeLamports: String(fee), err: null, preBalances, postBalances }
  const block = { slot, blockhash: publicAddress(160), previousBlockhash: publicAddress(161), parentSlot: slot - 1,
    blockHeight: slot, blockTime: transaction.blockTime, signatures: [signature] }
  const observations = input.profile.providers.map((provider, i) => ({ provider, genesisHash: profile.genesisHash,
    transactionCommitment: 'finalized', transaction: structuredClone(transaction), blockCommitment: 'finalized', block: structuredClone(block),
    snapshot: { slot: slot + 8 + i, commitment: 'finalized', accounts: structuredClone(accounts) },
    programSnapshot: { slot: slot + 8 + i, commitment: 'finalized', accounts: ['launch', 'gate', 'launchProgramData', 'gateProgramData'].map(role => {
      const address = plan.addresses[role], account = input.observations[0].accounts.find(a => a.address === address).account
      return { role, ...structuredClone(account) }
    }) },
    absenceSnapshot: { slot: slot + 8 + i, commitment: 'finalized', accounts: [{ address: plan.addresses.canonicalLaunch, exists: false }] },
    errorCode: null }))
  return { preparationInput: input, expectedProfileSha256: input.profile.expectedSha256, signedTransactionBase64,
    expectedProviders: [...input.profile.providers], evidenceMode: 'synthetic-fixture', observations }
}

/** In-memory RPC-shaped adapters. Never connect to any endpoint or submit a transaction. */
export function maxWalletPreparationRpcProviders(fixture) {
  const { providers, calls } = customPreparationRpcProviders(fixture)
  for (const provider of providers) {
    const read = provider.connection.getMultipleAccountsInfoAndContext
    provider.connection.getMultipleAccountsInfoAndContext = async (...args) => {
      const snapshot = await read(...args), absence = fixture.observations.find(o => o.provider === provider.provider).absenceSnapshot
      if (!snapshot || !absence) return snapshot
      snapshot.value.push(absence.accounts[0].exists
        ? { owner: pk(JSON.parse(fixture.preparationInput.profile.json).programs.launch), executable: false,
          data: Buffer.alloc(8), lamports: 1000000, rentEpoch: 0 } : null)
      return snapshot
    }
  }
  return { providers, calls }
}
