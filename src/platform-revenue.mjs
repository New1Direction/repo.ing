import { randomUUID } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { loadBuybackReceipts } from '../app/lib/buyback-receipts-db.mjs'
import { BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'

// Canonical platform-revenue accounting. Builder and repository earnings are never
// touched here: this ledger only covers revenue repo.ing owns (partner fees).
// Accounting determines available revenue, policy determines the allocation, a
// reviewed intent pins the spend, and any executor may only run that exact intent.

const PERMILLE = 1000n
const REVENUE_LOCK = 'platform-revenue-allocation'
// Claims settle to the partner wallet; the team moves the buyback share to the published custody wallet and buys
// there. Receipts from a mapped custody wallet spend the reserve of the partner wallet that funds it.
// Owner decision (2026-09-29): team-wallet buybacks from this point on also satisfy the buyback policy. Earlier team
// buys predate the policy and stay separate, so they don't pre-pay future platform buybacks.
export const TEAM_BUYBACKS_COUNT_FROM = '2026-09-29T23:00:00.000Z'
export const CUSTODY_FUNDED_BY = Object.freeze({ H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3: BUYBACK_WALLETS.custody })

export function buybackExecutionConfig(env = process.env) {
  if (env.REPO_BUYBACK_EXECUTION_ENABLED !== 'true') return null
  const required = ['REPO_TOKEN_MINT', 'REPO_TREASURY_TOKEN_ACCOUNT', 'REPO_BUYBACK_VENUE',
    'REPO_BUYBACK_MAX_SLIPPAGE_BPS', 'REPO_BUYBACK_MAX_PRICE_IMPACT_BPS',
    'REPO_BUYBACK_MIN_SIZE_LAMPORTS', 'REPO_BUYBACK_MAX_SIZE_LAMPORTS']
  const missing = required.filter(name => !env[name])
  if (missing.length) throw Error(`Buyback execution configuration incomplete: ${missing.join(', ')}`)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env.REPO_TOKEN_MINT)) throw Error('Invalid REPO_TOKEN_MINT')
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env.REPO_TREASURY_TOKEN_ACCOUNT)) throw Error('Invalid REPO_TREASURY_TOKEN_ACCOUNT')
  const bounds = {
    maxSlippageBps: Number(env.REPO_BUYBACK_MAX_SLIPPAGE_BPS), maxPriceImpactBps: Number(env.REPO_BUYBACK_MAX_PRICE_IMPACT_BPS),
    minSizeLamports: env.REPO_BUYBACK_MIN_SIZE_LAMPORTS, maxSizeLamports: env.REPO_BUYBACK_MAX_SIZE_LAMPORTS,
  }
  if (!(bounds.maxSlippageBps > 0 && bounds.maxSlippageBps < 10_000) || !(bounds.maxPriceImpactBps > 0)) throw Error('Invalid buyback bounds')
  if (!(BigInt(bounds.minSizeLamports) > 0n) || !(BigInt(bounds.maxSizeLamports) >= BigInt(bounds.minSizeLamports))) throw Error('Invalid buyback size bounds')
  return { mint: env.REPO_TOKEN_MINT, treasuryTokenAccount: env.REPO_TREASURY_TOKEN_ACCOUNT,
    venue: env.REPO_BUYBACK_VENUE, network: 'mainnet', ...bounds }
}

export async function activePolicy(db) {
  const { rows: [policy] } = await db.query(`select version, buyback_permille as "buybackPermille",
    liquidity_permille as "liquidityPermille", activated_at as "activatedAt" from platform_revenue_policies
    where activated_at is not null order by activated_at desc, version desc limit 1`)
  return policy ?? null
}

export async function platformRevenueSummary(db) {
  const { rows: earned } = await db.query(`select phase, coalesce(sum(earned_amount),0)::text as amount
    from platform_revenue group by phase`)
  const { rows: claimed } = await db.query(`select phase, coalesce(sum(amount),0)::text as amount
    from platform_fee_claims where status='settled' group by phase`)
  const { rows: allocated } = await db.query(`select coalesce(sum(buyback_amount),0)::text as buyback,
    coalesce(sum(liquidity_amount),0)::text as liquidity, coalesce(sum(treasury_amount),0)::text as treasury
    from platform_revenue_allocations`)
  const { rows: spent } = await db.query(`select coalesce(sum(amount),0)::text as amount
    from buyback_intents where status='settled'`)
  const { rows: unallocated } = await db.query(`select coalesce(sum(c.amount),0)::text as amount
    from platform_fee_claims c where c.status='settled'
    and not exists (select 1 from platform_revenue_allocations a where a.claim_signature = c.signature)`)
  const byPhase = Object.fromEntries(earned.map(row => [row.phase.toLowerCase(), BigInt(row.amount)]))
  const claimedByPhase = Object.fromEntries(claimed.map(row => [row.phase.toLowerCase(), BigInt(row.amount)]))
  const claimedTotal = (claimedByPhase.dbc ?? 0n) + (claimedByPhase.damm ?? 0n)
  const allocatedBuyback = BigInt(allocated[0].buyback), allocatedLiquidity = BigInt(allocated[0].liquidity)
  const allocatedTreasury = BigInt(allocated[0].treasury)
  const spentTotal = BigInt(spent[0].amount)
  // Custody buybacks executed by hand and published as receipts (hand-verified + worker-detected) spend the
  // same reserve; count each signature once, whether or not it was also imported as a settled intent.
  // Only receipts from the fee-receiving wallet, or the custody wallet it funds, count against this ledger.
  const { rows: imported } = await db.query(`select signature from buyback_intents where status='settled' and signature is not null`)
  const { rows: custody } = await db.query(`select distinct wallet from platform_fee_claims where status='settled'`)
  const importedSignatures = new Set(imported.map(row => row.signature)), custodyWallets = new Set(custody.flatMap(row => [row.wallet, CUSTODY_FUNDED_BY[row.wallet]].filter(Boolean)))
  const publishedSpent = (custodyWallets.size ? await loadBuybackReceipts(db) : [])
    .filter(receipt => !importedSignatures.has(receipt.signature) && (receipt.source === 'custody' ? custodyWallets.has(receipt.wallet)
      : receipt.source === 'team' && receipt.at >= TEAM_BUYBACKS_COUNT_FROM))
    .reduce((sum, receipt) => sum + BigInt(receipt.spentLamports), 0n)
  const outstanding = allocatedBuyback - spentTotal - publishedSpent
  return {
    earned: { damm: (byPhase.damm ?? 0n).toString(), dbc: (byPhase.dbc ?? 0n).toString(),
      total: ((byPhase.damm ?? 0n) + (byPhase.dbc ?? 0n)).toString() },
    claimed: { damm: (claimedByPhase.damm ?? 0n).toString(), dbc: (claimedByPhase.dbc ?? 0n).toString(), total: claimedTotal.toString() },
    available: unallocated[0].amount,
    allocated: { buyback: allocatedBuyback.toString(), liquidity: allocatedLiquidity.toString(),
      treasury: allocatedTreasury.toString(), total: (allocatedBuyback + allocatedLiquidity + allocatedTreasury).toString() },
    spent: spentTotal.toString(),
    publishedSpent: publishedSpent.toString(),
    // What the policy still owes to buybacks; buying beyond it is allowed and reported as buybackAhead.
    buybackReserve: (outstanding > 0n ? outstanding : 0n).toString(),
    buybackAhead: (outstanding < 0n ? -outstanding : 0n).toString(),
    intentReserve: (allocatedBuyback - spentTotal).toString(),
    activePolicy: await activePolicy(db),
  }
}

export function createPlatformRevenue({ pool, partnerWallet }) {
  async function createPolicy({ buybackPermille, liquidityPermille, createdBy }) {
    if (!Number.isInteger(buybackPermille) || !Number.isInteger(liquidityPermille) ||
        buybackPermille < 0 || liquidityPermille < 0 || buybackPermille + liquidityPermille > 1000)
      throw Error('Policy permilles must be non-negative integers summing to at most 1000')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [REVENUE_LOCK])
      try {
        const { rows: [latest] } = await client.query('select coalesce(max(version),0)::int as v from platform_revenue_policies')
        const { rows: [policy] } = await client.query(`insert into platform_revenue_policies
          (version, buyback_permille, liquidity_permille, created_by) values ($1,$2,$3,$4)
          returning version, buyback_permille as "buybackPermille", liquidity_permille as "liquidityPermille"`,
          [latest.v + 1, buybackPermille, liquidityPermille, createdBy])
        return policy
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [REVENUE_LOCK]) }
    } finally { client.release() }
  }

  async function activatePolicy({ version, createdBy }) {
    if (!Number.isInteger(version)) throw Error('Policy version must be an integer')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [REVENUE_LOCK])
      try {
        const { rows: [policy] } = await client.query(`update platform_revenue_policies set activated_at=now()
          where version=$1 and activated_at is null returning version`, [version])
        if (!policy) throw Error('Policy version is unknown or already immutable (activated)')
        return { version, activatedBy: createdBy }
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [REVENUE_LOCK]) }
    } finally { client.release() }
  }

  async function allocate({ review, createdBy }) {
    if (!review || review.purpose !== 'platform-revenue-allocate' || review.expiresAt <= Date.now()) throw Error('Allocation review expired')
    const policy = await activePolicy(pool)
    if (!policy) throw Error('No active platform revenue policy')
    if (review.policyVersion !== policy.version) throw Error('Allocation review names a different policy version')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [REVENUE_LOCK])
      try {
        const { rows: claims } = await client.query(`select c.signature, c.github_repo_id::text as "githubRepoId",
          c.amount::text as amount from platform_fee_claims c where c.status='settled'
          and not exists (select 1 from platform_revenue_allocations a where a.claim_signature = c.signature) for share`)
        if (!claims.length) throw Error('No claimed platform revenue is available to allocate')
        const group = randomUUID()
        await client.query('begin')
        try {
          for (const claim of claims) {
            const amount = BigInt(claim.amount)
            const buyback = amount * BigInt(policy.buybackPermille) / PERMILLE
            const liquidity = amount * BigInt(policy.liquidityPermille) / PERMILLE
            const treasury = amount - buyback - liquidity
            await client.query(`insert into platform_revenue_allocations
              (allocation_group, claim_signature, github_repo_id, claimed_amount, buyback_amount,
               liquidity_amount, treasury_amount, policy_version, created_by)
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [group, claim.signature, claim.githubRepoId,
              claim.amount, buyback.toString(), liquidity.toString(), treasury.toString(), policy.version, createdBy])
          }
          await client.query('commit')
        } catch (error) { await client.query('rollback'); throw error }
        const totals = claims.reduce((sum, claim) => sum + BigInt(claim.amount), 0n)
        return { group, policyVersion: policy.version, claims: claims.length, claimedAmount: totals.toString() }
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [REVENUE_LOCK]) }
    } finally { client.release() }
  }

  async function groupBuybackRemaining(db, group) {
    const { rows: [row] } = await db.query(`select coalesce(sum(buyback_amount),0)::text as buyback
      from platform_revenue_allocations where allocation_group=$1`, [group])
    if (!row) throw Error('Unknown allocation group')
    const { rows: intents } = await db.query(`select coalesce(sum(amount),0)::text as assigned
      from buyback_intents where allocation_group=$1 and status <> 'aborted'`, [group])
    return BigInt(row.buyback) - BigInt(intents[0].assigned)
  }

  async function createIntent({ allocationGroup, amount, idempotencyKey, createdBy }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(allocationGroup ?? '')) throw Error('Invalid allocation group')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(idempotencyKey ?? '')) throw Error('Invalid idempotency key')
    const spend = BigInt(amount ?? '')
    if (spend <= 0n) throw Error('Buyback amount must be positive')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [REVENUE_LOCK])
      try {
        const { rows: [policyRow] } = await client.query(`select policy_version from platform_revenue_allocations
          where allocation_group=$1 limit 1`, [allocationGroup])
        if (!policyRow) throw Error('Unknown allocation group')
        await assertPlatformReserveCustody(client, partnerWallet, allocationGroup)
        const remaining = await groupBuybackRemaining(client, allocationGroup)
        if (spend > remaining) throw Error('Buyback amount exceeds the remaining reserve for this allocation')
        const { rows: [intent] } = await client.query(`insert into buyback_intents
          (idempotency_key, allocation_group, amount, wallet_source, policy_version, network, status,
           expires_at, created_by)
          values ($1,$2,$3,$4,$5,'mainnet','prepared', now() + interval '30 minutes', $6)
          on conflict (idempotency_key) do nothing returning id, idempotency_key as "idempotencyKey",
            allocation_group as "allocationGroup", amount::text as amount, status, policy_version as "policyVersion",
            expires_at as "expiresAt"`, [idempotencyKey, allocationGroup, spend.toString(),
            partnerWallet.toBase58(), policyRow.policy_version, createdBy])
        if (!intent) throw Error('A buyback intent with this idempotency key already exists')
        return intent
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [REVENUE_LOCK]) }
    } finally { client.release() }
  }

  async function reviewIntent({ id, review, reviewedBy }) {
    if (!review || review.purpose !== 'buyback-intent-review' || review.expiresAt <= Date.now()) throw Error('Buyback review expired')
    const client = await pool.connect()
    try {
      const { rows: [prepared] } = await client.query(`select id, amount::text as amount from buyback_intents
        where id=$1 and status='prepared'`, [id])
      if (!prepared) throw Error('Intent is not awaiting review')
      if (typeof review.amount !== 'string' || BigInt(review.amount) !== BigInt(prepared.amount)) throw Error('Reviewed amount differs from the prepared intent')
      const { rows: [intent] } = await client.query(`update buyback_intents set status='reviewed',
        reviewed_by=$2, reviewed_at=now(), review=$3,
        destination_mint=$4, destination_token_account=$5, quote_identifier=$6,
        expected_output=$7, minimum_output=$8, max_slippage_bps=$9, max_price_impact_bps=$10
        where id=$1 and status='prepared' returning id, amount::text as amount, policy_version as "policyVersion",
          allocation_group as "allocationGroup", expires_at as "expiresAt"`,
        [id, reviewedBy, JSON.stringify(review), review.destinationMint ?? null, review.destinationTokenAccount ?? null,
          review.quoteIdentifier ?? null, review.expectedOutput ?? null, review.minimumOutput ?? null,
          review.maxSlippageBps ?? null, review.maxPriceImpactBps ?? null])
      if (!intent) throw Error('Intent is not awaiting review')
      return intent
    } finally { client.release() }
  }

  async function simulateIntent({ id }) {
    const client = await pool.connect()
    try {
      const { rows: [intent] } = await client.query(`select id, amount::text as amount, status,
        policy_version as "policyVersion", expires_at as "expiresAt", destination_mint as "destinationMint",
        destination_token_account as "destinationTokenAccount" from buyback_intents where id=$1`, [id])
      if (!intent) throw Error('Unknown buyback intent')
      if (intent.status !== 'reviewed') throw Error('Only reviewed intents can be simulated')
      if (new Date(intent.expiresAt).getTime() <= Date.now()) throw Error('Intent review expired')
      const checks = { policyVersionCurrent: true, withinReserve: true, executionGate: 'disabled-or-unset' }
      const policy = await activePolicy(client)
      if (policy && policy.version !== intent.policyVersion) { checks.policyVersionCurrent = false; throw Error('Policy version mismatch; re-review under the active policy') }
      const remaining = await groupBuybackRemaining(client, (await client.query('select allocation_group from buyback_intents where id=$1', [id])).rows[0].allocation_group)
      if (BigInt(intent.amount) > remaining) { checks.withinReserve = false; throw Error('Intent exceeds the remaining buyback reserve') }
      let gate = null
      try { gate = buybackExecutionConfig() } catch (error) { throw Error(error.message) }
      if (gate) {
        if (intent.destinationMint !== gate.mint) throw Error('Intent destination mint differs from the canonical REPO mint')
        if (intent.destinationTokenAccount !== gate.treasuryTokenAccount) throw Error('Intent destination token account differs from the canonical treasury')
      }
      const simulation = { dryRun: true, broadcast: false, checks, gateConfigured: Boolean(gate),
        tokenFieldsSet: Boolean(intent.destinationMint), simulatedAt: new Date().toISOString(),
        note: gate ? 'Execution gate configured; live quote validation applies before any broadcast'
          : 'Dry run only: $REPO configuration is absent, execution is impossible by construction' }
      const { rows: [updated] } = await client.query(`update buyback_intents set status='simulated',
        simulated_at=now(), simulation=$2 where id=$1 and status='reviewed' returning id, status`,
        [id, JSON.stringify(simulation)])
      if (!updated) throw Error('Intent left the reviewed state')
      return { id, status: 'simulated', simulation }
    } finally { client.release() }
  }

  async function executeIntent({ id }) {
    const gate = buybackExecutionConfig()
    if (!gate) throw Error('Buyback execution is disabled: $REPO configuration is absent')
    const client = await pool.connect()
    try {
      const { rows: [intent] } = await client.query(`select id, status, amount::text as amount,
        destination_mint as "destinationMint", destination_token_account as "destinationTokenAccount",
        max_slippage_bps as "maxSlippageBps", max_price_impact_bps as "maxPriceImpactBps",
        expires_at as "expiresAt" from buyback_intents where id=$1`, [id])
      if (!intent) throw Error('Unknown buyback intent')
      if (intent.status === 'settled') throw Error('Intent already settled')
      if (intent.status !== 'simulated') throw Error('Only simulated intents can execute')
      if (new Date(intent.expiresAt).getTime() <= Date.now()) throw Error('Intent expired')
      if (intent.destinationMint !== gate.mint) throw Error('Wrong destination mint')
      if (intent.destinationTokenAccount !== gate.treasuryTokenAccount) throw Error('Wrong destination token account')
      const spend = BigInt(intent.amount)
      if (spend < BigInt(gate.minSizeLamports) || spend > BigInt(gate.maxSizeLamports)) throw Error('Buyback size outside approved bounds')
      if (intent.maxSlippageBps == null || intent.maxSlippageBps > gate.maxSlippageBps) throw Error('Slippage beyond policy')
      if (intent.maxPriceImpactBps == null || intent.maxPriceImpactBps > gate.maxPriceImpactBps) throw Error('Price impact beyond policy')
      throw Error('No approved buyback venue implementation is configured for this network')
    } finally { client.release() }
  }

  async function importBuyback({ signature, allocationGroup, createdBy, connection, mint }) {
    // Records an operator-executed on-chain buyback into the same settled-intent
    // ledger the reviewed flow uses. The chain receipt is the authority: SOL spent,
    // destination mint and treasury account all come from the finalized transaction.
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature ?? '')) throw Error('Invalid buyback signature')
    if (!connection) throw Error('A finalized chain connection is required to import a buyback')
    const mintKey = mint && new PublicKey(mint)
    if (!mintKey) throw Error('Canonical buyback mint is required')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [REVENUE_LOCK])
      try {
        const receipt = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
        if (!receipt?.meta || receipt.meta.err) throw Error('Buyback transaction is not a finalized success')
        const keys = receipt.transaction.message.accountKeys
        const index = keys.findIndex(key => key.equals(partnerWallet))
        if (index < 0) throw Error('Custody wallet is absent from the buyback transaction')
        const spent = BigInt(receipt.meta.preBalances[index]) - BigInt(receipt.meta.postBalances[index]) - BigInt(receipt.meta.fee)
        if (spent <= 0n) throw Error('Transaction did not spend custody SOL beyond its network fee')
        const gained = (receipt.meta.postTokenBalances ?? []).find(b => (b.mint?.toBase58?.() ?? b.mint) === mint)
        const before = gained && (receipt.meta.preTokenBalances ?? []).find(b => b.accountIndex === gained.accountIndex)
        if (!gained || !before || BigInt(gained.uiTokenAmount.amount) <= BigInt(before.uiTokenAmount.amount))
          throw Error('No canonical token gain for the custody wallet in this transaction')
        if (gained.owner !== partnerWallet.toBase58()) throw Error('Bought tokens are held outside the custody wallet')
        const group = allocationGroup ?? (await client.query(`select allocation_group from platform_revenue_allocations order by created_at desc limit 1`)).rows[0]?.allocation_group
        const { rows: [policyRow] } = await client.query(`select policy_version from platform_revenue_allocations
          where allocation_group=$1 limit 1`, [group])
        if (!policyRow) throw Error('Unknown allocation group')
        if (spent > await groupBuybackRemaining(client, group)) throw Error('Imported spend exceeds the remaining buyback reserve')
        const idempotencyKey = `import.${signature.slice(0, 56)}`
        const { rows: [intent] } = await client.query(`insert into buyback_intents
          (idempotency_key, allocation_group, amount, wallet_source, destination_mint, destination_token_account,
           expected_output, policy_version, network, status, expires_at, review, settled_at, signature, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,'mainnet','settled', now() + interval '30 minutes', $9,
            to_timestamp($10), $11, $12)
          on conflict (idempotency_key) do nothing returning id, idempotency_key as "idempotencyKey",
            amount::text as amount, status, signature`, [idempotencyKey, group, spent.toString(), partnerWallet.toBase58(),
            mint, keys[gained.accountIndex].toBase58(), gained.uiTokenAmount.amount, policyRow.policy_version,
            JSON.stringify({ purpose: 'manual-buyback-import', importedBy: createdBy, signature, source: 'operator-executed swap' }),
            receipt.blockTime, signature, createdBy])
        if (!intent) throw Error('This buyback is already recorded')
        return intent
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [REVENUE_LOCK]) }
    } finally { client.release() }
  }

  return { createPolicy, activatePolicy, allocate, createIntent, reviewIntent, simulateIntent, executeIntent, importBuyback }
}

export async function reconcilePlatformRevenue(db) {
  const summary = await platformRevenueSummary(db)
  const problems = []
  const allocatedTotal = BigInt(summary.allocated.total)
  const claimedTotal = BigInt(summary.claimed.total)
  if (allocatedTotal > claimedTotal) problems.push('Allocations exceed claimed platform revenue')
  // Only protocol-executed intents are bounded by the reserve; published manual buybacks may exceed policy.
  if (BigInt(summary.intentReserve) < 0n) problems.push('Buyback spend exceeds the buyback reserve')
  const { rows: orphans } = await db.query(`select count(*)::int as n from platform_revenue_allocations a
    where not exists (select 1 from platform_fee_claims c where c.signature = a.claim_signature and c.status='settled')`)
  if (orphans[0].n > 0) problems.push('Allocations reference claims that are not settled')
  const { rows: settled } = await db.query(`select count(*)::int as n from buyback_intents where status='settled'`)
  // Imported intents are operator-executed swaps verified against their on-chain
  // receipts; the execution gate only bounds protocol-initiated buybacks.
  const { rows: protocolSettled } = await db.query(`select count(*)::int as n from buyback_intents
    where status='settled' and idempotency_key not like 'import.%'`)
  if (!buybackExecutionConfigSafe()) { if (protocolSettled[0].n > 0) problems.push('Buybacks settled while execution is disabled') }
  else if (settled[0].n > 0) {
    const { rows: reserve } = await db.query(`select coalesce(sum(buyback_amount),0)::text as b from platform_revenue_allocations`)
    const { rows: spent } = await db.query(`select coalesce(sum(amount),0)::text as s from buyback_intents where status='settled'`)
    if (BigInt(spent[0].s) > BigInt(reserve[0].b)) problems.push('Settled buybacks exceed the reserve')
  }
  return { status: problems.length ? 'MISMATCH' : 'MATCH', problems,
    summary: { earned: summary.earned.total, claimed: summary.claimed.total,
      available: summary.available, allocated: summary.allocated.total,
      buybackReserve: summary.buybackReserve, spent: summary.spent } }
}

// Accounting reserves can be held in the operator's receiving wallet. The
// partner executor must never substitute its own unrelated SOL for those funds.
export async function assertPlatformReserveCustody(db, wallet, group = null) {
  const { rows } = await db.query(`select distinct c.wallet from platform_revenue_allocations a
    join platform_fee_claims c on c.signature=a.claim_signature where c.status='settled'
    and ($1::text is null or a.allocation_group=$1) and c.wallet<>$2`, [group, wallet.toBase58()])
  if (rows.length) throw Error('Allocated revenue is held in a different treasury wallet; spending authority must be reviewed')
}

function buybackExecutionConfigSafe() { try { return Boolean(buybackExecutionConfig()) } catch { return false } }
