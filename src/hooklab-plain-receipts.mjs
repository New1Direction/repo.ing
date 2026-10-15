// Retained-signature indexer. No cursor can skip an unresolved signature and no send/retry method exists.
import { isDeepStrictEqual } from 'node:util'
import bs58 from 'bs58'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { productionCandidateManifest, creatorAuthorizationAddress, PRODUCTION_PROGRAMS,
  decodeLaunchConfig, decodeSwapConfig } from '@repo-ing/hooklab-production-candidate'
import { reconcileHookLabReceipts, verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'
import { preparePlainReview, verifyPlainPostconditions } from './hooklab-plain.mjs'

const check = (ok, text) => { if (!ok) throw new Error(text) }
export function plainRecoveryInventory(plan) {
  const profile = productionCandidateManifest()
  return { mint: plan.intent.mint, ...plan.addresses, launchConfig: profile.pdas.launchConfig,
    swapConfig: profile.pdas.swapConfig, creatorGrant: creatorAuthorizationAddress(new PublicKey(plan.intent.creator), PRODUCTION_PROGRAMS.launch).toBase58() }
}

export async function readPlainReceipt(connection, provider, plan, signedBase64) {
  const retained = verifyHookLabSignedMessage(plan.review, signedBase64)
  check(await connection.getGenesisHash() === plan.review.genesisHash, 'Wrong recovery network')
  const tx = await connection.getTransaction(retained.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  if (!tx) return { provider, receipt: null }
  const wire = new VersionedTransaction(tx.transaction.message)
  wire.signatures = tx.transaction.signatures.map(s => bs58.decode(s))
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
  const inventory = plainRecoveryInventory(plan)
  const snapshot = tx.meta?.err === null ? await connection.getMultipleAccountsInfoAndContext(Object.values(inventory).map(a => new PublicKey(a)),
    { commitment: 'finalized', minContextSlot: tx.slot }) : null
  return { provider, receipt: { genesisHash: plan.review.genesisHash, signature: tx.transaction.signatures[0],
    messageSha256: retained.messageSha256, signedTransactionBase64: Buffer.from(wire.serialize()).toString('base64'),
    slot: tx.slot, confirmationStatus: 'finalized', feeLamports: String(tx.meta?.fee), error: tx.meta?.err,
    balances: Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), before: tx.meta?.preBalances[i], after: tx.meta?.postBalances[i] })),
  }, snapshot: snapshot ? { slot: snapshot.context.slot, accounts: Object.fromEntries(Object.entries(inventory).map(([role, address], i) => {
    const a = snapshot.value[i]
    return [role, a ? { address, owner: a.owner.toBase58(), executable: a.executable, dataBase64: a.data.toString('base64') } : null]
  })) } : null }
}

/** Verify exact receipt and observed plain state, but never conflate this with adopted deployment trust.
 * Later mutations require review; no state can authorize a replacement launch or submission.
 */
export function verifyPlainReceipt(plan, signedBase64, observations, providers) {
  check(isDeepStrictEqual(preparePlainReview(plan.intent, plan.observed), plan), 'Plan differs')
  const base = reconcileHookLabReceipts(plan.review, signedBase64, observations, providers)
  const result = { ...base, chainVerified: false }
  if (base.status !== 'finalized-transaction-only') return result
  try {
    check(observations.every(o => o.snapshot && Number.isSafeInteger(o.snapshot.slot) && o.snapshot.slot >= o.receipt.slot), 'Missing finalized state')
    check(isDeepStrictEqual(observations[0].snapshot.accounts, observations[1].snapshot.accounts), 'State providers disagree')
    const accounts = observations[0].snapshot.accounts
    verifyPlainPostconditions(plan, accounts)
    const profile = productionCandidateManifest()
    for (const [role, owner, counter, decode, pre] of [
      ['launchConfig', PRODUCTION_PROGRAMS.launch, 'launches', decodeLaunchConfig, plan.observed.launchConfigBase64],
      ['swapConfig', PRODUCTION_PROGRAMS.swap, 'poolsCreated', decodeSwapConfig, plan.observed.swapConfigBase64],
    ]) {
      check(accounts[role].address === profile.pdas[role] && accounts[role].owner === owner.toBase58() && !accounts[role].executable, 'Config identity differs')
      const raw = Buffer.from(accounts[role].dataBase64, 'base64')
      check(raw.length === Buffer.from(pre, 'base64').length && raw[8] === 1 && raw.toString('base64') === accounts[role].dataBase64, 'Config layout differs')
      const before = decode(Buffer.from(pre, 'base64')), after = decode(raw)
      check(after[counter] === before[counter] + 1n && isDeepStrictEqual({ ...after, [counter]: before[counter] }, before), 'Config counter/economics drift')
    }
    const grantAccount = accounts.creatorGrant, grant = plan.observed.creatorGrant, raw = Buffer.from(grantAccount.dataBase64, 'base64')
    check(grantAccount.address === plainRecoveryInventory(plan).creatorGrant && grantAccount.owner === PRODUCTION_PROGRAMS.launch.toBase58()
      && !grantAccount.executable && raw.length === 73 && raw.toString('base64') === grantAccount.dataBase64
      && raw.subarray(0, 8).equals(Buffer.from([184, 253, 149, 202, 97, 60, 227, 163]))
      && new PublicKey(raw.subarray(8, 40)).toBase58() === grant.creator && raw[40] === 1
      && raw.readBigUInt64LE(41) === BigInt(grant.expiresAtSlot) && raw.readBigUInt64LE(49) === BigInt(grant.maxLaunches)
      && raw.readBigUInt64LE(57) === BigInt(grant.consumed) + 1n && raw.readBigUInt64LE(65) === BigInt(grant.revision), 'Creator counter/grant drift')
    const balances = observations[0].receipt.balances
    check(Array.isArray(balances) && balances.length === plan.review.accounts.length
      && balances.every((b, i) => b.address === plan.review.accounts[i].address && Number.isSafeInteger(b.before)
        && b.before >= 0 && Number.isSafeInteger(b.after) && b.after >= 0), 'Receipt balance inventory differs')
    const expected = new Map(), add = (address, amount) => expected.set(address, (expected.get(address) ?? 0n) + amount)
    let rent = 0n
    for (const address of [plan.intent.mint, ...Object.values(plan.addresses)]) {
      const b = balances.find(b => b.address === address)
      check(b?.before === 0 && b.after > 0, 'Creation account preexisted or rent missing')
      rent += BigInt(b.after); add(address, BigInt(b.after))
    }
    const launch = decodeLaunchConfig(Buffer.from(plan.observed.launchConfigBase64, 'base64'))
    const swap = decodeSwapConfig(Buffer.from(plan.observed.swapConfigBase64, 'base64'))
    const fees = launch.launchFeeLamports + swap.poolCreationFeeLamports, debit = fees + rent
    check(rent <= BigInt(plan.intent.maxRentLamports) && debit <= BigInt(plan.intent.maxInstructionDebitLamports), 'Instruction rent/debit cap exceeded')
    add(plan.intent.creator, -debit); add(plan.intent.feePayer, -BigInt(plan.outerPayerNetworkFee)); add(launch.treasury.toBase58(), fees)
    check(balances.every(b => BigInt(b.after) - BigInt(b.before) === (expected.get(b.address) ?? 0n)), 'Receipt debit/recipient differs')
    return { ...result, status: 'receipt-state-matched', reason: 'Exact transaction and plain postconditions match; deployment/provenance adoption still required',
      finalizedSlot: observations[0].receipt.slot, creatorDebitLamports: String(debit), feePayerNetworkFeeLamports: plan.outerPayerNetworkFee,
      treasuryCreditLamports: String(fees), rentLamports: String(rent) }
  } catch {
    return { ...result, status: 'review-required', reason: 'Receipt/state/counters/debits differ or evidence is incomplete; retain original signature' }
  }
}

// No scheduler registration. Invoke only with explicitly configured, independent read adapters.
export async function indexPlainReceipts(journal, connections) {
  const providers = connections.map(c => c.provider)
  check(providers.length === 2 && new Set(providers).size === 2, 'Two independent providers required')
  const rows = await journal.pending(25), outcomes = []
  for (const row of rows) {
    const observations = await Promise.all(connections.map(async c => {
      try { return await readPlainReceipt(c.connection, c.provider, row.plan, row.signed_transaction) }
      catch { return { provider: c.provider, receipt: null } }
    }))
    outcomes.push(await journal.observe(row.github_user_id, row.id, observations, providers))
  }
  return outcomes.map(row => ({ id: row.id, status: row.status }))
}
