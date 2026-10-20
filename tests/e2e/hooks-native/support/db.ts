// Database-side truth: the persisted signing operations (hook_lab_native_signing_operations) the site wrote for a wallet,
// and the owner-approval rows, read straight from the disposable database.
import { db, until } from './stack.ts'

export interface OperationRow {
  id: string; owner_wallet: string; stage: string; status: string; signature: string | null; message_sha256: string
  first_finalized: any; first_conflict: any; resolved_request: any; review: any; revision: string
}
export async function operations(owner: string, stage?: string): Promise<OperationRow[]> {
  const { rows } = await db.query(`select id, owner_wallet, stage, status, signature, message_sha256, first_finalized, first_conflict, resolved_request, review, revision
    from hook_lab_native_signing_operations where owner_wallet=$1 ${stage ? 'and stage=$2' : ''} order by created_at`, stage ? [owner, stage] : [owner])
  return rows
}
/** Waits until the wallet has exactly `count` operations of `stage`, all finalized-success, and returns them. */
export async function finalizedOperations(owner: string, stage: string, count: number): Promise<OperationRow[]> {
  return until(`${count} finalized ${stage} operation(s) for ${owner}`, async () => {
    const rows = await operations(owner, stage)
    if (rows.some(row => ['finalized-failure', 'review-required', 'expired'].includes(row.status))) throw Object.assign(new Error(`${stage} operation ended ${rows.map(r => r.status).join(',')}`), { fatal: true })
    return rows.length === count && rows.every(row => row.status === 'finalized-success') ? rows : null
  }, { timeoutMs: 180_000 })
}
/** Signer claims recorded for an operation (server/admin co-signatures go through these). */
export async function signerAttempts(operationId: string): Promise<{ signer_address: string; status: string }[]> {
  return (await db.query('select signer_address, status from hook_lab_native_signing_attempts where operation_id=$1 order by claimed_at', [operationId])).rows
}
export async function launchRequests(creator: string): Promise<any[]> {
  return (await db.query('select * from hook_lab_launch_requests where creator_wallet=$1 order by created_at', [creator])).rows
}
export async function ownerSignRequests(): Promise<any[]> {
  return (await db.query('select * from hook_lab_owner_sign_requests order by created_at')).rows
}
