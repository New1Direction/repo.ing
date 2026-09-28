import { createHash } from 'node:crypto'
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

// Operator-only recovery. Absence at one RPC is never sufficient to release a launch.
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
        BigInt(o.getBlockHeight) <= BigInt(market.last_valid_block_height) + 150n ||
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
