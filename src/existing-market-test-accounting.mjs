import { createHash, randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { createGraduatedFees } from './graduated-fees.mjs'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'

const roles = ['creator', 'partner']
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
function integer(value, label, max = (10n ** 78n) - 1n) {
  if (!['string', 'bigint', 'number'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isSafeInteger(value)) || !/^(0|[1-9][0-9]*)$/.test(String(value)) || BigInt(value) > max) {
    throw Error(`Malformed ${label}`)
  }
  return String(value)
}
function address(value) {
  const text = typeof value === 'string' ? value : value?.toBase58?.()
  if (typeof text !== 'string' || new PublicKey(text).toBase58() !== text) throw Error('Malformed checkpoint address')
  return text
}
function signatureValue(value) {
  if (typeof value !== 'string' || bs58.decode(value).length !== 64) throw Error('Malformed checkpoint signature')
  return value
}
function normalize(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw Error('Missing checkpoint snapshot')
  const result = { githubRepoId: integer(snapshot.githubRepoId, 'repository id', 9223372036854775807n),
    pool: address(snapshot.pool), slot: integer(snapshot.slot, 'slot', 9223372036854775807n) }
  if (result.githubRepoId === '0') throw Error('Malformed repository id')
  for (const role of roles) {
    const source = snapshot[role]
    if (!source?.evidence || !Array.isArray(source.evidence.accounts) || source.evidence.accounts.length !== 3) throw Error('Malformed checkpoint evidence')
    // Rebuild the original reader's property order: JSONB does not retain object key order.
    const evidence = { migration: signatureValue(source.evidence.migration), accounts: source.evidence.accounts.map(account => {
      if (typeof account.data !== 'string' || !account.data || Buffer.from(account.data, 'base64').toString('base64') !== account.data) {
        throw Error('Malformed checkpoint account data')
      }
      return { address: address(account.address), owner: address(account.owner), data: account.data }
    }) }
    const position = address(source.position)
    if (evidence.accounts[0].address !== result.pool || evidence.accounts[1].address !== position ||
        new Set(evidence.accounts.map(a => a.address)).size !== 3) throw Error('Checkpoint evidence identity mismatch')
    if (typeof source.hash !== 'string' || !/^[a-f0-9]{64}$/.test(source.hash) || source.hash !== sha256(evidence)) throw Error('Malformed checkpoint evidence hash')
    const earned = integer(source.earned, 'earned'), claimed = integer(source.claimed, 'claimed'), available = integer(source.available, 'available')
    if (BigInt(earned) !== BigInt(claimed) + BigInt(available)) throw Error('Checkpoint economics mismatch: earned != claimed + available')
    result[role] = { position, earned, claimed, available, hash: source.hash, evidence }
  }
  if (result.creator.position === result.partner.position || result.creator.evidence.migration !== result.partner.evidence.migration ||
      sha256(result.creator.evidence.accounts[0]) !== sha256(result.partner.evidence.accounts[0])) throw Error('Checkpoint single-bank identity mismatch')
  return result
}

// Read-only adapter fails closed rather than allowing graduated-fees' missing-proof discovery
// or storeProof fallback. A private cache namespace forces revalidation of the persisted proof
// even when a production reader has already cached this pool. RPC methods stay bound to the
// original connection; raw finalized transaction fetches use its real endpoint, not the namespace.
export async function readTestDammCheckpoint({ connection, db, config, custodyRecovery = null, market }) {
  const githubRepoId = integer(market?.githubRepoId ?? market?.repoId, 'repository id', 9223372036854775807n)
  if (!db?.query) throw Error('Existing graduated migration proof database required')
  const { rows } = await db.query('select github_repo_id from graduated_migration_proofs where github_repo_id=$1', [githubRepoId])
  if (rows.length !== 1) throw Error('Existing graduated migration proof required; discovery forbidden')
  const readonly = { async query(sql, params) {
    if (!/^select\s/i.test(sql) || !/from graduated_migration_proofs where github_repo_id=\$1\s*$/i.test(sql) ||
        params?.length !== 1 || params[0] !== githubRepoId) throw Error('Checkpoint proof adapter is read-only')
    let result
    try { result = await db.query(sql, params) } catch (cause) {
      // Do not expose 42P01 to the legacy reader's scan fallback.
      throw new Error('Checkpoint migration proof read failed', { cause })
    }
    if (result.rows.length !== 1) throw Error('Existing graduated migration proof required; discovery forbidden')
    return result
  } }
  const namespace = `${connection.rpcEndpoint}#test-checkpoint-${randomUUID()}`
  const readonlyConnection = new Proxy(connection, { get(target, property) {
    if (property === 'rpcEndpoint') return namespace
    if (property === 'getSignaturesForAddress') return () => { throw Error('Checkpoint migration discovery forbidden') }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const snapshot = await createGraduatedFees({ connection: readonlyConnection, db: readonly, config, custodyRecovery,
    loadTransaction: (_connection, signature) => loadFinalizedTransaction(connection, signature) }).read({ ...market, githubRepoId })
  if (!snapshot) throw Error('Existing graduated DAMM market required')
  return normalize({ githubRepoId, pool: snapshot.pool, slot: snapshot.slot, creator: snapshot, partner: snapshot.partner })
}

function advance(before, after) {
  if (before.githubRepoId !== after.githubRepoId || before.pool !== after.pool) throw Error('Checkpoint market identity changed')
  if (BigInt(after.slot) < BigInt(before.slot)) throw Error('Nonmonotonic checkpoint slot / overlapping interval')
  for (const role of roles) {
    const a = before[role], b = after[role]
    if (a.position !== b.position || a.evidence.migration !== b.evidence.migration || a.evidence.accounts.some((account, i) =>
      account.address !== b.evidence.accounts[i].address || account.owner !== b.evidence.accounts[i].owner)) throw Error('Checkpoint position identity changed')
    if (BigInt(b.earned) < BigInt(a.earned) || BigInt(b.claimed) < BigInt(a.claimed)) throw Error('Checkpoint cumulative counter decreased')
    if (before.slot === after.slot && sha256(a) !== sha256(b)) throw Error('Contradictory checkpoint evidence at the same slot')
  }
}
const deltas = (before, after, field = 'earned') => Object.fromEntries(roles.map(role => [role, String(BigInt(after[role][field]) - BigInt(before[role][field]))]))

// Caller MUST have a SQL transaction and the run-row lock, and MUST persist the supplied
// before snapshot before authorizing signing. This function does not authorize trades or
// independently attest when that snapshot was recorded. It takes an additional per-market
// transaction lock to serialize accounting across distinct runs. No production ledger writes.
export async function recordTestDammCheckpoint(client, { runId, step, githubRepoId, signature, before, after }) {
  if (typeof runId !== 'string' || !runId.trim() || runId.length > 200 || !Number.isInteger(step) || step < 1 || step > 6) throw Error('Malformed checkpoint run/step')
  githubRepoId = integer(githubRepoId, 'repository id', 9223372036854775807n)
  signature = signatureValue(signature)
  before = normalize(before); after = normalize(after)
  if (before.githubRepoId !== githubRepoId || after.githubRepoId !== githubRepoId) throw Error('Checkpoint repository identity mismatch')
  const payloadHash = sha256(canonical({ runId, step, githubRepoId, signature, before, after }))
  await client.query("select pg_advisory_xact_lock(hashtextextended('existing-market-test-damm:' || $1, 0))", [githubRepoId])
  const { rows: duplicates } = await client.query(`select payload_hash, result from existing_market_test_damm_checkpoints
    where signature=$1 or (run_id=$2 and step=$3)`, [signature, runId, step])
  if (duplicates.length) {
    if (duplicates.length !== 1 || duplicates[0].payload_hash !== payloadHash) throw Error('Contradictory checkpoint replay')
    return duplicates[0].result
  }
  advance(before, after)
  const { rows: [stored] } = await client.query('select snapshot from existing_market_test_damm_baselines where github_repo_id=$1', [githubRepoId])
  const { rows: [previous] } = await client.query(`select after_snapshot, market_sequence::text as market_sequence
    from existing_market_test_damm_checkpoints where github_repo_id=$1 order by market_sequence desc limit 1`, [githubRepoId])
  if (Boolean(stored) !== Boolean(previous)) throw Error('Incomplete checkpoint baseline/history; review required')
  const historical = stored ? normalize(stored.snapshot) : before
  const accountingBaseline = previous ? normalize(previous.after_snapshot) : before
  advance(historical, accountingBaseline)
  advance(accountingBaseline, before)
  const delta = deltas(accountingBaseline, after), claimed = deltas(accountingBaseline, after, 'claimed')
  const id = randomUUID()
  const result = { status: 'recorded', creatorDelta: delta.creator, partnerDelta: delta.partner,
    creatorClaimedDelta: claimed.creator, partnerClaimedDelta: claimed.partner,
    historicalReserved: Object.fromEntries(roles.map(role => [role, historical[role].available])),
    historicalEarned: Object.fromEntries(roles.map(role => [role, historical[role].earned])),
    gapDelta: deltas(accountingBaseline, before), observedIntervalDelta: deltas(before, after),
    attribution: 'finalized-account-interval-not-exclusive-swap', evidenceLink: `existing_market_test_damm_checkpoints:${id}` }
  // Historical available is the reserved liability at first observation, not a claim that
  // those funds remain unclaimed today. Claimed counters and full snapshots retain movements.
  if (!stored) await client.query('insert into existing_market_test_damm_baselines (github_repo_id, snapshot) values ($1,$2::jsonb)',
    [githubRepoId, JSON.stringify(before)])
  await client.query(`insert into existing_market_test_damm_checkpoints
    (id, run_id, step, github_repo_id, signature, market_sequence, payload_hash, before_snapshot, after_snapshot, accounting_baseline, result)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)`,
  [id, runId, step, githubRepoId, signature, String(BigInt(previous?.market_sequence ?? '0') + 1n), payloadHash,
    JSON.stringify(before), JSON.stringify(after), JSON.stringify(accountingBaseline), JSON.stringify(result)])
  return result
}
