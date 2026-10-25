// Operator CLI for the legacy H7TK partner fees on the custody-bound pools in config/existing-market-custody.json.
//   review REVIEW_FILE  read-only: no signer, no sends. Writes a private review file and prints the per-market table.
//   claim REVIEW_FILE   claims exactly the reviewed markets through the reviewed collector (simulate, durable intent,
//                       broadcast, MATCH receipt). A market whose terms changed since review is skipped; any other error stops.
// Env: COLLECTOR_DATABASE_URL (restricted collector role), SOLANA_RPC_URL, GRADUATION_VERIFICATION_RPC_URL,
// PLATFORM_FEE_TREASURY_WALLET; claim also needs PLATFORM_PARTNER_SECRET_KEY. Secrets are never printed.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { DBC_MAX_NETWORK_FEE_LAMPORTS, createDbcPlatformFees } from '../src/platform-dbc-fees.mjs'

const PARTNER = 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3'
const MANIFEST_SHA256 = '2c31354ba8009acb0da1319b068f479216b0615120328510cba50665f0ecd888'
const REVIEW_TTL_MS = 30 * 60_000
// Below this a claim costs more than a twentieth of what it collects; it stays in the pool for later.
const MIN_CLAIM_LAMPORTS = 20n * BigInt(DBC_MAX_NETWORK_FEE_LAMPORTS)

const [mode, file] = process.argv.slice(2)
if (!['review', 'claim'].includes(mode) || !file) throw Error('Usage: collect-legacy-partner-fees.mjs review|claim REVIEW_FILE')
const required = ['COLLECTOR_DATABASE_URL', 'SOLANA_RPC_URL', 'GRADUATION_VERIFICATION_RPC_URL', 'PLATFORM_FEE_TREASURY_WALLET',
  ...(mode === 'claim' ? ['PLATFORM_PARTNER_SECRET_KEY'] : [])]
for (const name of required) if (!process.env[name]) throw Error(`${name} required`)
if (new URL(process.env.SOLANA_RPC_URL).hostname === new URL(process.env.GRADUATION_VERIFICATION_RPC_URL).hostname) {
  throw Error('Two independently operated RPC providers are required')
}

const manifestBytes = readFileSync(new URL('../config/existing-market-custody.json', import.meta.url))
if (createHash('sha256').update(manifestBytes).digest('hex') !== MANIFEST_SHA256) throw Error('Custody manifest changed; review required')
const manifest = JSON.parse(manifestBytes)
const configs = [...new Set(manifest.poolCreators.map(row => row.config))]
const treasury = new PublicKey(process.env.PLATFORM_FEE_TREASURY_WALLET).toBase58()

function partnerSigner() {
  if (mode === 'review') return { publicKey: new PublicKey(PARTNER) }
  const raw = process.env.PLATFORM_PARTNER_SECRET_KEY.trim()
  const decoders = [() => Uint8Array.from(JSON.parse(raw)), () => bs58.decode(raw), () => Buffer.from(raw, 'base64')]
  for (const decode of decoders) {
    try {
      const keypair = Keypair.fromSecretKey(Uint8Array.from(decode()))
      if (keypair.publicKey.toBase58() === PARTNER) return keypair
    } catch {}
  }
  throw Error('PLATFORM_PARTNER_SECRET_KEY is not the H7TK partner key')
}

const env = { ...process.env, PLATFORM_FEE_TREASURY_WALLET: treasury, DBC_LEGACY_CONFIGS: configs.slice(1).join(','),
  PLATFORM_DBC_COLLECTION_ENABLED: mode === 'claim' ? 'true' : 'false' }
const pool = new pg.Pool({ connectionString: process.env.COLLECTOR_DATABASE_URL, max: 2 })
const service = createDbcPlatformFees({ pool, connection: new Connection(process.env.SOLANA_RPC_URL, 'finalized'),
  verification: new Connection(process.env.GRADUATION_VERIFICATION_RPC_URL, 'finalized'), config: configs[0],
  partner: partnerSigner(), env, custodyRecovery: manifest })
const sol = lamports => (Number(BigInt(lamports)) / 1e9).toFixed(9)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function review() {
  const rows = []
  for (const { repoId } of manifest.poolCreators) {
    try {
      const s = await service.status(repoId)
      if (s.receiver !== treasury) throw Error('Receiver differs from the requested treasury')
      rows.push({ repoId, available: s.available, discoveryReserved: s.discoveryReserved, gross: s.gross,
        claim: BigInt(s.available) >= MIN_CLAIM_LAMPORTS, review: { purpose: 'platform-fee-review', phase: 'DBC', repoId: s.repoId,
          receiver: s.receiver, amount: s.available, termsHash: s.termsHash,
          maxNetworkFeeLamports: String(DBC_MAX_NETWORK_FEE_LAMPORTS), expiresAt: Date.now() + REVIEW_TTL_MS } })
    } catch (error) {
      rows.push({ repoId, error: String(error.message).slice(0, 120), claim: false })
    }
    await pause(400)
  }
  writeFileSync(file, JSON.stringify({ treasury, createdAt: new Date().toISOString(), rows }, null, 1) + '\n', { mode: 0o600 })
  const claimable = rows.filter(r => r.claim)
  const total = claimable.reduce((n, r) => n + BigInt(r.available), 0n)
  console.log(JSON.stringify({ treasury, markets: rows.length, toClaim: claimable.length, totalSol: sol(total),
    maxNetworkFeeSol: sol(BigInt(claimable.length) * BigInt(DBC_MAX_NETWORK_FEE_LAMPORTS)),
    discoveryReservedSol: sol(rows.reduce((n, r) => n + BigInt(r.discoveryReserved ?? 0), 0n)),
    refused: rows.filter(r => r.error).map(r => ({ repoId: r.repoId, error: r.error })),
    claims: claimable.map(r => ({ repoId: r.repoId, sol: sol(r.available) })) }, null, 1))
}

async function claim() {
  const reviewed = JSON.parse(readFileSync(file, 'utf8'))
  if (reviewed.treasury !== treasury) throw Error('Review file was made for a different treasury')
  const results = []
  for (const row of reviewed.rows.filter(r => r.claim)) {
    try {
      const result = await service.claim({ review: row.review })
      results.push({ repoId: row.repoId, lamports: row.available, sol: sol(row.available), signature: result.signature, reconciliation: result.reconciliation })
    } catch (error) {
      const message = String(error.message)
      if (!/terms changed|expired/i.test(message)) {
        results.push({ repoId: row.repoId, stopped: message.slice(0, 160) })
        break
      }
      results.push({ repoId: row.repoId, skipped: message.slice(0, 120) })
    }
  }
  const settled = results.filter(r => r.reconciliation === 'MATCH')
  console.log(JSON.stringify({ treasury, claimed: settled.length, totalSol: sol(settled.reduce((n, r) => n + BigInt(r.lamports), 0n)),
    results }, null, 1))
}

try { await (mode === 'review' ? review() : claim()) } finally { await pool.end() }
