import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { PublicKey } from '@solana/web3.js'
import { BUYBACK_IMPORT_REFUSALS, createPlatformRevenue, platformRevenueSummary, reconcilePlatformRevenue } from '../src/platform-revenue.mjs'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { BUYBACK_RECEIPTS, BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { OFFICIAL_TOKEN } from '../app/lib/official-token.mjs'

// Recording a buyback by hand against real PostgreSQL (all committed migrations): the statements of importBuyback, the
// constraints and unique keys of buyback_intents, and the ledger's own summary. What the import accepts is covered without
// a database in tests/buyback-import.test.mjs.
const url = process.env.BUYBACK_IMPORT_TEST_DATABASE_URL
const TXS = JSON.parse(readFileSync(new URL('./fixtures/repoing-buyback-transactions.json', import.meta.url), 'utf8'))
const loadTransaction = async (_connection, signature) => TXS[signature] ? normalizeFinalizedTransaction(structuredClone(TXS[signature]), signature) : null
const SOL = 1_000_000_000n

test('real PostgreSQL: a recorded buyback is one settled intent, bounded by its allocation and counted once', { skip: !url }, async () => {
  assert.equal(new URL(url).hostname, '127.0.0.1')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query('truncate repositories, platform_revenue_policies, platform_revenue_allocations, buyback_intents, platform_fee_claims restart identity cascade')
    await pool.query("insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values(998700,'local','buyback','local/buyback',1,0,false,now())")
    await pool.query("insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol) values(998700,'prepared','mint','curve','wallet','creator','Buyback','BUY')")
    await pool.query("insert into platform_revenue_policies(version,buyback_permille,liquidity_permille,activated_at,created_by) values(1,600,200,now(),'fixture')")
    // 10 SOL of platform fees claimed and allocated: 6 SOL is the buyback share.
    await pool.query(`insert into platform_fee_claims(github_repo_id,pool,wallet,amount,status,signature,signed_transaction,last_valid_block_height,settled_at)
      values(998700,'damm','partner',$1,'settled','claim-one','signed',100,now())`, [String(10n * SOL)])
    await pool.query(`insert into platform_revenue_allocations(allocation_group,claim_signature,github_repo_id,claimed_amount,buyback_amount,liquidity_amount,treasury_amount,policy_version,created_by)
      values('group-one','claim-one',998700,$1,$2,$3,$3,1,'fixture')`, [String(10n * SOL), String(6n * SOL), String(2n * SOL)])
    const [five, one, another] = BUYBACK_RECEIPTS.filter(receipt => receipt.source === 'custody')
    assert.deepEqual([five.spentLamports, one.spentLamports, another.spentLamports], [String(5n * SOL), String(SOL), String(SOL)])
    const service = createPlatformRevenue({ pool, partnerWallet: new PublicKey(BUYBACK_WALLETS.custody) })
    const record = signature => service.importBuyback({ signature, allocationGroup: null, createdBy: '123', connection: { rpcEndpoint: 'http://rpc.invalid' },
      mint: OFFICIAL_TOKEN.mint, loadTransaction })

    const intent = await record(five.signature)
    assert.deepEqual({ ...intent, id: Number(intent.id) }, { id: 1, idempotencyKey: `import.${five.signature.slice(0, 56)}`, amount: five.spentLamports, status: 'settled', signature: five.signature })
    const { rows: [stored] } = await pool.query(`select allocation_group, amount::text as amount, wallet_source, destination_mint, destination_token_account, expected_output,
      policy_version, network, status, settled_at, resolved_at, signature, created_by, review from buyback_intents`)
    const raw = TXS[five.signature], account = raw.meta.postTokenBalances.find(balance => balance.owner === BUYBACK_WALLETS.custody && balance.mint === OFFICIAL_TOKEN.mint)
    assert.deepEqual({ ...stored, settled_at: stored.settled_at.toISOString(), review: JSON.parse(stored.review) }, { allocation_group: 'group-one', amount: five.spentLamports,
      wallet_source: BUYBACK_WALLETS.custody, destination_mint: OFFICIAL_TOKEN.mint, destination_token_account: raw.transaction.message.accountKeys[account.accountIndex],
      expected_output: five.tokenBaseUnits, policy_version: 1, network: 'mainnet', status: 'settled', settled_at: five.at, resolved_at: null, signature: five.signature,
      created_by: '123', review: { purpose: 'manual-buyback-import', importedBy: '123', signature: five.signature, source: 'operator-executed swap' } })

    // The same signature again writes nothing.
    await assert.rejects(record(five.signature), { message: BUYBACK_IMPORT_REFUSALS.recorded })
    // 1 SOL is left in the allocation: one more 1 SOL buy fits exactly, the next does not.
    assert.equal((await record(one.signature)).amount, one.spentLamports)
    await assert.rejects(record(another.signature), { message: BUYBACK_IMPORT_REFUSALS.reserve })
    assert.equal((await pool.query('select count(*)::int as n from buyback_intents')).rows[0].n, 2)
    // Nothing holds the ledger lock afterwards, and no connection is left checked out.
    assert.equal((await pool.query("select count(*)::int as n from pg_locks where locktype='advisory'")).rows[0].n, 0)
    assert.equal(pool.idleCount, pool.totalCount)

    const summary = await platformRevenueSummary(pool)
    assert.deepEqual({ spent: summary.spent, buybackReserve: summary.buybackReserve, buybackAhead: summary.buybackAhead, intentReserve: summary.intentReserve },
      { spent: String(6n * SOL), buybackReserve: '0', buybackAhead: '0', intentReserve: '0' })
    const reconciliation = await reconcilePlatformRevenue(pool)
    assert.deepEqual([reconciliation.status, reconciliation.problems], ['MATCH', []])
  } finally { await pool.end() }
})
