// Read-only mainnet check of tip transactions: simulates (never signs for real, never sends) a tip prepared exactly as the
// API prepares it, for a real holder wallet as the unsigned payer, and a tip-wallet payout from a random keypair.
// Usage: SOLANA_RPC_URL=<mainnet rpc> node scripts/simulate-tips.mjs [USDC|NVDAx|...] [holderWallet]
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token'
import { TIP_TOKENS, tipTokenPrices } from '../src/tip-tokens.mjs'
import { prepareTip } from '../src/tips.mjs'
import { transferInstructions } from '../src/tip-transfers.mjs'
import { withPriorityFee } from '../src/trade-landing.mjs'

const connection = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
const token = TIP_TOKENS.find(t => t.symbol === (process.argv[2] ?? 'USDC'))
if (!token || token.kind === 'native') throw Error('Choose an allowlisted SPL or Token-2022 symbol')
const mint = new PublicKey(token.mint), program = new PublicKey(token.program)
const simulate = tx => connection.simulateTransaction(VersionedTransaction.deserialize(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
  { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }).then(r => r.value)

// A real holder: the given wallet, or the owner of one of the largest token accounts that is a normal wallet with SOL.
async function holder() {
  if (process.argv[3]) return new PublicKey(process.argv[3])
  // Recent finalized transfers of the mint name real, active holders (largest-accounts is rate limited on public RPCs).
  const signatures = await connection.getSignaturesForAddress(mint, { limit: 25 }, 'finalized')
  const seen = new Set()
  for (const { signature, err } of signatures) {
    if (err) continue
    const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }).catch(() => null)
    for (const balance of tx?.meta?.postTokenBalances ?? []) {
      if (balance.mint !== token.mint || !balance.owner || seen.has(balance.owner)) continue
      seen.add(balance.owner)
      const owner = new PublicKey(balance.owner)
      if (BigInt(balance.uiTokenAmount.amount) < 10n ** BigInt(token.decimals) || !PublicKey.isOnCurve(owner.toBytes())) continue
      const address = getAssociatedTokenAddressSync(mint, owner, false, program)
      const info = await connection.getAccountInfo(address)
      if (!info || unpackAccount(address, info, program).isFrozen) continue
      if (await connection.getBalance(owner) >= 10_000_000) return owner
    }
  }
  throw Error('No suitable holder found; pass one as the second argument')
}

const donor = await holder()
const tipWallet = Keypair.generate().publicKey
const prices = await tipTokenPrices()
const pool = { query: async sql => (/from markets/.test(sql) ? { rows: [{ repoId: '1' }] } : { rows: [], rowCount: 1 }) }
const prepared = await prepareTip({ pool, connection, tipWallet, prices, githubRepoId: '1', wallet: donor.toBase58(), mint: token.mint,
  amountBaseUnits: (BigInt(Math.ceil(6 / prices[token.mint] * 10 ** token.decimals))).toString() })
const tip = await simulate(Transaction.from(Buffer.from(prepared.transaction, 'base64')))
const tipLogs = tip.logs ?? []
console.log(JSON.stringify({ check: 'tip', token: token.symbol, donor: donor.toBase58(), amount: prepared.amountBaseUnits, err: tip.err, unitsConsumed: tip.unitsConsumed,
  memo: tipLogs.some(l => l.includes(`repoing-tip:${prepared.id}`)), tokenProgram: tipLogs.some(l => l.startsWith(`Program ${token.program} invoke`)) }))
if (tip.err) process.exitCode = 1

// Payout from a random, unfunded tip wallet: must fail only because that wallet holds nothing.
async function payout(source, amount) {
  const latest = await connection.getLatestBlockhash('confirmed')
  const base = new Transaction({ feePayer: source, recentBlockhash: latest.blockhash }).add(...transferInstructions({ kind: 'payout', id: crypto.randomUUID(),
    source, recipient: Keypair.generate().publicKey, mint: token.mint, tokenProgram: token.program, decimals: token.decimals, amount }))
  const { transaction } = await withPriorityFee(connection, base, { feePayer: source, blockhash: latest.blockhash,
    writableAccounts: base.instructions.flatMap(ix => ix.keys.filter(k => k.isWritable).map(k => k.pubkey)), log: () => {} })
  return simulate(transaction)
}
const random = await payout(Keypair.generate().publicKey, 1_000_000n)
console.log(JSON.stringify({ check: 'payout-random-tip-wallet', err: random.err, logs: (random.logs ?? []).slice(-3) }))
if (random.err !== 'AccountNotFound' && JSON.stringify(random.err).indexOf('InsufficientFunds') < 0) process.exitCode = 1
// Same payout with the real holder as the source for more than it holds: the fee payer exists, so the only failure left
// is the token program's own insufficient-funds check on transfer_checked.
const heldAccount = getAssociatedTokenAddressSync(mint, donor, false, program)
const held = unpackAccount(heldAccount, await connection.getAccountInfo(heldAccount), program).amount
const funded = await payout(donor, held + 1n)
const insufficient = (funded.logs ?? []).some(l => /insufficient funds/i.test(l))
console.log(JSON.stringify({ check: 'payout-exceeds-balance', err: funded.err, insufficientFunds: insufficient, logs: (funded.logs ?? []).filter(l => /insufficient|TransferChecked|Create/i.test(l)) }))
if (!insufficient) process.exitCode = 1
