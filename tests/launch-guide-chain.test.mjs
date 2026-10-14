import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { buildLaunchFeeConfigTransaction } from '../src/launch-fee-config.mjs'
import { FIXED_SUPPLY_BASE_UNITS, launchBuyMinFee, launchBuyQuote } from '../src/launch-buy.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchSchedules, SCHEDULE_CODES } from '../src/launch-schedules.mjs'
import { createLaunchGuide, createPreflightService, launchTerms } from '../src/launch-guide.mjs'
import { LAUNCH_SETUP_ESTIMATE_LAMPORTS } from '../src/launch-preflight.mjs'

// The guided launch against a local validator and a disposable database: the launch terms the preflight reads from a real launch-fee
// config (fee window and the exact lamports of each initial-buy option), the launching wallet's balance from the chain, the plan
// published as a scheduled launch with exactly that buy, and the production coordinator accepting that buy in the window and
// refusing one lamport more or another wallet. The tokens bought stay within the announced share of supply.
const rpc = process.env.SOLANA_RPC_URL
assert.match(rpc ?? '', /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Disposable local validator required')
const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid')
assert.equal(database.hostname, '127.0.0.1', 'Disposable local database required')
assert.equal(decodeURIComponent(database.pathname.slice(1)), 'repoing_launch_guide_chain_test', 'Disposable launch guide chain database required')

const connection = new Connection(rpc, 'confirmed')
const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
async function fund(key, sol) {
  const signature = await connection.requestAirdrop(key, sol * 1e9)
  await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
}
const tokensFor = (fixed, lamports) => BigInt(dbc.pool.getQuoteFromInputAmount({ config: fixed, swapBaseForQuote: false, amountIn: new BN(String(lamports)),
  slippageBps: 0, hasReferral: false, eligibleForFirstSwapWithMinFee: launchBuyMinFee(fixed) }).outputAmount.toString())

test('guided launch on chain: real launch terms, the planned buy published and accepted exactly in the scheduled window', { timeout: 600_000 }, async t => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  t.after(() => pool.end())
  await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
  await pool.query('truncate launch_guide_events, launch_guide_drafts, launch_schedules, repositories restart identity cascade')
  const partner = Keypair.generate(), creator = Keypair.generate(), launcher = Keypair.generate(), stranger = Keypair.generate(), empty = Keypair.generate()
  for (const [signer, sol] of [[partner, 5], [creator, 5], [launcher, 10], [stranger, 5]]) await fund(signer.publicKey, sol)
  const configKey = Keypair.generate()
  const built = await buildLaunchFeeConfigTransaction({ connection, config: configKey.publicKey, partner: partner.publicKey, leftoverReceiver: creator.publicKey })
  await sendAndConfirmTransaction(connection, built.tx, [partner, configKey], { commitment: 'finalized', preflightCommitment: 'confirmed' })
  const config = configKey.publicKey.toBase58()
  const fixed = await dbc.state.getPoolConfig(configKey.publicKey)

  let terms
  await t.test('launch terms: the launch fee window and, per option, the largest buy within that share of supply', async () => {
    terms = launchTerms({ config, fixed, client: dbc, allocation: false })
    assert.equal(terms.feeKnown, true)
    assert.ok(terms.launchFee, 'the launch-fee config has a decaying fee')
    assert.equal(terms.launchFee.endPercent, '1.75%')
    for (const bps of [100, 200, 300]) {
      const lamports = BigInt(terms.presets[bps])
      const target = FIXED_SUPPLY_BASE_UNITS * BigInt(bps) / 10_000n
      assert.ok(tokensFor(fixed, lamports) <= target, `${bps}: within the share`)
      assert.ok(tokensFor(fixed, lamports + 1n) > target, `${bps}: one lamport more exceeds it, so this is the largest`)
    }
    assert.ok(BigInt(terms.presets[100]) < BigInt(terms.presets[200]) && BigInt(terms.presets[200]) < BigInt(terms.presets[300]))
    assert.ok(BigInt(terms.presets[300]) <= 1_000_000_000n, 'the 3% option fits under the 1 SOL a schedule may announce')
    assert.throws(() => launchBuyQuote(dbc, fixed, (BigInt(terms.presets[300]) + 1n).toString()), /exceeds 3%/)
  })

  const REPO = 9_930_001
  const repoRow = id => ({ id, name: `guide-${id}`, full_name: `local/guide-${id}`, owner: { login: 'local' }, private: false, archived: false, stargazers_count: 240,
    forks_count: 4, created_at: '2024-02-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })
  const github = async url => {
    const path = new URL(url).pathname
    const body = /\/commits$/.test(path) ? [{ author: { id: 1 } }, { author: { id: 2 } }] : repoRow(REPO)
    return { status: 200, ok: true, json: async () => body, headers: new Headers() }
  }
  const service = createPreflightService({ pool, fetchImpl: github, lineage: async () => ({ forkOf: null }),
    readTerms: async () => terms, readBalance: async (wallet, { meter }) => { meter.rpc += 1; return connection.getBalance(new PublicKey(wallet), 'confirmed') } })
  const plan = { scheduledAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), windowMinutes: 60, launcherWallet: launcher.publicKey.toBase58(), supplyBps: 300, acknowledged: true }
  const maintainer = { status: 'admin', githubLogin: 'local-admin', checkedAt: new Date().toISOString() }

  await t.test('preflight: the balance read from the chain, the exact planned buy, and a shortfall for an empty wallet', async () => {
    const { preflight, profile } = await service.run({ repoId: String(REPO) }, { plan, maintainer })
    assert.equal(preflight.verdict, 'ready', JSON.stringify(preflight.missing))
    assert.equal(preflight.plannedBuyLamports, terms.presets[300])
    assert.equal(profile.rpcRequests, 1)
    const balance = preflight.requirements.find(item => item.id === 'launcher_balance')
    assert.equal(balance.status, 'met')
    assert.match(balance.detail, /^Holds 10 SOL/)
    const poor = await service.run({ repoId: String(REPO) }, { plan: { ...plan, launcherWallet: empty.publicKey.toBase58() }, maintainer })
    const short = poor.preflight.requirements.find(item => item.id === 'launcher_balance')
    assert.equal(short.status, 'warn')
    const need = Number(BigInt(terms.presets[300]) + LAUNCH_SETUP_ESTIMATE_LAMPORTS) / 1e9
    assert.match(short.remediation.text, new RegExp(`^Add about ${String(Math.ceil(need * 1e4) / 1e4).replace('.', '\\.')} SOL`))
    assert.equal(poor.preflight.ready.schedule, true, 'funding is needed at launch, not to publish')
  })

  let schedule
  await t.test('publish: the guide writes the scheduled launch with the planned buy, checking admin access again', async () => {
    const persist = async repoId => pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
      values($1,'local',$2,$3,240,4,false,now()) on conflict do nothing`, [String(repoId), `guide-${repoId}`, `local/guide-${repoId}`])
    const session = { githubUserId: '5', githubLogin: 'local-admin' }
    let scheduleChecks = 0
    const guide = createLaunchGuide({ pool, preflight: service, persistRepository: persist,
      verifyAdmin: async () => ({ admin: true, githubLogin: 'local-admin', permission: 'admin' }),
      schedules: createLaunchSchedules({ pool, verifyAdmin: async () => { scheduleChecks += 1; return { githubUserId: 5n, githubLogin: 'local-admin' } } }) })
    const { draft } = await guide.select(session, String(REPO))
    await guide.check(session, draft.id, { plan })
    const published = await guide.publish(session, draft.id)
    schedule = published.schedule
    assert.equal(scheduleChecks, 1)
    assert.equal(schedule.maxInitialBuyLamports, terms.presets[300])
    assert.equal(schedule.launcherWallet, launcher.publicKey.toBase58())
    assert.equal(schedule.state, 'upcoming')
  })

  await t.test('the window: another wallet and one lamport more are refused; exactly the planned buy launches within 3% of supply', async () => {
    const coordinator = createLaunchCoordinator({ pool, fetchImpl: async () => ({ ok: true, status: 200, json: async () => repoRow(REPO) }),
      launcher: createMeteoraLauncher({ connection, config, creator }) })
    const launch = (signer, initialBuyLamports) => coordinator.launch({ repositoryUrl: `https://github.com/local/guide-${REPO}`, tokenName: 'Guide', tokenSymbol: 'GUIDE',
      launcherWallet: signer.publicKey.toBase58(), initialBuyLamports, signTransaction: async tx => { tx.partialSign(signer); return tx } })
    await assert.rejects(launch(launcher, terms.presets[300]), error => error.code === SCHEDULE_CODES.BEFORE, 'nobody launches before the announced time')
    // Move the announcement back in time so its window is open now (the table still requires an hour of notice).
    await pool.query(`update launch_schedules set created_at = now() - interval '3 hours', scheduled_at = now() - interval '5 minutes' where id = $1`, [schedule.id])
    await assert.rejects(launch(stranger, '0'), error => error.code === SCHEDULE_CODES.LAUNCHER)
    await assert.rejects(launch(launcher, (BigInt(terms.presets[300]) + 1n).toString()), error => error.code === SCHEDULE_CODES.BUY)
    const market = await launch(launcher, terms.presets[300])
    assert.equal(market.status, 'confirmed')
    const bought = BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(market.mint), launcher.publicKey), 'confirmed')).value.amount)
    assert.ok(bought <= FIXED_SUPPLY_BASE_UNITS * 3n / 100n, 'at most 3% of supply')
    assert.ok(bought >= FIXED_SUPPLY_BASE_UNITS * 299n / 10_000n, 'the largest buy within 3%: at least 2.99%')
    assert.equal(bought, tokensFor(fixed, terms.presets[300]), 'exactly what the preflight quoted')
    // The preflight now sees the market and points to it.
    const after = await service.run({ repoId: String(REPO) }, { plan: null, maintainer: null })
    const noMarket = after.preflight.requirements.find(item => item.id === 'no_market')
    assert.equal(noMarket.status, 'blocked')
    assert.equal(noMarket.remediation.href, `/token/${market.mint}`)
  })
})
