// Read-only mainnet check of a parts-fund pledge: prepares a USDC (or SOL) pledge exactly as /api/parts-fund does, for a
// real holder wallet as the unsigned payer, and simulates it (never signs, never sends). Also simulates the tip-wallet
// payout/refund shape from a random, unfunded wallet, which must fail only for lack of funds.
// Usage: SOLANA_RPC_URL=<mainnet rpc> node scripts/simulate-parts-pledge.mjs [USDC|SOL] [holderWallet]
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token'
import { tipTokenPrices } from '../src/tip-tokens.mjs'
import { PARTS_TOKENS, pledgeMemo } from '../src/parts-fund.mjs'
import { preparePledge } from '../src/parts-pledges.mjs'
import { partsTransferMemo } from '../src/parts-settlement.mjs'
import { transferInstructions } from '../src/tip-transfers.mjs'
import { withPriorityFee } from '../src/trade-landing.mjs'

const connection = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
const token = PARTS_TOKENS.find(t => t.symbol === (process.argv[2] ?? 'USDC'))
if (!token) throw Error('Choose USDC or SOL')
const simulate = tx => connection.simulateTransaction(VersionedTransaction.deserialize(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
  { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }).then(r => r.value)

// A real holder: the given wallet, or an owner seen in recent finalized transfers of the mint holding ≥ 10 tokens and SOL.
async function holder() {
  if (process.argv[3]) return new PublicKey(process.argv[3])
  if (token.symbol === 'SOL') throw Error('Pass a SOL holder wallet as the second argument')
  const mint = new PublicKey(token.mint), program = new PublicKey(token.program)
  const signatures = await connection.getSignaturesForAddress(mint, { limit: 25 }, 'finalized')
  const seen = new Set()
  for (const { signature, err } of signatures) {
    if (err) continue
    const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }).catch(() => null)
    for (const balance of tx?.meta?.postTokenBalances ?? []) {
      if (balance.mint !== token.mint || !balance.owner || seen.has(balance.owner)) continue
      seen.add(balance.owner)
      const owner = new PublicKey(balance.owner)
      if (BigInt(balance.uiTokenAmount.amount) < 10n * 10n ** BigInt(token.decimals) || !PublicKey.isOnCurve(owner.toBytes())) continue
      const address = getAssociatedTokenAddressSync(mint, owner, false, program)
      const info = await connection.getAccountInfo(address)
      if (!info || unpackAccount(address, info, program).isFrozen || unpackAccount(address, info, program).amount < 10n ** 7n) continue
      if (await connection.getBalance(owner) >= 10_000_000) return owner
    }
  }
  throw Error('No suitable holder found; pass one as the second argument')
}

const donor = await holder()
const tipWallet = Keypair.generate().publicKey
const prices = await tipTokenPrices()
if (!prices[token.mint]) throw Error('No price for the token right now')
// An in-memory stand-in for the database: one open $500 list on a repository that has a market. Nothing is written.
const fund = { id: crypto.randomUUID(), githubRepoId: '1', revision: 1, status: 'open', goalCents: 50_000, deadline: new Date(Date.now() + 7 * 86_400_000) }
const query = async sql => {
  if (/from parts_funds where id=/.test(sql)) return { rows: [fund] }
  if (/from markets/.test(sql)) return { rows: [{ repoId: '1' }] }
  if (/from parts_pledges where status in/.test(sql)) return { rows: [{ list: '0', global: '0', openByWallet: 0 }] }
  return { rows: [], rowCount: 1 }
}
const pool = { query, connect: async () => ({ query, release() {} }) }
const amount = BigInt(Math.ceil(6 / prices[token.mint] * 10 ** token.decimals)).toString()
const prepared = await preparePledge({ pool, connection, tipWallet, prices, fundId: fund.id, revision: 1, wallet: donor.toBase58(), mint: token.mint, amountBaseUnits: amount })
const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'))
const pledge = await simulate(tx)
const logs = pledge.logs ?? []
console.log(JSON.stringify({ check: 'pledge', token: token.symbol, donor: donor.toBase58(), amount: prepared.amountBaseUnits, usdCents: prepared.usdCents,
  signed: tx.signatures.some(s => s.signature), programs: tx.instructions.map(ix => ix.programId.toBase58()), err: pledge.err, unitsConsumed: pledge.unitsConsumed,
  memo: logs.some(l => l.includes(pledgeMemo(prepared.id))), tokenProgram: logs.some(l => l.startsWith(`Program ${token.program} invoke`)) }))
if (pledge.err || !logs.some(l => l.includes(pledgeMemo(prepared.id)))) process.exitCode = 1

// Payout/refund shape from a random, unfunded tip wallet: must fail only because that wallet holds nothing.
const latest = await connection.getLatestBlockhash('confirmed')
const source = Keypair.generate().publicKey, id = crypto.randomUUID()
const base = new Transaction({ feePayer: source, recentBlockhash: latest.blockhash }).add(...transferInstructions({ kind: 'refund', id, source, recipient: donor,
  mint: token.mint, tokenProgram: token.program, decimals: token.decimals, amount: BigInt(amount), memo: partsTransferMemo('refund', id) }))
const { transaction } = await withPriorityFee(connection, base, { feePayer: source, blockhash: latest.blockhash,
  writableAccounts: base.instructions.flatMap(ix => ix.keys.filter(k => k.isWritable).map(k => k.pubkey)), log: () => {} })
const refund = await simulate(transaction)
console.log(JSON.stringify({ check: 'refund-from-unfunded-wallet', err: refund.err }))
if (refund.err !== 'AccountNotFound' && JSON.stringify(refund.err).indexOf('InsufficientFunds') < 0) process.exitCode = 1
