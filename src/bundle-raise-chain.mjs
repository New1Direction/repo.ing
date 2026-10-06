import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import { ComputeBudgetProgram, PublicKey, SendTransactionError, Transaction, VersionedTransaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { BUNDLE_VAULT_PROGRAM_ID, backerAddress, bundleAccounts, bundleAddress, decodeBacker, decodeBundle, tokenAccountOf } from './bundle-vault.mjs'
import { BundleRaiseError, simulationFailure } from './bundle-raise.mjs'
import { broadcastUntilSettled, chooseComputeUnitPrice, computeUnitLimit, priorityFeeLamports } from './trade-landing.mjs'

// What the raise flow reads from and sends to Solana (docs/BUNDLE_LAUNCH.md). The chain is the source of truth for a bundle's
// raise, deadline, status and vault; the bundles table only ties a bundle to its repository. connection: a web3.js Connection.

const COMMITMENT = 'confirmed'
// The Backer account's discriminator and layout (programs/bundle-vault: Backer = discriminator, bundle, wallet, shares, paid,
// bump), for the filtered reads below.
const BACKER_DISCRIMINATOR = bs58.encode(createHash('sha256').update('account:Backer').digest().subarray(0, 8))
const BACKER_BUNDLE_OFFSET = 8
const BACKER_WALLET_OFFSET = 40
const backerFilter = (offset, key) => [{ memcmp: { offset: 0, bytes: BACKER_DISCRIMINATOR } }, { memcmp: { offset, bytes: new PublicKey(key).toBase58() } }]

// The Bundle account by id, decoded, or null while it does not exist.
export async function readBundle(connection, id) {
  const info = await connection.getAccountInfo(bundleAddress(id), COMMITMENT)
  return info && info.owner.equals(BUNDLE_VAULT_PROGRAM_ID) ? decodeBundle(info.data) : null
}

// A wallet's Backer account in a bundle, decoded, or null.
export async function readBacker(connection, id, wallet) {
  const info = await connection.getAccountInfo(backerAddress(bundleAddress(id), wallet), COMMITMENT)
  return info && info.owner.equals(BUNDLE_VAULT_PROGRAM_ID) ? decodeBacker(info.data) : null
}

// How many wallets back a bundle now (a refund closes its backer account). Reads no account data.
export async function countBackers(connection, id) {
  const accounts = await connection.getProgramAccounts(BUNDLE_VAULT_PROGRAM_ID, { commitment: COMMITMENT,
    filters: backerFilter(BACKER_BUNDLE_OFFSET, bundleAddress(id)), dataSlice: { offset: 0, length: 0 } })
  return accounts.length
}

// Every bundle a wallet backs: its Backer accounts and their bundles, decoded ({ id, bundle, backer }).
export async function walletBackers(connection, wallet) {
  const accounts = await connection.getProgramAccounts(BUNDLE_VAULT_PROGRAM_ID, { commitment: COMMITMENT, filters: backerFilter(BACKER_WALLET_OFFSET, wallet) })
  const backers = accounts.map(({ account }) => decodeBacker(account.data))
  if (!backers.length) return []
  const infos = await connection.getMultipleAccountsInfo(backers.map(backer => backer.bundle), COMMITMENT)
  return backers.flatMap((backer, index) => {
    const info = infos[index]
    if (!info?.owner.equals(BUNDLE_VAULT_PROGRAM_ID)) return []
    const bundle = decodeBundle(info.data)
    return [{ id: bundle.id, bundle, backer }]
  })
}

// Whether a wallet's wrapped SOL account exists (a claim then keeps it, src/bundle-raise.mjs actionInstructions).
export async function hasWrappedSolAccount(connection, wallet) {
  return Boolean(await connection.getAccountInfo(tokenAccountOf(new PublicKey(wallet), NATIVE_MINT), COMMITMENT))
}

// A launched bundle's vault: its market tokens and wrapped SOL (null while an account is missing or unreadable).
export async function vaultHoldings(connection, bundle) {
  const accounts = bundleAccounts({ id: bundle.id, mint: bundle.mint })
  const balance = account => connection.getTokenAccountBalance(account, COMMITMENT).then(result => BigInt(result.value.amount), () => null)
  const [tokens, sol] = await Promise.all([balance(accounts.vaultTokens), balance(accounts.vaultSol)])
  return { tokens, sol }
}

const budgeted = (instructions, { feePayer, blockhash, units, microLamports }) => new Transaction({ feePayer, recentBlockhash: blockhash })
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...instructions)
const PROBE_UNITS = 1_400_000

// The unsigned transaction a wallet signs: [unit limit, unit price, ...instructions], paid by feePayer. Both budget instructions
// are set so the wallet does not add its own (src/launch-wallet-fees.mjs). It is simulated first, signatures unchecked: a
// failure is refused here with its plain message (simulationFailure), so nothing that would fail is offered for signing.
// fallback: the message when the logs name no known cause.
export async function walletTransaction(connection, instructions, { feePayer, fallback, log = console.warn }) {
  const latest = await connection.getLatestBlockhash(COMMITMENT)
  const probe = budgeted(instructions, { feePayer, blockhash: latest.blockhash, units: PROBE_UNITS, microLamports: 0 })
  const encoded = probe.serialize({ requireAllSignatures: false, verifySignatures: false })
  const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(encoded), { commitment: COMMITMENT, sigVerify: false })
  if (value.err) throw new BundleRaiseError(simulationFailure(value.logs, fallback))
  const writableAccounts = [...new Map(instructions.flatMap(ix => ix.keys.filter(key => key.isWritable).map(key => [key.pubkey.toBase58(), key.pubkey]))).values()]
  const units = computeUnitLimit(value.unitsConsumed)
  const microLamports = await chooseComputeUnitPrice(connection, { probe, writableAccounts, log })
  const transaction = budgeted(instructions, { feePayer, blockhash: latest.blockhash, units, microLamports })
  return { transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    lastValidBlockHeight: latest.lastValidBlockHeight, priorityFeeLamports: priorityFeeLamports({ units, microLamports }).toString() }
}

// Sends signed bytes and waits until they confirm, fail or expire (src/trade-landing.mjs broadcastUntilSettled):
// { signature, confirmed: true } once confirmed (or already processed: the same bytes landed before), { signature, confirmed:
// false } while it is still unknown. A refusal before sending (its preflight) or a failure on chain changed nothing and is
// refused with its plain message. broadcast: broadcastUntilSettled's pacing options (tests).
export async function sendSigned(connection, { raw, signature, lastValidBlockHeight }, broadcast = {}) {
  if (!Number.isSafeInteger(lastValidBlockHeight)) throw new BundleRaiseError('This transaction expired. Try again.')
  let result
  try { result = await broadcastUntilSettled(connection, raw, { ...broadcast, signature, lastValidBlockHeight }) }
  catch (error) {
    if (!(error instanceof SendTransactionError)) throw error
    if (/already (been )?processed/i.test(String(error.transactionError?.message ?? error.message))) return { signature, confirmed: true }
    throw new BundleRaiseError(simulationFailure(error.logs, 'Solana refused the transaction before sending it. Nothing changed. Try again.'))
  }
  if (result.state === 'confirmed') return { signature, confirmed: true }
  if (result.state === 'failed') throw new BundleRaiseError('The transaction failed on Solana. Nothing changed. Refresh and try again.')
  if (result.state === 'expired') throw new BundleRaiseError('The transaction expired before it landed. Nothing changed. Try again.')
  return { signature, confirmed: false }
}
