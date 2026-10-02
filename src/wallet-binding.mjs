import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm'
import { repoBeneficiaries, repoVerifications, walletBindingChallenges } from './db/schema.mjs'
import { assertAuthoritySource, assertHfMarketId } from './market-identity.mjs'

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000
const VERIFICATION_MAX_AGE_MS = 5 * 60 * 1000
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
// A binding is authorized by a GitHub admin verification (repo_verifications) unless the caller passes another authority:
// a Hugging Face one (src/hf-verification.mjs) binds a model market, backed by model_verifications. Each source has its
// own message domain, so a signature for one can never bind the other; the GitHub bytes are frozen
// (tests/wallet-binding-golden.test.mjs).
const authority = { source: 'github' }
const SUBJECT = /^[0-9a-f]{24}$/

const positiveId = value => {
  const id = BigInt(value)
  if (id <= 0n) throw new Error('GitHub ID must be positive')
  return id
}

// A wallet-signature binding takes effect at once (as before) and replaces a pasted address still waiting out its hold
// (src/payout-address.mjs), so that address can never activate over the newer binding. Recorded in the audit log, with
// the GitHub user or, on a model market, the Hugging Face user who signed.
async function supersedePastedAddress(tx, repoId, { githubUserId = null, subject = null }) {
  const userId = githubUserId === null ? null : githubUserId.toString()
  const { rows } = await tx.execute(sql`update payout_address_requests set status = 'superseded', resolved_at = now(),
      resolved_by_github_user_id = ${userId}, resolved_by_subject = ${subject}, resolution_reason = 'Replaced by a wallet-signature binding'
    where github_repo_id = ${repoId.toString()} and status = 'pending' returning id::text as id, wallet`)
  for (const row of rows) {
    await tx.execute(sql`insert into payout_address_events(request_id, github_repo_id, event, github_user_id, actor_subject, wallet)
      values (${row.id}, ${repoId.toString()}, 'superseded', ${userId}, ${subject}, ${row.wallet})`)
  }
}

// What a model market's wallet signs: its own first line (domain), the market and the model's stable _id, and the
// Hugging Face user binding it.
export const modelBindingMessage = ({ githubRepoId, hfId, authoritySubject, wallet, nonce, expiresAt }) => [
  'repo.ing model beneficiary v1',
  'I bind this Solana wallet as beneficiary for the Hugging Face model.',
  'Chain: Solana',
  `Market ID: ${githubRepoId}`,
  `Model ID: ${hfId}`,
  `Hugging Face user ID: ${authoritySubject}`,
  `Wallet: ${wallet}`,
  `Nonce: ${nonce}`,
  `Expires: ${new Date(expiresAt).toISOString()}`,
].join('\n')

// A fresh Hugging Face authority (verifyMarketAuthority's result): who signed in, the model's current owner and its _id.
function modelAuthority(value) {
  if (value?.source !== 'huggingface' || !SUBJECT.test(value.subject ?? '') || !SUBJECT.test(value.ownerSubject ?? '') || !SUBJECT.test(value.hfId ?? '')) {
    throw new Error('Fresh Hugging Face owner verification required')
  }
  return { subject: value.subject, ownerSubject: value.ownerSubject, hfId: value.hfId }
}

// A model market's payout binding and the Hugging Face authority it was made under, the counterpart of reading
// repo_beneficiaries.github_user_id for a repository: { wallet, boundAt, method, subject, ownerSubject }, or null. subject:
// only a binding made by that Hugging Face user. Anything that pays a model's owner from it (claims; later the builder
// allocation) also needs ownerSubject to be the model's CURRENT owner _id, read fresh: a binding made for a previous owner
// is never paid (assertBindingAuthority in src/claim.mjs).
export async function modelBeneficiary(executor, marketId, { subject = null } = {}) {
  const id = assertHfMarketId(marketId)
  if (subject !== null && !SUBJECT.test(String(subject))) throw new TypeError('Invalid Hugging Face user ID')
  const { rows: [row] } = await executor.query(`select wallet, bound_at as "boundAt", method, authority_subject as subject,
      authority_owner_subject as "ownerSubject" from repo_beneficiaries
    where github_repo_id = $1 and authority_source = 'huggingface' and ($2::text is null or authority_subject = $2)`, [id.toString(), subject])
  return row ?? null
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
  // The model-market counterpart: a recorded check, at most five minutes old, for this user, owner and model.
  const requireRecentModelAuthority = async (executor, repoId, auth) => {
    const { rows } = await executor.execute(sql`select 1 from model_verifications where github_repo_id = ${repoId.toString()}
      and subject = ${auth.subject} and owner_subject = ${auth.ownerSubject} and hf_id = ${auth.hfId}
      and verified_at >= now() - interval '5 minutes' limit 1`)
    if (!rows.length) throw new Error('Recent Hugging Face owner verification required')
    const { rows: [model] } = await executor.execute(sql`select hf_id as "hfId" from hf_models where market_ref = ${repoId.toString()}`)
    if (model?.hfId !== auth.hfId) throw new Error('Model verification mismatch')
  }
  const requestModelChallenge = async (repoId, wallet, auth) => {
    const walletKey = new PublicKey(wallet).toBase58()
    const now = new Date()
    await requireRecentModelAuthority(db, repoId, auth)
    const nonce = randomBytes(24).toString('hex')
    const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MS)
    await db.insert(walletBindingChallenges).values({ githubRepoId: repoId, githubUserId: null, wallet: walletKey, nonce, expiresAt,
      authoritySource: 'huggingface', authoritySubject: auth.subject, authorityOwnerSubject: auth.ownerSubject })
    return { githubRepoId: repoId, authoritySubject: auth.subject, wallet: walletKey, nonce, expiresAt,
      message: modelBindingMessage({ githubRepoId: repoId, hfId: auth.hfId, authoritySubject: auth.subject, wallet: walletKey, nonce, expiresAt }) }
  }
  const bindModelWallet = async (repoId, { wallet, nonce, signature }, auth) => {
    const walletKey = new PublicKey(wallet)
    const walletAddress = walletKey.toBase58()
    if (typeof nonce !== 'string' || !/^[0-9a-f]{48}$/.test(nonce)) throw new Error('Invalid wallet challenge nonce')
    const signatureBytes = typeof signature === 'string' ? Buffer.from(bs58.decode(signature)) : Buffer.from(signature)
    if (signatureBytes.length !== 64) throw new Error('Invalid Solana wallet signature')
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${repoId.toString()}::bigint)`)
      const now = new Date()
      await requireRecentModelAuthority(tx, repoId, auth)
      const [challenge] = await tx.select().from(walletBindingChallenges).where(eq(walletBindingChallenges.nonce, nonce)).limit(1)
      if (!challenge || challenge.githubRepoId !== repoId || challenge.authoritySource !== 'huggingface' || challenge.githubUserId !== null ||
          challenge.authoritySubject !== auth.subject || challenge.authorityOwnerSubject !== auth.ownerSubject ||
          challenge.wallet !== walletAddress || challenge.consumedAt || challenge.expiresAt <= now) {
        throw new Error('Wallet challenge is missing, mismatched, expired, or used')
      }
      const message = modelBindingMessage({ ...challenge, hfId: auth.hfId })
      const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, walletKey.toBuffer()]), format: 'der', type: 'spki' })
      if (!verifySignature(null, Buffer.from(message, 'utf8'), publicKey, signatureBytes)) throw new Error('Invalid Solana wallet signature')
      const [consumed] = await tx.update(walletBindingChallenges).set({ consumedAt: now }).where(and(
        eq(walletBindingChallenges.nonce, nonce), isNull(walletBindingChallenges.consumedAt), gt(walletBindingChallenges.expiresAt, now),
      )).returning()
      if (!consumed) throw new Error('Wallet challenge already used or expired')
      const binding = { githubUserId: null, wallet: walletAddress, boundAt: now, method: 'signature', payoutRequestId: null,
        authoritySource: 'huggingface', authoritySubject: auth.subject, authorityOwnerSubject: auth.ownerSubject }
      const [beneficiary] = await tx.insert(repoBeneficiaries).values({ githubRepoId: repoId, ...binding })
        .onConflictDoUpdate({ target: repoBeneficiaries.githubRepoId, set: binding }).returning()
      await supersedePastedAddress(tx, repoId, { subject: auth.subject })
      return beneficiary
    })
  }
  // authority: omitted for GitHub (the default, unchanged); a fresh Hugging Face authority for a model market.
  const requestChallenge = async ({ githubRepoId, githubUserId, wallet, authority: payoutAuthority = authority }) => {
    const repoId = positiveId(githubRepoId)
    assertAuthoritySource(payoutAuthority, repoId)
    if (payoutAuthority?.source === 'huggingface') return requestModelChallenge(repoId, wallet, modelAuthority(payoutAuthority))
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
  const bindWallet = async ({ githubRepoId, githubUserId, wallet, nonce, signature, authority: payoutAuthority = authority }) => {
    const repoId = positiveId(githubRepoId)
    assertAuthoritySource(payoutAuthority, repoId)
    if (payoutAuthority?.source === 'huggingface') return bindModelWallet(repoId, { wallet, nonce, signature }, modelAuthority(payoutAuthority))
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
      await supersedePastedAddress(tx, repoId, { githubUserId: userId })
      return beneficiary
    })
  }
  const requestBatchChallenge = async ({ githubRepoIds, githubUserId, wallet }) => {
    if (!Array.isArray(githubRepoIds) || !githubRepoIds.length || githubRepoIds.length > 100 || new Set(githubRepoIds.map(String)).size !== githubRepoIds.length) throw new Error('Choose up to 100 distinct repositories')
    const ids = githubRepoIds.map(positiveId).sort((a,b) => a < b ? -1 : 1)
    for (const id of ids) assertAuthoritySource(authority, id)
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
      for (const c of challenges) assertAuthoritySource(authority, c.githubRepoId)
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
        await supersedePastedAddress(tx, c.githubRepoId, { githubUserId: userId })
      }
      return { count: challenges.length, wallet: walletKey.toBase58() }
    })
  }
  return { requestChallenge, bindWallet, requestBatchChallenge, bindBatch }
}
