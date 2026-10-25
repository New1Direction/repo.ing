import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import bs58 from 'bs58'

test('recovery fees require agreeing receipts, survive restart/replayed cursor, and preserve per-event rounding',
  { skip: !process.env.RECOVERY_FEES_TEST_DATABASE_URL }, async t => {
    const url = new URL(process.env.RECOVERY_FEES_TEST_DATABASE_URL)
    assert.equal(url.hostname, '')
    assert.equal(url.pathname, '/repoing_recovery_fees_test')
    assert.match(url.searchParams.get('host'), /\/\.amp\/in\/fee-pg\/socket$/)
    const pool = new pg.Pool({ connectionString: url.href })
    const key = n => new PublicKey(Buffer.alloc(32, n)), config = key(171), mint = key(172), creator = key(173)
    const address = deriveDbcPoolAddress(NATIVE_MINT, mint, config)
    const programId = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
    const market = { repoId: '101', githubRepoId: 101n, pool: address.toBase58(), mint: mint.toBase58(),
      creatorWallet: creator.toBase58(), launchSignature: 'launch' }
    const history = [{ signature: 'b', slot: 12, err: null }, { signature: 'a', slot: 11, err: null },
      { signature: 'launch', slot: 10, err: null }]
    const connection = { rpcEndpoint: 'https://primary.invalid', getSignaturesForAddress: async () => history }
    const verification = { rpcEndpoint: 'https://verifier.invalid', getSignaturesForAddress: async () => history }
    const dbc = new DynamicBondingCurveClient(connection, 'finalized'), coder = dbc.state.getProgram().coder
    const proto = Object.getPrototypeOf(dbc.state)
    t.mock.method(proto, 'getPool', async () => ({ poolState: { creator, config, baseMint: mint, creatorQuoteFee: new BN(5) } }))
    t.mock.method(proto, 'getPoolConfig', async () => ({ quoteMint: NATIVE_MINT, collectFeeMode: 0, creatorTradingFeePercentage: 71 }))
    const receipt = (signature, fee) => {
      const data = { pool: address, config, tradeDirection: 1, hasReferral: false,
        params: { amountIn: new BN(100), minimumAmountOut: new BN(1) }, amountIn: new BN(100),
        currentTimestamp: new BN(1700000001), swapResult: { actualInputAmount: new BN(95), outputAmount: new BN(10),
          nextSqrtPrice: new BN(100), tradingFee: new BN(fee), protocolFee: new BN(1), referralFee: new BN(0) } }
      const event = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'),
        Buffer.from(dbc.state.getProgram().idl.events.find(e => e.name === 'evtSwap').discriminator), coder.types.encode('evtSwap', data)])
      return { slot: { a: 11, launch: 10 }[signature] ?? 12, blockTime: 1700000001, version: 'legacy',
        transaction: { signatures: [signature], message: { accountKeys: [key(1), config, address, key(2), key(3), key(4), key(5), mint, NATIVE_MINT, creator, programId],
          header: { numRequiredSignatures: 1 }, instructions: [{ programIdIndex: 10, accounts: [0,1,2,3,4,5,6,7,8,9], data: bs58.encode(Buffer.from([248,198,158,145,225,117,135,200])) }] } },
        meta: { err: null, fee: 5000, preBalances: [10000], postBalances: [5000], preTokenBalances: [], postTokenBalances: [],
          innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 10, accounts: [], stackHeight: 2, data: bs58.encode(event) }] }] } }
    }
    let disagree = true
    const finalized = await import('../src/finalized-transaction.mjs')
    t.mock.module('../src/finalized-transaction.mjs', { namedExports: {
      ...finalized,
      // The launch transaction carries a first buy: a market with no cursor is read from (and including) its launch.
      loadFinalizedTransaction: async (rpc, signature) => receipt(signature, signature === 'a' ? 2 : signature === 'launch' ? 4 : disagree && rpc === verification ? 5 : 4),
      forgetFinalizedTransaction() {},
    } })
    const { indexRecoveryFees } = await import('../scripts/recovery-fee-indexer.mjs')
    try {
      await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade')
      await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
      // Roles belong to the disposable cluster, not this database: other acceptance databases may use them.
      const existingRoles = new Set((await pool.query("select rolname from pg_roles where rolname in ('repoing_ledger_reader','repoing_fee_indexer')")).rows.map(r => r.rolname))
      const grants = readFileSync(new URL('../scripts/recovery-accounting-roles.sql', import.meta.url), 'utf8')
      await pool.query(grants.replace(/^CREATE ROLE (\w+) .*;$/gm, (line, role) => existingRoles.has(role) ? '' : line))
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
        values(101,'fixture','fees','fixture/fees',0,0,false,now())`)
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,
        indexed_at,launch_finality,launch_signature,launch_slot,launch_block_time,discovery_version,last_verified_at)
        values(101,'confirmed',$1,$2,$3,$3,'Fixture','F',now(),'finalized','launch',10,to_timestamp(1700000000),2,now())`,
      [market.mint, market.pool, market.creatorWallet])
      const writer = new pg.Pool({ connectionString: url.href, options: '-c role=repoing_fee_indexer' })
      const reader = new pg.Pool({ connectionString: url.href, options: '-c role=repoing_ledger_reader' })
      t.after(async () => { await writer.end(); await reader.end() })
      const run = () => indexRecoveryFees({ pool: writer, connection, verification, config, market })
      await assert.rejects(run(), /RPC_DISAGREEMENT/)
      assert.deepEqual((await pool.query('select last_signature from pool_fee_cursors')).rows, [{ last_signature: 'a' }])
      disagree = false
      await run()
      const totals = async () => (await pool.query(`select
        (select sum(amount_base_units)::text from fee_events) creator,
        (select sum(partner_amount)::text from discovery_fee_events) partner,
        (select count(*)::int from fee_events) events,
        (select count(*)::int from repo_claims) claims`)).rows[0]
      assert.deepEqual(await totals(), { creator: '5', partner: '5', events: 3, claims: 0 }, 'the first buy in the launch transaction is accounted')
      assert.equal((await run()).creditedBaseUnits, 0n)
      await pool.query('delete from pool_fee_cursors')
      assert.equal((await run()).creditedBaseUnits, 0n)
      assert.deepEqual(await totals(), { creator: '5', partner: '5', events: 3, claims: 0 })
      const { createReconciler } = await import('../src/reconcile.mjs')
      const reconciled = await createReconciler({ pool: reader, connection, config,
        custodyRecovery: { version: 1, poolCreators: [], positions: [] } }).reconcile('101')
      assert.equal(reconciled.status, 'MATCH')
      assert.equal(reconciled.recordedEarned, 5n)
      for (const role of [reader, writer]) for (const query of ['select signed_transaction from repo_claims',
        'select * from launch_sessions', 'update repo_beneficiaries set wallet=wallet',
        'insert into custody_fee_payouts default values', 'insert into repo_claims default values',
        'update markets set status=status']) await assert.rejects(role.query(query), e => e.code === '42501')
      await assert.rejects(reader.query('insert into fee_events default values'), e => e.code === '42501')
      await assert.rejects(writer.query('update fee_events set amount_base_units=1'), e => e.code === '42501')
      // A slow INSERT must not let two callers credit the same previously unseen event.
      // Delay at the database boundary, then assert both public calls succeed and only one credits.
      await pool.query('delete from fee_events; delete from discovery_fee_events')
      await pool.query(`create function delay_fee_fixture() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(909090); return new; end $$;
        create trigger delay_fee_fixture before insert on fee_events for each row execute function delay_fee_fixture()`)
      const blocker = await pool.connect()
      const { createFeeAccrual } = await import('../src/fee-accrual.mjs')
      const accrue = createFeeAccrual({ pool: writer, connection, verification, config })
      const otherReplica = new pg.Pool({ connectionString: url.href, options: '-c role=repoing_fee_indexer' })
      const otherAccrual = createFeeAccrual({ pool: otherReplica, connection, verification, config })
      let first, second
      const waitForBlocked = async count => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const { rows: [row] } = await pool.query("select count(*)::int n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())")
          if (row.n >= count) return
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        throw Error('Concurrent fixture did not reach the database barrier')
      }
      try {
        await blocker.query('select pg_advisory_lock(909090)')
        first = accrue.recordTradeFees({ githubRepoId: '101', signatures: ['a', 'b'] })
        await waitForBlocked(1)
        second = otherAccrual.recordTradeFees({ githubRepoId: '101', signatures: ['a', 'b'] })
        await waitForBlocked(2)
        await blocker.query('select pg_advisory_unlock(909090)')
        const concurrent = await Promise.allSettled([first, second])
        assert.deepEqual(concurrent.map(r => r.status), ['fulfilled', 'fulfilled'])
        assert.equal(concurrent.reduce((sum, r) => sum + r.value.creditedBaseUnits, 0n), 3n)
        assert.deepEqual(await totals(), { creator: '3', partner: '3', events: 2, claims: 0 })
      } finally {
        await blocker.query('select pg_advisory_unlock(909090)'); blocker.release()
        await Promise.allSettled([first, second])
        await otherReplica.end()
        await pool.query('drop trigger delay_fee_fixture on fee_events; drop function delay_fee_fixture()')
      }
      await pool.query("update fee_events set amount_base_units=9 where signature='a'")
      await pool.query('delete from pool_fee_cursors')
      await assert.rejects(run(), /contradicts finalized/)
      assert.deepEqual((await pool.query('select last_signature from pool_fee_cursors')).rows, [{ last_signature: 'launch' }],
        'the cursor stops before the contradicting event and never passes it')
    } finally { await pool.end() }
  })
