import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readGraduationRace } from '../app/lib/graduation-race.mjs'
import { graduationColumns } from './fixtures/graduation-rows.mjs'

// Real PostgreSQL with every committed migration: the one joined read behind the home/explore graduation race and the
// $REPOING "Repo markets to watch" list. Only public markets with a VERIFIED, fresh observation race.
const url = process.env.GRADUATION_RACE_TEST_DATABASE_URL
test('real PostgreSQL: graduation race read', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_graduation_race_test', 'Disposable graduation race test database required')
  const pool = new pg.Pool({ connectionString: url }), saved = process.env.PROMOTION_EXCLUDED_REPO_IDS
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query('truncate graduation_observations, graduation_events, markets, repositories restart identity cascade')
    const market = async (id, observation, { status = 'confirmed', finality = 'finalized', indexed = true } = {}) => {
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
        values($1,'octo',$2,$3,1,0,false,now())`, [id, `repo-${id}`, `octo/repo-${id}`])
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
        launch_slot,launch_finality,indexed_at,last_verified_at) values($1,$2,$3,$4,'w','w',$5,$6,$7,1,$8,$9,now())`,
      [id, status, `Mint${id}`, `Pool${id}`, `Repo ${id}`, `R${id}`, `Sig${id}`, finality, indexed ? new Date() : null])
      if (!observation) return
      const columns = graduationColumns({ mint: `Mint${id}`, thresholdSol: 85n, ...observation })
      await pool.query(`insert into graduation_observations(github_repo_id,checked_at,status,observation,error_code) values($1,now(),$2,$3,$4)`,
        [id, columns.status, columns.observation, columns.error_code])
      if (columns.migration_evidence_hash) await pool.query(`insert into graduation_events(github_repo_id,signature,pool,slot,evidence_hash,evidence,reconciliation)
        values($1,$2,$3,1,$4,'{}','{}')`, [id, `sig-Mint${id}`, `pool-Mint${id}`, columns.migration_evidence_hash])
    }
    await market(1, { reserveLamports: 17_510_000_000n }) // 20.6%
    await market(2, { reserveSol: 60n }) // 70.6%: about to graduate
    await market(3, { reserveLamports: 800_000_000n }) // 0.94%: below the floor
    await market(4, { reserveSol: 85n, graduated: true }) // graduated: done racing
    await market(5, { reserveSol: 40n, rowStatus: 'REVIEW' })
    await market(6, { reserveSol: 40n, age: 600_000 }) // stale
    await market(7, null) // never observed
    await market(8, { reserveSol: 50n }, { status: 'submitted', finality: 'confirmed', indexed: false }) // not public
    await market(9, { reserveSol: 1n }) // 1.18%

    const race = await readGraduationRace(pool, { excluded: new Set() })
    assert.deepEqual(race.map(m => [m.repoId, m.mint, m.fullName, m.symbol, m.tokenName, m.aboutToGraduate]), [
      ['2', 'Mint2', 'octo/repo-2', 'R2', 'Repo 2', true], ['1', 'Mint1', 'octo/repo-1', 'R1', 'Repo 1', false], ['9', 'Mint9', 'octo/repo-9', 'R9', 'Repo 9', false]])
    assert.deepEqual([race[1].progressPercent, race[1].remainingLamports, race[1].thresholdLamports], [20.6, '67490000000', '85000000000'])

    // The do-not-promote list: explicit, and by default from PROMOTION_EXCLUDED_REPO_IDS.
    assert.deepEqual((await readGraduationRace(pool, { excluded: new Set(['2']) })).map(m => m.repoId), ['1', '9'])
    process.env.PROMOTION_EXCLUDED_REPO_IDS = '9, 1'
    assert.deepEqual((await readGraduationRace(pool)).map(m => m.repoId), ['2'])
  } finally { await pool.end(); if (saved === undefined) delete process.env.PROMOTION_EXCLUDED_REPO_IDS; else process.env.PROMOTION_EXCLUDED_REPO_IDS = saved }
})
