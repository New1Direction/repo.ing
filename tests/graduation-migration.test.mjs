import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {readFile,mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('existing P3 database upgrades through P4/P5 once, preserving existing rows',async()=>{
  assert.equal(process.env.DATABASE_URL,'postgres://postgres:launchtest@127.0.0.1:55432/repoing_p5_upgrade_test')
  const journal=JSON.parse(await readFile('drizzle/meta/_journal.json','utf8'))
  for(let i=1;i<journal.entries.length;i++)assert.ok(journal.entries[i].when>journal.entries[i-1].when,`Migration ${i} must follow the previous timestamp`)
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL.replace(/repoing_p5_upgrade_test$/,'postgres')})
  const folder=await mkdtemp(join(tmpdir(),'repoing-p5-upgrade-'));let created=false,pool
  try{
    await admin.query('create database repoing_p5_upgrade_test');created=true
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL})
    await mkdir(join(folder,'meta'))
    const baseline={...journal,entries:journal.entries.slice(0,15)}
    await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(baseline))
    for(const entry of baseline.entries)await copyFile(`drizzle/${entry.tag}.sql`,join(folder,`${entry.tag}.sql`))
    await migrate(drizzle(pool),{migrationsFolder:folder})
    assert.equal((await pool.query('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0].n,15)
    await pool.query("insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values(998010,'local','upgrade','local/upgrade',1,0,false,now())")
    await migrate(drizzle(pool),{migrationsFolder:'drizzle'})
    await migrate(drizzle(pool),{migrationsFolder:'drizzle'})
    assert.equal((await pool.query('select count(*)::int n from drizzle.__drizzle_migrations')).rows[0].n,journal.entries.length)
    for(const table of ['builder_reinvest_intents','graduation_observations','graduation_events','graduation_alerts','damm_trade_events'])
      assert.equal((await pool.query('select to_regclass($1)::text as name',[table])).rows[0].name,table)
    assert.equal((await pool.query('select full_name from repositories where github_repo_id=998010')).rows[0].full_name,'local/upgrade')
  }finally{
    await pool?.end();if(created)await admin.query('drop database repoing_p5_upgrade_test');await admin.end();await rm(folder,{recursive:true,force:true})
  }
})
