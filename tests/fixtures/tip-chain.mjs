// Shared by tests/tips.test.mjs and tests/parts-fund.test.mjs: mint fixtures and a small in-memory Solana that executes
// exactly the instruction shapes tip-wallet transfers use (system transfer, idempotent ATA, transfer_checked, memo).
import bs58 from 'bs58'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType } from '@solana/spl-token'
import { MEMO_PROGRAM } from '../../src/tips.mjs'
import { LIGHTHOUSE_PROGRAM } from '../../src/launch-wallet-assertions.mjs'

export const BLOCKHASH = Keypair.generate().publicKey.toBase58()

export function mintData({ decimals, extensions = [] }) {
  const base = Buffer.alloc(MINT_SIZE)
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 10n ** 12n, decimals, isInitialized: true,
    freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, base)
  if (!extensions.length) return base
  const tlv = Buffer.concat(extensions.map(([type, data]) => {
    const header = Buffer.alloc(4); header.writeUInt16LE(type, 0); header.writeUInt16LE(data.length, 2)
    return Buffer.concat([header, data])
  }))
  return Buffer.concat([base, Buffer.alloc(165 - MINT_SIZE), Buffer.from([1]), tlv])
}
export const hookExt = programId => [ExtensionType.TransferHook, Buffer.concat([Keypair.generate().publicKey.toBuffer(), programId.toBuffer()])]
export const feeExt = (bps, maximum = 0n) => {
  const data = Buffer.alloc(108)
  const schedule = offset => { data.writeBigUInt64LE(0n, offset); data.writeBigUInt64LE(maximum, offset + 8); data.writeUInt16LE(bps, offset + 16) }
  schedule(72); schedule(90)
  return [ExtensionType.TransferFeeConfig, data]
}
export const pausedExt = paused => [ExtensionType.PausableConfig, Buffer.concat([Keypair.generate().publicKey.toBuffer(), Buffer.from([paused ? 1 : 0])])]
export const defaultStateExt = state => [ExtensionType.DefaultAccountState, Buffer.from([state])]
export const xstockMint = (extensions = [hookExt(PublicKey.default), pausedExt(false), defaultStateExt(1)]) =>
  ({ owner: TOKEN_2022_PROGRAM_ID, data: mintData({ decimals: 8, extensions }), lamports: 1, executable: false })
export const splMint = () => ({ owner: TOKEN_PROGRAM_ID, data: mintData({ decimals: 6 }), lamports: 1, executable: false })

const RENT = 2_039_280n
export function fakeChain({ lamports = {}, mints = {}, height = 1000 } = {}) {
  const state = { lamports: new Map(Object.entries(lamports).map(([k, v]) => [k, BigInt(v)])), tokens: new Map(), mints: new Map(Object.entries(mints)) }
  const receipts = new Map(), sent = []
  let blockHeight = height, mode = 'land'
  const tokenAccount = (address, mint, owner, programId, amount = 0n) => state.tokens.set(address, { mint, owner, programId, amount })
  function execute(tx) {
    const message = tx.compileMessage(), keys = message.accountKeys.map(k => k.toBase58())
    const pre = keys.map(k => state.lamports.get(k) ?? 0n)
    const tokenSnapshot = () => keys.map((k, i) => state.tokens.has(k) ? { accountIndex: i, mint: state.tokens.get(k).mint, owner: state.tokens.get(k).owner,
      programId: state.tokens.get(k).programId, uiTokenAmount: { amount: state.tokens.get(k).amount.toString() } } : null).filter(Boolean)
    const preTokens = tokenSnapshot()
    const saved = { lamports: new Map(state.lamports), tokens: new Map([...state.tokens].map(([k, v]) => [k, { ...v }])) }
    let err = null
    const payer = keys[0], fee = 5000n
    const debit = (key, amount) => { const have = state.lamports.get(key) ?? 0n; if (have < amount) throw Error('insufficient lamports'); state.lamports.set(key, have - amount) }
    try {
      debit(payer, fee)
      for (const ix of tx.instructions) {
        const program = ix.programId
        if (program.equals(SystemProgram.programId)) {
          const { fromPubkey, toPubkey, lamports: amount } = SystemInstruction.decodeTransfer(ix)
          debit(fromPubkey.toBase58(), BigInt(amount))
          state.lamports.set(toPubkey.toBase58(), (state.lamports.get(toPubkey.toBase58()) ?? 0n) + BigInt(amount))
        } else if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
          const [funder, ata, owner, mint, , tokenProgram] = ix.keys.map(k => k.pubkey.toBase58())
          if (!state.tokens.has(ata)) { debit(funder, RENT); state.lamports.set(ata, RENT); tokenAccount(ata, mint, owner, tokenProgram) }
        } else if (program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) {
          if (ix.data[0] !== 12) throw Error('unexpected token instruction')
          const amount = ix.data.readBigUInt64LE(1)
          const [source, mint, destination, authority] = ix.keys.map(k => k.pubkey.toBase58())
          const from = state.tokens.get(source), to = state.tokens.get(destination)
          if (!from || !to || from.mint !== mint || to.mint !== mint || from.owner !== authority) throw Error('invalid token accounts')
          if (from.amount < amount) throw Error('insufficient funds')
          from.amount -= amount; to.amount += amount
        } else if (!program.equals(MEMO_PROGRAM) && !program.equals(ComputeBudgetProgram.programId) && program.toBase58() !== LIGHTHOUSE_PROGRAM) throw Error('unknown program')
      }
    } catch (error) { err = { InstructionError: [0, error.message] }; state.lamports = saved.lamports; state.tokens = saved.tokens; debit(payer, fee) }
    return { slot: 1, meta: { err, fee: 5000, preBalances: pre.map(Number), postBalances: keys.map(k => Number(state.lamports.get(k) ?? 0n)),
      preTokenBalances: preTokens, postTokenBalances: tokenSnapshot(), logMessages: err ? [`Program log: Error: ${err.InstructionError[1]}`] : [] },
      transaction: { signatures: [tx.signature ? bs58.encode(tx.signature) : null], message } }
  }
  const connection = {
    rpcEndpoint: 'http://127.0.0.1:8899',
    state, sent, receipts, tokenAccount,
    setMode(value) { mode = value }, advance(n) { blockHeight += n },
    async getAccountInfo(key) {
      const k = key.toBase58()
      if (state.mints.has(k)) return state.mints.get(k)
      const t = state.tokens.get(k)
      if (!t) return null
      const data = Buffer.alloc(165)
      new PublicKey(t.mint).toBuffer().copy(data, 0); new PublicKey(t.owner).toBuffer().copy(data, 32); data.writeBigUInt64LE(t.amount, 64); data[108] = 1
      return { owner: new PublicKey(t.programId), data, lamports: Number(RENT), executable: false }
    },
    async getBalance(key) { return Number(state.lamports.get(key.toBase58()) ?? 0n) },
    async getEpochInfo() { return { epoch: 900 } },
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: blockHeight + 150 } },
    async getRecentPrioritizationFees() { return [] },
    async simulateTransaction(tx) {
      const legacy = tx.message ? Transaction.populate(tx.message, tx.signatures.map(s => bs58.encode(s))) : tx
      const saved = { lamports: new Map(state.lamports), tokens: new Map([...state.tokens].map(([k, v]) => [k, { ...v }])) }
      const receipt = execute(legacy)
      state.lamports = saved.lamports; state.tokens = saved.tokens
      return { value: { err: receipt.meta.err, logs: receipt.meta.logMessages, unitsConsumed: 20_000 } }
    },
    async sendRawTransaction(raw) {
      const tx = Transaction.from(raw), signature = bs58.encode(tx.signature)
      sent.push(signature)
      if (mode === 'land' && !receipts.has(signature)) receipts.set(signature, execute(tx))
      return signature
    },
    async getSignatureStatuses(signatures) {
      return { context: { slot: 10 }, value: signatures.map(s => receipts.has(s) ? { confirmationStatus: 'finalized', err: receipts.get(s).meta.err } : null) }
    },
    async getTransaction(signature) { return receipts.get(signature) ?? null },
    async confirmTransaction({ signature }) { return { value: { err: receipts.get(signature)?.meta.err ?? null } } },
    async getBlockHeight() { return blockHeight },
    async getSlot() { return 10 },
  }
  return connection
}
