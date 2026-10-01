import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

// A launch review waits this long for the launcher's wallet signature (the old in-process timer's value).
export const LAUNCH_SESSION_TTL_MS = 120_000
// A consumed row is kept briefly so a 'prepared' market whose submit died mid-flight is eventually released.
const CONSUMED_RETENTION = '1 hour'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AAD = (id, mint) => Buffer.from(`repo.ing launch session v1:${id}:${mint}`)

// The mint keypair must reach whichever replica receives the signed launch, so it is stored, but only sealed.
// The key is derived from the platform creator secret: every replica that can launch already holds it, a database
// reader alone cannot open the row, and the creator key is the one that co-signs the launch anyway.
export function launchSessionKey(creatorSecretKey) {
  if (!creatorSecretKey?.length) throw new Error('Platform creator key required for launch sessions')
  return createHmac('sha256', Buffer.from(creatorSecretKey)).update('repo.ing launch session encryption v1').digest()
}

export function sealMintSecret(key, { id, mint }, secretKey) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD(id, mint))
  const body = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()])
  return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

export function openMintSecret(key, { id, mint }, sealed) {
  const [version, iv, body, tag, extra] = String(sealed ?? '').split('.')
  if (version !== 'v1' || extra !== undefined || !iv || !body || !tag) throw new Error('Prepared launch expired; reload before trying again')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(AAD(id, mint))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]))
  } catch { throw new Error('Prepared launch expired; reload before trying again') }
}

const COLUMNS = `s.id, s.market_id as "marketId", s.github_repo_id::text as "githubRepoId", s.repo_full_name as "repoFullName",
  s.mint, s.launcher_wallet as "launcherWallet", s.config, s.transaction, s.blockhash,
  s.last_valid_block_height::text as "lastValidBlockHeight", s.initial_buy_lamports::text as "initialBuyLamports",
  s.trend_revision as "trendRevision"`

// Replica-safe store for launch reviews. Times come from the database clock, so replica clock skew cannot stretch or
// cut a review. `key` (launchSessionKey) is only needed to create and consume; expiry sweeps need no key.
export function createLaunchSessionStore({ pool, key = null, ttlMs = LAUNCH_SESSION_TTL_MS }) {
  const release = ({ marketId, mint }) => pool.query(`update markets set status = 'failed' where id = $1 and mint = $2 and status = 'prepared'`, [marketId, mint])
  return {
    async create({ id, market, repoFullName, config, transaction, mintSecretKey, blockhash, lastValidBlockHeight, initialBuyLamports = '0', trendRevision = null }) {
      if (!key) throw new Error('Launch session key required')
      if (!UUID.test(id ?? '')) throw new Error('Invalid launch session id')
      if (!/^\d+$/.test(String(initialBuyLamports))) throw new Error('Invalid initial buy amount')
      const sealed = sealMintSecret(key, { id, mint: market.mint }, mintSecretKey)
      await pool.query(`insert into launch_sessions(id, market_id, github_repo_id, repo_full_name, mint, launcher_wallet, config, transaction,
          mint_secret, blockhash, last_valid_block_height, initial_buy_lamports, trend_revision, expires_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + make_interval(secs => $14::double precision / 1000))`,
      [id, market.id, String(market.githubRepoId), repoFullName, market.mint, market.launcherWallet, config, transaction,
        sealed, blockhash, String(lastValidBlockHeight), String(initialBuyLamports), trendRevision, ttlMs])
    },

    // Single use across every replica: the first submit or cancel claims the row and erases the sealed secret in the
    // same statement; a concurrent claimant waits on the row lock, then sees it consumed and gets null.
    async consume(id) {
      if (!key) throw new Error('Launch session key required')
      if (typeof id !== 'string' || !UUID.test(id)) return null
      const { rows: [row] } = await pool.query(`update launch_sessions s set consumed_at = now(), mint_secret = null
        from (select id, mint_secret from launch_sessions where id = $1 and consumed_at is null and expires_at > now() for update) o
        where s.id = o.id and s.consumed_at is null
        returning ${COLUMNS}, o.mint_secret as "sealed"`, [id])
      if (!row) return null
      const { sealed, ...session } = row
      try { return { ...session, mintSecretKey: openMintSecret(key, session, sealed) } }
      catch (error) { await release(session); throw error }
    },

    // A consumed review that cannot be submitted (e.g. its secret no longer opens) releases its market right away.
    release,

    // True while another review of this market can still be signed; a second prepare must not replace it.
    async pending(marketId) {
      const { rows: [row] } = await pool.query(`select exists(select 1 from launch_sessions
        where market_id = $1 and consumed_at is null and expires_at > now()) as pending`, [marketId])
      return row.pending === true
    },

    // Cancel = consume + release: the still-'prepared' market of this review becomes 'failed' (as the old in-process
    // rejection did). Unknown, expired or already used ids are a no-op.
    async cancel(id) {
      if (typeof id !== 'string' || !UUID.test(id)) return false
      const { rows: [row] } = await pool.query(`with claimed as (
          update launch_sessions s set consumed_at = now(), mint_secret = null
          from (select id from launch_sessions where id = $1 and consumed_at is null and expires_at > now() for update) o
          where s.id = o.id and s.consumed_at is null returning s.market_id, s.mint)
        , released as (update markets m set status = 'failed' from claimed c
          where m.id = c.market_id and m.mint = c.mint and m.status = 'prepared' returning m.id)
        select (select count(*) from claimed)::int as cancelled`, [id])
      return row.cancelled > 0
    },

    expire: () => expireLaunchSessions(pool),
  }
}

// Deletes expired reviews (and consumed rows after a grace period) and marks the review's market 'failed' if it is
// still 'prepared' with that mint, exactly as the old per-process timeout did. Safe from any replica or the worker:
// the mint/status guard never touches a market that a newer prepare or a submit has already moved on.
export async function expireLaunchSessions(pool) {
  const { rows: [row] } = await pool.query(`with gone as (
      delete from launch_sessions
      where (consumed_at is null and expires_at <= now()) or consumed_at <= now() - interval '${CONSUMED_RETENTION}'
      returning market_id, mint)
    , released as (update markets m set status = 'failed' from gone g
      where m.id = g.market_id and m.mint = g.mint and m.status = 'prepared' returning m.id)
    select (select count(*) from gone)::int as removed, (select count(*) from released)::int as released`)
  return row
}
