import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { prepareLaunchSigning, DefinitiveLaunchError } from '../src/meteora-launch.mjs'
import { createWalletProvider, SOLANA_MAINNET_CHAIN } from '../app/lib/solana-wallet.mjs'
import { estimateLaunchCosts } from '../src/launch-costs.mjs'

function fixture() {
  const payer = Keypair.generate(), creator = Keypair.generate(), mint = Keypair.generate()
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      lamports: 1461600, space: 82, programId: TOKEN_PROGRAM_ID }))
    .add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: payer.publicKey, lamports: 1 }))
  let cosigns = 0
  const track = key => ({ publicKey: key.publicKey, get secretKey() { cosigns++; return key.secretKey } })
  return { tx, payer, creator, mint, cosigns: () => cosigns,
    sign: prepareLaunchSigning(tx, payer.publicKey, track(creator), track(mint)) }
}
const transport = tx => Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: true }))

for (const adapter of ['legacy', 'standard']) test(`${adapter}: wallet signs first; server co-signs unchanged message after partial-signature transport`, async () => {
  const f = fixture(), message = Buffer.from(f.tx.serializeMessage())
  const walletSign = tx => {
    assert.equal(f.cosigns(), 0)
    assert.ok(tx.signatures.every(entry => entry.signature === null))
    tx.partialSign(f.payer)
    return tx
  }
  let provider
  if (adapter === 'legacy') provider = createWalletProvider({ legacy: { signTransaction: walletSign } })
  else {
    const account = { address: f.payer.publicKey.toBase58(), chains: [SOLANA_MAINNET_CHAIN] }
    provider = createWalletProvider({ standard: { features: {
      'standard:connect': { connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': { signTransaction: async ({ transaction }) => [{
        signedTransaction: walletSign(Transaction.from(transaction)).serialize({ requireAllSignatures: false, verifySignatures: true }),
      }] },
    } } })
    await provider.connect()
  }
  let userSignature
  const result = await f.sign(async tx => {
    const signed = await provider.signTransaction(transport(tx))
    userSignature = Buffer.from(signed.signature)
    assert.equal(signed.verifySignatures(), false)
    return transport(signed)
  })
  const final = Transaction.from(result.raw)
  assert.ok(final.verifySignatures())
  assert.equal(f.cosigns(), 2)
  assert.deepEqual(final.serializeMessage(), message)
  assert.deepEqual(final.signature, userSignature)
})

for (const mutation of ['instruction', 'blockhash', 'payer', 'missing signature', 'invalid signature']) {
  test(`${mutation} is rejected before server co-signing`, async () => {
    const f = fixture()
    await assert.rejects(f.sign(async tx => {
      const returned = transport(tx)
      if (mutation === 'instruction') returned.instructions[0].data[0] ^= 1
      if (mutation === 'blockhash') returned.recentBlockhash = Keypair.generate().publicKey.toBase58()
      if (mutation === 'payer') returned.feePayer = f.creator.publicKey
      if (mutation !== 'missing signature') returned.partialSign(f.payer)
      if (mutation === 'invalid signature') returned.signatures.find(s => s.publicKey.equals(f.payer.publicKey)).signature[0] ^= 1
      return returned
    }), DefinitiveLaunchError)
    assert.equal(f.cosigns(), 0)
  })
}

test('wallet cancellation never releases server signatures', async () => {
  const f = fixture()
  await assert.rejects(f.sign(async () => { throw Error('User rejected the request') }), /User rejected/)
  assert.equal(f.cosigns(), 0)
})

// Fake RPC for the launch budget: 120k simulated units, recent fees p75 at 300k microlamports per unit.
const budgetRpc = { rpcEndpoint: 'http://127.0.0.1:8899',
  simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 120_000 } }),
  getRecentPrioritizationFees: async () => [{ slot: 1, prioritizationFee: 300_000 }] }
const priced = async f => (await withLaunchPriorityFee(budgetRpc, f.tx,
  { feePayer: f.payer.publicKey, blockhash: f.tx.recentBlockhash, log: () => {} })).transaction

test('unsigned three-signer transaction still gets an exact pre-wallet simulation', async () => {
  const f = fixture(), tx = await priced(f)
  const rpc = {
    getBalanceAndContext: async () => ({ context: { slot: 123 }, value: 100000000 }),
    simulateTransaction: async (simulated, options) => {
      assert.equal(options.sigVerify, false)
      assert.equal(options.minContextSlot, 123)
      assert.ok(simulated.signatures.every(signature => signature.every(byte => byte === 0)))
      assert.equal(simulated.message.header.numRequiredSignatures, 3)
      return { value: { err: null, accounts: [{ lamports: 97942000 }] } }
    },
    // 3 signatures + 160,000 CU × 300,000 microlamports.
    getFeeForMessage: async () => ({ value: 63000 }),
  }
  const costs = await estimateLaunchCosts(rpc, tx, '0')
  assert.deepEqual([costs.networkFee, costs.priorityFee, costs.accountDeposits, costs.total], ['63000', '48000', '1995000', '2058000'])
  assert.equal(f.cosigns(), 0)
})

// Model Phantom's documented unsigned/no-compute-budget auto-fee behavior.
// The former launch reproduces the exact rejection; explicit reviewed fees
// prevent the augmentation without accepting a changed financial instruction.
import { ComputeBudgetProgram, ComputeBudgetInstruction } from '@solana/web3.js'
import { withLaunchPriorityFee } from '../src/launch-wallet-fees.mjs'
function phantomAutoFees(tx, payer) {
  if (tx.signatures.every(entry => entry.signature === null) &&
      !tx.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId))) {
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }))
  }
  tx.partialSign(payer)
  return tx
}
test('reproduces Phantom unsigned launch auto-fee mutation and rejects it', async () => {
  const f = fixture()
  await assert.rejects(f.sign(async tx => transport(phantomAutoFees(transport(tx), f.payer))), /wallet changed/)
  assert.equal(f.cosigns(), 0)
})
test('explicit priced budget prevents Phantom auto-fee mutation with wallet-first signatures', async () => {
  const f = fixture(), tx = await priced(f)
  const sign = prepareLaunchSigning(tx, f.payer.publicKey, f.creator, f.mint)
  const reviewed = Buffer.from(tx.serializeMessage())
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(tx.instructions[0]).units, 160_000)
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(tx.instructions[1]).microLamports, 300_000n)
  const result = await sign(async unsigned => transport(phantomAutoFees(transport(unsigned), f.payer)))
  const final = Transaction.from(result.raw)
  assert.deepEqual(final.serializeMessage(), reviewed)
  assert.equal(final.verifySignatures(), true)
  await assert.rejects(withLaunchPriorityFee(budgetRpc, tx, { feePayer: f.payer.publicKey, blockhash: tx.recentBlockhash, log: () => {} }), /exactly once/)
})
for (const [label, change] of [['re-price', ix => { ix[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }) }],
  ['raise the limit of', ix => { ix[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }) }],
  ['drop the budget of', ix => { ix.splice(0, 2) }]]) {
  test(`wallet cannot ${label} the reviewed priority fee`, async () => {
    const f = fixture(), tx = await priced(f)
    const sign = prepareLaunchSigning(tx, f.payer.publicKey, f.creator, f.mint)
    await assert.rejects(sign(async unsigned => {
      const returned = transport(unsigned)
      change(returned.instructions)
      returned.partialSign(f.payer)
      return transport(returned)
    }), /wallet changed/)
    assert.equal(f.cosigns(), 0)
  })
}

import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { LIGHTHOUSE_PROGRAM } from '../src/launch-wallet-assertions.mjs'
const assertion = (key, kind = 5) => new TransactionInstruction({
  programId: new PublicKey(LIGHTHOUSE_PROGRAM), keys: [{pubkey:key,isSigner:false,isWritable:false}],
  // AssertAccountInfo / Silent / Executable(false): a real read-only assertion.
  data: Buffer.from([kind,0,7,0,0]),
})
test('Phantom trailing assertions survive transport and keep the user signature while server co-signs', async()=>{
 const f=fixture();let userSig
 const result=await f.sign(async tx=>{
  const returned=transport(tx);returned.add(assertion(f.payer.publicKey),assertion(f.mint.publicKey))
  returned.partialSign(f.payer);userSig=Buffer.from(returned.signature);return transport(returned)
 })
 const final=Transaction.from(result.raw)
 assert.ok(final.verifySignatures());assert.deepEqual(final.signature,userSig)
 assert.equal(final.instructions.length,f.tx.instructions.length+2);assert.equal(f.cosigns(),2)
})
for(const mutation of ['memory write','memory close','unknown opcode','unknown program','new account','new signer','writable escalation','changed transfer','inserted assertion','changed blockhash','extra transfer']){
 test(`assertion compatibility rejects ${mutation} before co-signing`,async()=>{
  const f=fixture()
  await assert.rejects(f.sign(async tx=>{
   const returned=transport(tx),ix=assertion(f.payer.publicKey)
   if(mutation==='memory write')ix.data[0]=0
   if(mutation==='memory close')ix.data[0]=1
   if(mutation==='unknown opcode')ix.data[0]=255
   if(mutation==='unknown program')ix.programId=SystemProgram.programId
   if(mutation==='new account')ix.keys[0].pubkey=Keypair.generate().publicKey
   if(mutation==='new signer'){ix.keys[0].pubkey=TOKEN_PROGRAM_ID;ix.keys[0].isSigner=true}
   if(mutation==='writable escalation'){ix.keys[0].pubkey=TOKEN_PROGRAM_ID;ix.keys[0].isWritable=true}
   if(mutation==='changed transfer')returned.instructions[1].data[4]^=1
   if(mutation==='changed blockhash')returned.recentBlockhash=Keypair.generate().publicKey.toBase58()
   if(mutation==='inserted assertion')returned.instructions.unshift(ix);else returned.add(ix)
   if(mutation==='extra transfer')returned.add(SystemProgram.transfer({fromPubkey:f.payer.publicKey,toPubkey:f.creator.publicKey,lamports:1000}))
   returned.partialSign(f.payer);return returned
  }),DefinitiveLaunchError)
  assert.equal(f.cosigns(),0)
 })
}
