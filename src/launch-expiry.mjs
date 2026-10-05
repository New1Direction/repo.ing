import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
// Blocks past the blockhash's lastValidBlockHeight before a release can be proven.
const RECOVERY_MARGIN_BLOCKS = 150n

// A launch transaction is valid until its blockhash's lastValidBlockHeight: 150 blocks, about 40 s at mainnet's block rate
// (3.67 blocks/s measured on 2026-10-05). The wallet must sign inside that window.
export const LAUNCH_REVIEW_EXPIRED = 'This launch review expired before it reached Solana, so nothing was sent or charged. ' +
  'Refresh the review and approve it in your wallet right away.'

// Releasing an expired launch attempt (scripts/recover-expired-launch.mjs, and the worker through createExpiredLaunchCheck).
// Absence at one RPC is never sufficient to release a launch: two independent providers must each show the finalized height
// more than 150 blocks past the blockhash's lastValidBlockHeight, the blockhash invalid, no transaction or signature status,
// and neither the mint nor the pool.
export function assertExpiredUnlandedLaunch(market, evidence, now = Date.now()) {
  if (!['ambiguous', 'submitted'].includes(market.status) || market.indexed_at || market.launch_slot ||
      !market.launch_signature || !market.mint || !market.pool || !market.blockhash || !market.last_valid_block_height)
    throw Error('LAUNCH_RECOVERY_STATE_INVALID')
  if (!evidence.independentRpc || evidence.observations?.length !== 2 ||
      now - Date.parse(evidence.checkedAt) > 60000 || Date.parse(evidence.checkedAt) > now || !Number.isFinite(Date.parse(evidence.checkedAt)))
    throw Error('LAUNCH_RECOVERY_EVIDENCE_STALE')
  const slots = []
  for (const o of evidence.observations) {
    const accounts = o.getMultipleAccounts, signatures = o.getSignatureStatuses
    if (o.getGenesisHash !== MAINNET || !Number.isSafeInteger(o.getBlockHeight) ||
        BigInt(o.getBlockHeight) <= BigInt(market.last_valid_block_height) + RECOVERY_MARGIN_BLOCKS ||
        o.isBlockhashValid?.value !== false || o.getTransaction !== null ||
        signatures?.value?.length !== 1 || signatures.value[0] !== null ||
        accounts?.value?.length !== 2 || accounts.value.some(x => x !== null)) throw Error('LAUNCH_RECOVERY_NOT_PROVEN')
    for (const result of [accounts, signatures, o.isBlockhashValid]) {
      if (!Number.isSafeInteger(result.context?.slot) || result.context.slot <= 0) throw Error('LAUNCH_RECOVERY_SLOT_INVALID')
      slots.push(result.context.slot)
    }
  }
  if (Math.max(...slots) - Math.min(...slots) > 150) throw Error('LAUNCH_RECOVERY_RPC_DISAGREEMENT')
  return { status: 'EXPIRED_UNLANDED', evidenceHash: createHash('sha256').update(JSON.stringify({market,evidence})).digest('hex') }
}

// The market columns the proof reads, as assertExpiredUnlandedLaunch expects them.
export const EXPIRY_MARKET_COLUMNS = 'id,github_repo_id::text,status,mint,pool,launcher_wallet,creator_wallet,launch_signature,blockhash,' +
  'last_valid_block_height::text,launch_slot::text,indexed_at'

// One provider's view of a launch attempt, in the shape assertExpiredUnlandedLaunch reads.
export async function observeLaunchExpiry(connection, market) {
  const [genesis, height, valid, signatures, transaction, accounts] = await Promise.all([
    connection.getGenesisHash(), connection.getBlockHeight('finalized'), connection.isBlockhashValid(market.blockhash, { commitment: 'finalized' }),
    connection.getSignatureStatuses([market.launch_signature], { searchTransactionHistory: true }),
    connection.getTransaction(market.launch_signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
    connection.getMultipleAccountsInfoAndContext([new PublicKey(market.mint), new PublicKey(market.pool)], { commitment: 'finalized' }),
  ])
  return { getGenesisHash: genesis, getBlockHeight: height, isBlockhashValid: valid, getSignatureStatuses: signatures, getTransaction: transaction,
    getMultipleAccounts: { context: accounts.context, value: accounts.value.map(account => account ? { exists: true } : null) } }
}

// Both providers read now: { proof, evidence }. Throws unless the proof holds.
export async function proveExpiredUnlandedLaunch(connections, market, now = Date.now) {
  if (connections?.length !== 2) throw Error('LAUNCH_RECOVERY_RPC_REQUIRED')
  const observations = await Promise.all(connections.map(connection => observeLaunchExpiry(connection, market)))
  const evidence = { independentRpc: true, checkedAt: new Date(now()).toISOString(), observations }
  return { proof: assertExpiredUnlandedLaunch(market, evidence, now()), evidence }
}

// Records the release as an operator alert carrying its evidence, and marks the attempt 'failed', in one transaction and only
// while the market is still the attempt that was proven. client: a pg client holding the repository's advisory lock.
export async function releaseExpiredLaunch(client, market, { proof, evidence }, reviewedBy) {
  await client.query('begin')
  try {
    await client.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,'LAUNCH_EXPIRED',$3) on conflict(event_key) do nothing`,
      [`launch-expired:${market.launch_signature}`, market.github_repo_id, JSON.stringify({ code: 'EXPIRED_UNLANDED', market, evidence, ...proof, reviewedBy })])
    const result = await client.query(`update markets set status='failed' where id=$1 and status=$2 and launch_signature=$3 and indexed_at is null`,
      [market.id, market.status, market.launch_signature])
    if (result.rowCount !== 1) throw Error('Launch state changed during review')
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error }
}

// The worker's automatic release (src/launch-indexer.mjs): connections are two independent providers. Returns the proof, or
// null while it does not hold. One cheap read first: nothing can be proven until the finalized height passes the margin.
export function createExpiredLaunchCheck({ connections, now = Date.now }) {
  return async market => {
    try {
      if (BigInt(await connections[0].getBlockHeight('finalized')) <= BigInt(market.last_valid_block_height) + RECOVERY_MARGIN_BLOCKS) return null
      return await proveExpiredUnlandedLaunch(connections, market, now)
    } catch { return null }
  }
}
