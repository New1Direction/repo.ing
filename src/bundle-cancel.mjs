import { ComputeBudgetProgram, Transaction } from '@solana/web3.js'
import { BUNDLE_VAULT_PROGRAM_ID, STATUS, bundleAddress, bundleErrorName, cancelBundleInstruction, decodeBundle, decodePlatform,
  platformAddress } from './bundle-vault.mjs'

// The admin cancels one Bundle raise (scripts/cancel-bundle.mjs, docs/BUNDLE_LAUNCH.md "Cancel a raise"): cancel_bundle marks a
// raise that has not launched as failed. Backers then refund, and the worker's next pass (mark_failed) frees the repository's
// standard launches and its ticker. Without execute it only reads and simulates the signed cancel. admin: the creator signer.
const STATUS_NAME = Object.fromEntries(Object.entries(STATUS).map(([name, value]) => [value, name]))
const sol = lamports => `${(Number(lamports) / 1e9).toFixed(4)} SOL`

export async function cancelBundleRaise({ connection, admin, pool = null, id, execute = false, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  if (!/^[1-9]\d{0,18}$/.test(String(id ?? ''))) throw Error('A bundle id is a positive whole number')
  if (!admin) throw Error('PLATFORM_CREATOR_SECRET_KEY is not set: run this on the web service')
  const [platformInfo, bundleInfo] = await connection.getMultipleAccountsInfo([platformAddress(programId), bundleAddress(id, programId)], 'confirmed')
  if (!platformInfo) throw Error('No Bundle platform account on this cluster')
  if (!decodePlatform(platformInfo.data).admin.equals(admin.publicKey)) throw Error('This server\'s creator signer is not the Bundle admin')
  if (!bundleInfo) throw Error(`No bundle ${id} on chain`)
  const bundle = decodeBundle(bundleInfo.data)
  const row = pool ? (await pool.query(`select b.status, r.full_name as "fullName" from bundles b
    left join repositories r on r.github_repo_id = b.github_repo_id where b.bundle_id = $1`, [String(id)])).rows[0] ?? null : null
  const summary = { bundle: String(id), repository: row?.fullName ?? `GitHub repository ${bundle.repoId}`, siteStatus: row?.status ?? null,
    chainStatus: STATUS_NAME[bundle.status], raised: sol(bundle.raised), target: sol(bundle.target),
    deadline: new Date(Number(bundle.deadline) * 1000).toISOString(), opener: bundle.creator.toBase58() }
  if (bundle.status !== STATUS.RAISING || bundle.released !== 0n) return { ...summary, cancellable: false, reason: 'Only a raise that has not launched can be cancelled' }

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    cancelBundleInstruction({ admin: admin.publicKey, id: BigInt(id), programId }))
  tx.feePayer = admin.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(admin)
  const simulated = await connection.simulateTransaction(tx)
  if (simulated.value.err) {
    return { ...summary, cancellable: false, reason: bundleErrorName((simulated.value.logs ?? []).join('\n'), programId) ?? JSON.stringify(simulated.value.err) }
  }
  if (!execute) return { ...summary, cancellable: true, simulation: 'passed', broadcast: false,
    next: 'Run again with --execute to cancel. Backers can then refund; the worker frees the repository on its next pass.' }
  const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' })
  await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  const after = decodeBundle((await connection.getAccountInfo(bundleAddress(id, programId), 'confirmed')).data)
  return { ...summary, cancelled: after.status === STATUS.FAILED, chainStatus: STATUS_NAME[after.status], signature }
}
