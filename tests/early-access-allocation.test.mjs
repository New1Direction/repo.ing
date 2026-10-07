import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { Keypair, Transaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync } from '@solana/spl-token'
import { settleAllocation } from '../src/builder-allocation-settlement.mjs'
import { BUILDER_ALLOCATION } from '../src/builder-allocation.mjs'

// Step 7e (docs/EARLY_ACCESS.md): an early access market's grant is the same 1% transferChecked under Token-2022, to the recipient's
// Token-2022 account. The settlement finds it under either program, and only to the account under that same program.
const creator = Keypair.generate(), wallet = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
function grant(program, { to = program } = {}) {
  const source = getAssociatedTokenAddressSync(mint, creator.publicKey, false, program)
  const destination = getAssociatedTokenAddressSync(mint, wallet, false, to)
  const tx = new Transaction({ feePayer: creator.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, destination, wallet, mint, to),
      createTransferCheckedInstruction(source, mint, destination, creator.publicKey, BUILDER_ALLOCATION, 6, [], program))
  tx.sign(creator)
  const message = tx.compileMessage(), at = message.accountKeys.findIndex(key => key.equals(destination))
  const intent = { signature: bs58.encode(tx.signature), signedTransaction: tx.serialize().toString('base64'), wallet: wallet.toBase58(),
    mint: mint.toBase58(), amount: String(BUILDER_ALLOCATION) }
  const receipt = (posted = to) => ({ transaction: { signatures: [intent.signature], message }, meta: { err: null, preTokenBalances: [],
    postTokenBalances: [{ accountIndex: at, owner: wallet.toBase58(), mint: mint.toBase58(), programId: posted.toBase58(),
      uiTokenAmount: { decimals: 6, amount: String(BUILDER_ALLOCATION) } }] } })
  return { intent, receipt }
}
const client = () => { const updates = []; return { updates, query: async (sql, params) => { updates.push([sql, params]); return { rows: [] } } } }
const connection = receipt => ({ getTransaction: async () => receipt })

test('a Token-2022 grant settles like an SPL one', async () => {
  for (const program of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    const { intent, receipt } = grant(program), db = client()
    assert.deepEqual(await settleAllocation(db, connection(receipt()), intent),
      { status: 'settled', signature: intent.signature, amount: String(BUILDER_ALLOCATION), wallet: intent.wallet, mint: intent.mint })
    assert.match(db.updates[0][0], /status='settled'/)
  }
})

test('a grant to the account of the other program, or a balance read under the other program, is refused', async () => {
  const crossed = grant(TOKEN_2022_PROGRAM_ID, { to: TOKEN_PROGRAM_ID })
  await assert.rejects(settleAllocation(client(), connection(crossed.receipt()), crossed.intent), /does not match the fixed grant/)
  const { intent, receipt } = grant(TOKEN_2022_PROGRAM_ID)
  await assert.rejects(settleAllocation(client(), connection(receipt(TOKEN_PROGRAM_ID)), intent), /did not receive exactly 1%/)
})
