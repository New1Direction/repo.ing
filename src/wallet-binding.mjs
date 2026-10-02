import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm'
import { repoBeneficiaries, repoVerifications, walletBindingChallenges } from './db/schema.mjs'

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000
const VERIFICATION_MAX_AGE_MS = 5 * 60 * 1000
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const positiveId = value => {
  const id = BigInt(value)
  if (id <= 0n) throw new Error('GitHub ID must be positive')
  return id
}

// A wallet-signature binding takes effect at once (as before) and replaces a pasted address still waiting out its hold
// (src/payout-address.mjs), so that address can never activate over the newer binding. Recorded in the audit log.
async function supersedePastedAddress(tx, repoId, userId) {
  const { rows } = await tx.execute(sql`update payout_address_requests set status = 'superseded', resolved_at = now(),
      resolved_by_github_user_id = ${userId.toString()}, resolution_reason = 'Replaced by a wallet-signature binding'
    where github_repo_id = ${repoId.toString()} and status = 'pending' returning id::text as id, wallet`)
  for (const row of rows) {
    await tx.execute(sql`insert into payout_address_events(request_id, github_repo_id, event, github_user_id, wallet)
      values (${row.id}, ${repoId.toString()}, 'superseded', ${userId.toString()}, ${row.wallet})`)
  }
}

const bindingMessage = ({ githubRepoId, wallet, nonce, expiresAt }) => [
  'repo.ing repository beneficiary v1',
  'I bind this Solana wallet as beneficiary for the repository.',
  'Chain: Solana',
  `Repository ID: ${githubRepoId}`,
  `Wallet: ${wallet}`,
  `Nonce: ${nonce}`,
  `Expires: ${expiresAt.toISOString()}`,
].join('\n')

export const batchBindingMessage = (challenges) => [
  'repo.ing repository beneficiaries v1',
  'I set this Solana wallet as the payout wallet for the repositories listed below.',
  'Chain: Solana', `Wallet: ${challenges[0].wallet}`, `GitHub user ID: ${challenges[0].githubUserId}`,
  ...challenges.map(c => `Repository ID: ${c.githubRepoId} | Nonce: ${c.nonce} | Expires: ${new Date(c.expiresAt).toISOString()}`),
  'This signature sets payout wallets only. It does not send a transaction.',
].join('\n')

export function createWalletBinding({ pool }) {
  const db = drizzle(pool)
  const requireRecentAdmin = async (executor, githubRepoId, githubUserId, now) => {
    const [record] = await executor.select().from(repoVerifications).where(and(
      eq(repoVerifications.githubRepoId, githubRepoId), eq(repoVerifications.githubUserId, githubUserId),
      eq(repoVerifications.permission, 'admin'),
      gte(repoVerifications.verifiedAt, new Date(now.getTime() - VERIFICATION_MAX_AGE_MS)),
    )).orderBy(desc(repoVerifications.verifiedAt)).limit(1)
    if (!record) throw new Error('Recent GitHub admin verification required')
  }
  const requestChallenge = async ({ githubRepoId, githubUserId, wallet }) => {
    const repoId = positiveId(githubRepoId)
    const userId = positiveId(githubUserId)
    const walletKey = new PublicKey(wallet).toBase58()
    const now = new Date()
    await requireRecentAdmin(db, repoId, userId, now)
    const nonce = randomBytes(24).toString('hex')
    const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MS)
    await db.insert(walletBindingChallenges).values({ githubRepoId: repoId, githubUserId: userId,
      wallet: walletKey, nonce, expiresAt })
    return { githubRepoId: repoId, githubUserId: userId, wallet: walletKey, nonce, expiresAt,
      message: bindingMessage({ githubRepoId: repoId, wallet: walletKey, nonce, expiresAt }) }
  }
  const bindWallet = async ({ githubRepoId, githubUserId, wallet, nonce, signature }) => {
    const repoId = positiveId(githubRepoId)
    const userId = positiveId(githubUserId)
    const walletKey = new PublicKey(wallet)
    const walletAddress = walletKey.toBase58()
    if (typeof nonce !== 'string' || !/^[0-9a-f]{48}$/.test(nonce)) throw new Error('Invalid wallet challenge nonce')
    const signatureBytes = typeof signature === 'string' ? Buffer.from(bs58.decode(signature)) : Buffer.from(signature)
    if (signatureBytes.length !== 64) throw new Error('Invalid Solana wallet signature')
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${repoId.toString()}::bigint)`)
      const now = new Date()
      await requireRecentAdmin(tx, repoId, userId, now)
      const [challenge] = await tx.select().from(walletBindingChallenges)
        .where(eq(walletBindingChallenges.nonce, nonce)).limit(1)
      if (!challenge || challenge.githubRepoId !== repoId || challenge.githubUserId !== userId ||
          challenge.wallet !== walletAddress || challenge.consumedAt || challenge.expiresAt <= now) {
        throw new Error('Wallet challenge is missing, mismatched, expired, or used')
      }
      const message = bindingMessage(challenge)
      const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, walletKey.toBuffer()]),
        format: 'der', type: 'spki' })
      if (!verifySignature(null, Buffer.from(message, 'utf8'), publicKey, signatureBytes)) {
        throw new Error('Invalid Solana wallet signature')
      }
      const [consumed] = await tx.update(walletBindingChallenges).set({ consumedAt: now }).where(and(
        eq(walletBindingChallenges.nonce, nonce), isNull(walletBindingChallenges.consumedAt),
        gt(walletBindingChallenges.expiresAt, now),
      )).returning()
      if (!consumed) throw new Error('Wallet challenge already used or expired')
      const [beneficiary] = await tx.insert(repoBeneficiaries).values({ githubRepoId: repoId,
        githubUserId: userId, wallet: walletAddress, boundAt: now, method: 'signature', payoutRequestId: null }).onConflictDoUpdate({
        target: repoBeneficiaries.githubRepoId,
        set: { githubUserId: userId, wallet: walletAddress, boundAt: now, method: 'signature', payoutRequestId: null },
      }).returning()
      await supersedePastedAddress(tx, repoId, userId)
      return beneficiary
    })
  }
  const requestBatchChallenge = async ({ githubRepoIds, githubUserId, wallet }) => {
    if (!Array.isArray(githubRepoIds) || !githubRepoIds.length || githubRepoIds.length > 100 || new Set(githubRepoIds.map(String)).size !== githubRepoIds.length) throw new Error('Choose up to 100 distinct repositories')
    const ids = githubRepoIds.map(positiveId).sort((a,b) => a < b ? -1 : 1)
    const challenges = []
    for (const githubRepoId of ids) {
      const [existing] = await db.select().from(repoBeneficiaries).where(eq(repoBeneficiaries.githubRepoId, githubRepoId)).limit(1)
      if (existing) throw new Error('A payout wallet is already set. Refresh; change existing wallets on their individual claim pages.')
      challenges.push(await requestChallenge({ githubRepoId, githubUserId, wallet }))
    }
    return { nonces: challenges.map(c => c.nonce), message: batchBindingMessage(challenges) }
  }
  const bindBatch = async ({ nonces, githubUserId, wallet, signature }) => {
    if (!Array.isArray(nonces) || !nonces.length || nonces.length > 100 || new Set(nonces).size !== nonces.length || nonces.some(n => !/^[0-9a-f]{48}$/.test(n))) throw new Error('Invalid wallet challenges')
    const userId = positiveId(githubUserId), walletKey = new PublicKey(wallet)
    const signatureBytes = Buffer.from(signature)
    if (signatureBytes.length !== 64) throw new Error('Invalid Solana wallet signature')
    return db.transaction(async tx => {
      const challenges = await tx.select().from(walletBindingChallenges).where(inArray(walletBindingChallenges.nonce, nonces)).orderBy(walletBindingChallenges.githubRepoId)
      if (challenges.length !== nonces.length || new Set(challenges.map(c => String(c.githubRepoId))).size !== challenges.length) throw new Error('Wallet challenges mismatch')
      for (const c of challenges) await tx.execute(sql`select pg_advisory_xact_lock(${c.githubRepoId.toString()}::bigint)`)
      const now = new Date()
      for (const c of challenges) {
        if (c.githubUserId !== userId || c.wallet !== walletKey.toBase58() || c.consumedAt || c.expiresAt <= now) throw new Error('Wallet challenge is mismatched, expired, or used')
        await requireRecentAdmin(tx, c.githubRepoId, userId, now)
        const [existing] = await tx.select().from(repoBeneficiaries).where(eq(repoBeneficiaries.githubRepoId, c.githubRepoId)).limit(1)
        // A pasted address whose hold has passed is the repository's payout address even before a pass records it.
        const { rows: [due] } = await tx.execute(sql`select 1 from payout_address_requests where github_repo_id = ${c.githubRepoId.toString()}
          and status = 'pending' and active_at <= now()`)
        if (existing || due) throw new Error('Payout wallet changed. Refresh and review again.')
      }
      const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, walletKey.toBuffer()]), format: 'der', type: 'spki' })
      if (!verifySignature(null, Buffer.from(batchBindingMessage(challenges)), publicKey, signatureBytes)) throw new Error('Invalid Solana wallet signature')
      for (const c of challenges) {
        const [consumed] = await tx.update(walletBindingChallenges).set({ consumedAt: now }).where(and(eq(walletBindingChallenges.nonce,c.nonce),isNull(walletBindingChallenges.consumedAt),gt(walletBindingChallenges.expiresAt,now))).returning()
        if (!consumed) throw new Error('Wallet challenge already used or expired')
        await tx.insert(repoBeneficiaries).values({ githubRepoId:c.githubRepoId,githubUserId:userId,wallet:c.wallet,boundAt:now,method:'signature' })
        await supersedePastedAddress(tx, c.githubRepoId, userId)
      }
      return { count: challenges.length, wallet: walletKey.toBase58() }
    })
  }
  return { requestChallenge, bindWallet, requestBatchChallenge, bindBatch }
}
