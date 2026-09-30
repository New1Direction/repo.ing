import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { blockedWord } from './note-blocklist.mjs'

// "Why I bought" holder notes: one short plain-text note per wallet per market. The wallet signs a message naming the
// mint, the exact note hash and a single-use nonce; the server re-checks that it holds the token and bought it here.
export const NOTE_MAX_CHARS = 280
export const NOTE_CHALLENGE_MS = 5 * 60 * 1000
export const NOTE_PAGE_SIZE = 10
export const NOTE_LIMITS = { walletWrites: 6, walletWindowSeconds: 3600, ipRequests: 30, ipWindowSeconds: 600 }
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export class NoteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// Invisible and direction-changing characters can disguise text; control characters have no place in a note.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu
const CONTROL = /[\p{Cc}\p{Co}\p{Cs}]/gu
const HTML = /<\/?[a-z!?][^<>]*>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i
// Anything that looks like a link or a bare domain. Only github.com is allowed, and it is still rendered as text.
const LINKISH = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|xyz|fun|app|dev|co|me|gg|ly|ru|cn|info|biz|site|online|link|click|top|live|pro|ai|so|to|tv|cc|us|uk|finance|money|exchange|claims?|gift|vip|club|lol|wtf|tech|sh|ws|pw|tk|ml|ga|cf|gq|zip|mov|bot|sol|meme|network|foundation|store|shop|page|win|bet|casino|download|events?|trade|market)\b(?:[/?#]\S*)?/gi
const GITHUB = /^(?:https?:\/\/)?(?:www\.)?github\.com(?:[/?#]\S*)?$/i

// Returns the stored form of a note: NFC, no control/invisible characters, whitespace collapsed to single spaces.
export function sanitizeNote(input) {
  if (typeof input !== 'string') throw new NoteError('Write a short note')
  if (input.length > NOTE_MAX_CHARS * 4) throw new NoteError(`Keep it to ${NOTE_MAX_CHARS} characters`)
  const text = input.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').replace(CONTROL, '').trim()
  if (!text) throw new NoteError('Write a short note')
  if ([...text].length > NOTE_MAX_CHARS) throw new NoteError(`Keep it to ${NOTE_MAX_CHARS} characters`)
  if (HTML.test(text)) throw new NoteError('Notes are plain text. Remove the HTML.')
  for (const match of text.match(LINKISH) ?? []) {
    if (!GITHUB.test(match.replace(/[).,!?:;'"]+$/, ''))) throw new NoteError('Links are not allowed, except github.com')
  }
  if (blockedWord(text)) throw new NoteError('Please keep notes respectful')
  return text
}

export const noteHash = text => createHash('sha256').update(text, 'utf8').digest('hex')

export const noteMessage = ({ action, wallet, mint, textHash, nonce, expiresAt }) => [
  'repo.ing holder note v1',
  action === 'delete' ? 'Delete my holder note for this token.' : 'Publish my holder note for this token.',
  'Chain: Solana', `Wallet: ${wallet}`, `Mint: ${mint}`,
  ...action === 'delete' ? [] : [`Note SHA-256: ${textHash}`],
  `Nonce: ${nonce}`, `Expires: ${new Date(expiresAt).toISOString()}`,
  'This signature does not send a transaction.',
].join('\n')

const base58Key = (value, label) => {
  try {
    const key = new PublicKey(String(value ?? '')).toBase58()
    if (key !== value) throw Error()
    return key
  } catch { throw new NoteError(`Invalid ${label}`) }
}

// Terms travel sealed (HMAC) to the client and back; the nonce is consumed once on use.
export function noteChallenge({ wallet, mint, action = 'post', text, now = Date.now }) {
  if (!['post', 'delete'].includes(action)) throw new NoteError('Invalid note action')
  const terms = { purpose: 'holder-note', action, wallet: base58Key(wallet, 'wallet address'), mint: base58Key(mint, 'token'),
    textHash: action === 'post' ? noteHash(sanitizeNote(text)) : null, nonce: randomBytes(16).toString('hex'), expiresAt: now() + NOTE_CHALLENGE_MS }
  return { terms, message: noteMessage(terms) }
}

export function verifyNoteRequest(terms, signatureBase64, text, now = Date.now) {
  if (terms?.purpose !== 'holder-note' || !Number.isFinite(terms.expiresAt) || terms.expiresAt <= now()) throw new NoteError('Signature request expired. Try again.')
  if (!/^[0-9a-f]{32}$/.test(terms.nonce ?? '') || !['post', 'delete'].includes(terms.action)) throw new NoteError('Invalid note request')
  const body = terms.action === 'post' ? sanitizeNote(text) : null
  if (body !== null && noteHash(body) !== terms.textHash) throw new NoteError('The note changed after signing. Sign again.')
  const signature = Buffer.from(String(signatureBase64 ?? ''), 'base64')
  if (signature.length !== 64) throw new NoteError('Invalid Solana wallet signature')
  const wallet = new PublicKey(terms.wallet)
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, wallet.toBuffer()]), format: 'der', type: 'spki' })
  if (!verifySignature(null, Buffer.from(noteMessage(terms), 'utf8'), publicKey, signature)) throw new NoteError('Invalid Solana wallet signature')
  return { action: terms.action, wallet: wallet.toBase58(), mint: terms.mint, nonce: terms.nonce, expiresAt: terms.expiresAt, body }
}

// store: createNoteStore(pool) or a fake. readBalance(wallet, mint) → bigint base units, read from chain at post time.
export function createHolderNotes({ store, readBalance, now = Date.now }) {
  const quota = async scopes => { if (!await store.takeQuota(scopes)) throw new NoteError('Too many note requests. Try again later.', 429) }
  const ipQuota = ip => quota([[`note-ip:${ip}`, NOTE_LIMITS.ipRequests, NOTE_LIMITS.ipWindowSeconds]])
  async function requireEligible(market, wallet) {
    const [balance, bought] = await Promise.all([readBalance(wallet, market.mint), store.hasBought(market, wallet)])
    if (!bought) throw new NoteError('Only wallets that bought this token here can post a note', 403)
    if (!(balance > 0n)) throw new NoteError('Hold this token to post a note', 403)
    return balance
  }
  return {
    // Fail early (before the wallet prompt) when the wallet cannot post.
    async challenge({ market, wallet, action, text, ip }) {
      await ipQuota(ip)
      const result = noteChallenge({ wallet, mint: market.mint, action, text, now })
      if (action !== 'delete') await requireEligible(market, result.terms.wallet)
      return result
    },
    async submit({ market, terms, signature, text, ip }) {
      await ipQuota(ip)
      const request = verifyNoteRequest(terms, signature, text, now)
      if (request.mint !== market.mint) throw new NoteError('Invalid note request')
      await quota([[`note-wallet:${request.wallet}`, NOTE_LIMITS.walletWrites, NOTE_LIMITS.walletWindowSeconds]])
      const balance = request.action === 'post' ? await requireEligible(market, request.wallet) : null
      if (!await store.consumeNonce(request.nonce, new Date(request.expiresAt))) throw new NoteError('This signature was already used. Sign again.', 409)
      if (request.action === 'delete') return { deleted: await store.remove(market.mint, request.wallet) }
      return { note: await store.upsert({ mint: market.mint, wallet: request.wallet, body: request.body, balance }) }
    },
  }
}

// ---------- PostgreSQL store ----------
const NOTE_COLUMNS = `id::text as id, wallet, body, balance_at_post::text as "balanceAtPost", created_at as "createdAt", updated_at as "updatedAt"`
export function createNoteStore(pool) {
  return {
    // Same table and fixed-window semantics as the agent quotas: every scope must have room, or nothing is counted further.
    async takeQuota(scopes) {
      for (const [scope, limit, seconds] of scopes) {
        const { rows } = await pool.query(`insert into agent_request_limits(scope,hits,expires_at) values($1,1,now()+make_interval(secs=>$3))
          on conflict(scope) do update set hits=case when agent_request_limits.expires_at<=now() then 1 else agent_request_limits.hits+1 end,
          expires_at=case when agent_request_limits.expires_at<=now() then now()+make_interval(secs=>$3) else agent_request_limits.expires_at end
          where agent_request_limits.expires_at<=now() or agent_request_limits.hits<$2 returning hits`, [scope, limit, seconds])
        if (!rows.length) return false
      }
      return true
    },
    async hasBought(market, wallet) {
      const { rows } = await pool.query(`select exists(select 1 from trade_events where pool=$1 and trader=$2 and direction='buy')
        or exists(select 1 from damm_trade_events d join markets m on m.github_repo_id=d.github_repo_id where m.mint=$3 and d.trader=$2 and d.direction='buy') as bought`,
      [market.pool, wallet, market.mint])
      return rows[0].bought === true
    },
    async consumeNonce(nonce, expiresAt) {
      await pool.query('delete from holder_note_nonces where expires_at < now()')
      const { rowCount } = await pool.query('insert into holder_note_nonces(nonce,expires_at) values($1,$2) on conflict do nothing', [nonce, expiresAt])
      return rowCount === 1
    },
    // One note per wallet per market. An edit keeps a moderator's hide in place.
    async upsert({ mint, wallet, body, balance }) {
      const { rows } = await pool.query(`insert into holder_notes(mint,wallet,body,balance_at_post) values($1,$2,$3,$4)
        on conflict(mint,wallet) do update set body=excluded.body, balance_at_post=excluded.balance_at_post, updated_at=now()
        returning ${NOTE_COLUMNS}, hidden_at is not null as hidden`, [mint, wallet, body, balance.toString()])
      return rows[0]
    },
    // A hidden note stays (hidden) so deleting and reposting cannot undo moderation.
    async remove(mint, wallet) {
      const { rowCount } = await pool.query('delete from holder_notes where mint=$1 and wallet=$2 and hidden_at is null', [mint, wallet])
      return rowCount === 1
    },
    async list(mint, { offset = 0, limit = NOTE_PAGE_SIZE } = {}) {
      const { rows } = await pool.query(`select ${NOTE_COLUMNS} from holder_notes where mint=$1 and hidden_at is null
        order by updated_at desc, id desc offset $2 limit $3`, [mint, offset, limit + 1])
      return { notes: rows.slice(0, limit), hasMore: rows.length > limit }
    },
    async own(mint, wallet) {
      const { rows } = await pool.query(`select ${NOTE_COLUMNS}, hidden_at is not null as hidden from holder_notes where mint=$1 and wallet=$2`, [mint, wallet])
      return rows[0] ?? null
    },
    async recent(limit = 30) {
      const { rows } = await pool.query(`select n.id::text as id, n.mint, n.wallet, n.body, n.updated_at as "updatedAt", n.hidden_at as "hiddenAt", n.hidden_by as "hiddenBy",
        m.token_symbol as symbol from holder_notes n join markets m on m.mint=n.mint order by n.updated_at desc limit $1`, [limit])
      return rows
    },
    async setHidden(id, hidden, operator) {
      if (!/^[1-9]\d{0,17}$/.test(String(id))) throw new NoteError('Invalid note')
      const { rowCount } = await pool.query(`update holder_notes set hidden_at=case when $2 then coalesce(hidden_at, now()) else null end,
        hidden_by=case when $2 then $3 else null end where id=$1`, [String(id), hidden === true, operator])
      if (!rowCount) throw new NoteError('Note not found', 404)
      return { id: String(id), hidden: hidden === true }
    },
  }
}
