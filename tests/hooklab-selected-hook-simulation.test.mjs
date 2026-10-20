import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { collectSelectedHookSimulation } from '../src/hooklab-selected-hook-simulation.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
const key = n => Keypair.fromSeed(Buffer.alloc(32, n)).publicKey.toBase58()
const pk = x => new PublicKey(x)
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds, pk(program))
const zero = '11111111111111111111111111111111'
function fixture(mutate = () => {}) {
  const wallet = key(1), token = key(2), mint = key(3), hook = key(4), recipient = key(5), config = key(6)
  const holding = owner => pda(token, Buffer.from('holding'), pk(mint).toBuffer(), pk(owner).toBuffer())
  const [from, fromBump] = holding(wallet), [to, toBump] = holding(recipient)
  const bytes = (owner, bump, amount) => {
    const b = Buffer.alloc(204); Buffer.from(sha('account:Holding'), 'hex').subarray(0, 8).copy(b)
    b[8] = 1; b[9] = bump; pk(mint).toBuffer().copy(b, 10); pk(owner).toBuffer().copy(b, 42); b.writeBigUInt64LE(amount, 74)
    return b
  }
  const acct = (owner, lamports, data = Buffer.alloc(0)) => ({ owner: pk(owner), executable: false, lamports, data })
  const before = new Map([[wallet, acct(zero, 100000)], [from.toBase58(), acct(token, 3000, bytes(wallet, fromBump, 997n))],
    [to.toBase58(), acct(token, 3000, bytes(recipient, toBump, 31n))], [config, acct(hook, 4000, Buffer.from('reviewed-registry'))]])
  const after = new Map([...before].map(([k, a]) => [k, { ...a, data: Buffer.from(a.data) }]))
  after.get(wallet).lamports -= 5000
  after.get(from.toBase58()).data.writeBigUInt64LE(896n, 74)
  after.get(to.toBase58()).data.writeBigUInt64LE(124n, 74) // 101 debited, only 93 delivered: an eight-token hook fee.
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0n }),
    new TransactionInstruction({ programId: pk(hook), data: Buffer.from([7]), keys: [
      { pubkey: pk(wallet), isWritable: true, isSigner: true }, { pubkey: from, isWritable: true, isSigner: false },
      { pubkey: to, isWritable: true, isSigner: false }, { pubkey: pk(config), isWritable: false, isSigner: false },
    ] })]
  const message = new TransactionMessage({ payerKey: pk(wallet), recentBlockhash: key(9), instructions }).compileToV0Message()
  const keys = message.getAccountKeys(), wire = Buffer.from(message.serialize())
  const review = { schema: 'hooklab-message-review/1', operation: 'selected-hook-transfer', genesisHash: key(10), profileSha256: 'a'.repeat(64),
    policySha256: 'b'.repeat(64), intentSha256: 'c'.repeat(64), payer: wallet, wallet, messageBase64: wire.toString('base64'), messageSha256: sha(wire),
    requiredSigners: [wallet], accounts: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) })),
    lookupTables: [], observedSlot: 40, validUntilSlot: 90, observedAtMs: 1000, reviewExpiresAtMs: 2000, lastValidBlockHeight: 150,
    baseFeeLamports: '5000', maxFeeLamports: '5000', instructionDebitLamports: '0', maxNativeDebitLamports: '5000' }
  const conditions = { tokenProgram: token, configurationSha256: 'd'.repeat(64),
    holdings: [{ address: from.toBase58(), mint, owner: wallet, maxDebit: '101', minCredit: '0' },
      { address: to.toBase58(), mint, owner: recipient, maxDebit: '0', minCredit: '93' }],
    native: [{ address: wallet, maxDebit: '5000', minCredit: '0' }], unchanged: [{ address: config, sha256: sha(Buffer.from('reviewed-registry')) }] }
  const connections = ['one', 'two'].map((provider, index) => ({ provider, connection: {
    async getGenesisHash() { return review.genesisHash },
    async getMultipleAccountsInfoAndContext(keys) { return { context: { slot: 42 }, value: keys.map(k => before.get(k.toBase58()) ?? null) } },
    async getBlockHeight() { return 100 },
    async isBlockhashValid() { return { context: { slot: 42 }, value: true } },
    async getFeeForMessage() { return { context: { slot: 42 }, value: 5000 } },
    async simulateTransaction(tx, options) {
      assert.equal(Buffer.from(tx.message.serialize()).toString('base64'), review.messageBase64)
      assert.equal(options.sigVerify, false); assert.equal(options.replaceRecentBlockhash, false)
      const response = { context: { slot: 42 }, value: { err: null, unitsConsumed: 18000, accounts: options.accounts.addresses.map(address => {
        const a = after.get(address)
        return a ? { owner: a.owner.toBase58(), executable: a.executable, lamports: a.lamports, data: [a.data.toString('base64'), 'base64'] } : null
      }) } }
      mutate({ response, index, addresses: options.accounts.addresses, review, conditions })
      return response
    },
  } }))
  return { review, conditions, connections, clock: () => 1200, from: from.toBase58(), to: to.toBase58(), wallet, config }
}

test('exact-message simulation measures net delivery after hook fees, and retains JSON-stable review and policy identity', async () => {
  const f = fixture(), result = await collectSelectedHookSimulation(f)
  assert.equal(result.tokenDeltas[f.from], '-101'); assert.equal(result.tokenDeltas[f.to], '93')
  assert.equal(result.lamportDeltas[f.wallet], '-5000'); assert.equal(result.messageSha256, f.review.messageSha256)
  assert.equal(result.canSign, false); assert.equal(result.canSubmit, false)
  assert.deepEqual(await collectSelectedHookSimulation({ ...f, expected: JSON.parse(JSON.stringify(result)) }), result)
})

test('simulation rejects one-unit net minimum violations and excessive input or native debits', async () => {
  for (const [role, change] of [['to', -1n], ['from', -1n], ['wallet', -1n]]) {
    const f = fixture(({ response, addresses }) => {
      const a = response.value.accounts[addresses.indexOf(f[role])]
      if (role === 'wallet') a.lamports += Number(change)
      else { const b = Buffer.from(a.data[0], 'base64'); b.writeBigUInt64LE(b.readBigUInt64LE(74) + change, 74); a.data[0] = b.toString('base64') }
    })
    await assert.rejects(collectSelectedHookSimulation(f), { code: 'SELECTED_HOOK_SIMULATION_UNAVAILABLE' })
  }
})

test('simulation rejects changed reviewed configuration, wire, bounds and registry on revalidation', async () => {
  const f = fixture(), expected = await collectSelectedHookSimulation(f)
  for (const change of [{ conditions: { ...f.conditions, configurationSha256: 'e'.repeat(64) } },
    { conditions: { ...f.conditions, holdings: f.conditions.holdings.map(x => ({ ...x, minCredit: '0' })) } },
    { review: { ...f.review, messageSha256: 'e'.repeat(64) } }]) {
    await assert.rejects(collectSelectedHookSimulation({ ...f, ...change, expected }))
  }
  const changed = fixture(({ response, addresses }) => { response.value.accounts[addresses.indexOf(f.config)].data = [Buffer.from('changed').toString('base64'), 'base64'] })
  await assert.rejects(collectSelectedHookSimulation(changed))
})

test('simulation rejects substituted token identity, provider disagreement, bank races and replacement blockhashes', async () => {
  for (const mutate of [
    ({ response, addresses }) => { response.value.accounts[addresses.indexOf(fixture().to)].owner = key(11) },
    ({ response, index, addresses }) => { if (index === 1) response.value.accounts[addresses.indexOf(fixture().to)].lamports++ },
    ({ response }) => { response.context.slot++ },
    ({ response }) => { response.value.replacementBlockhash = { blockhash: key(12) } },
    ({ response }) => { response.value.unitsConsumed = 200001 },
  ]) await assert.rejects(collectSelectedHookSimulation(fixture(mutate)))
  const f = fixture(); await assert.rejects(collectSelectedHookSimulation({ ...f, clock: () => 2000 }))
})
