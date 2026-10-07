import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { PublicKey } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { EARLY_ACCESS_HOOK_PROGRAM_ID } from '../src/early-access-hook.mjs'
import { GithubWalletLinkError, LINK_ERRORS, createGithubWalletLinks, githubUserForWallet, linkForGithubUser,
  linksForGithubUsers } from '../src/github-wallet-links.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// The route modules import next/server the way Next resolves it (tests/fixtures/jsx-hooks.mjs).
register(new URL('./fixtures/jsx-hooks.mjs', import.meta.url))

// Contributor early access, step 3, on real PostgreSQL. Migration 0059: the database is brought to 0058 and seeded with
// markets, then upgraded; existing rows read back identically with no early access; the stamp is both-or-none, GitHub-only,
// never a stock pair and immutable once the launch was sent; the link tables hold their rules. Then the link flow (challenge,
// signature, single-use nonce, one wallet per account, a wallet never moved between accounts, races) and its routes.
const DATABASE = 'repoing_early_access_links_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DATABASE}`
const HOOK = EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58()
const META_MINT = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'
const SEED = `
insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
  (1296269,'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,'2026-10-01T00:00:00Z'),
  (10270250,'facebook','react','facebook/react',null,null,240000,49000,false,'2026-10-01T00:00:00Z'),
  (94911145,'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,'2026-10-01T00:00:00Z'),
  (41881900,'microsoft','vscode','microsoft/vscode',null,null,180000,35000,false,'2026-10-01T00:00:00Z'),
  (7,'fixture','submitted','fixture/submitted',null,null,1,0,false,'2026-10-01T00:00:00Z'),
  (8,'fixture','ambiguous','fixture/ambiguous',null,null,1,0,false,'2026-10-01T00:00:00Z'),
  (9,'fixture','indexed','fixture/indexed',null,null,1,0,false,'2026-10-01T00:00:00Z');
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at) values
  (1296269,'confirmed','MintSol','PoolSol','Launcher','Creator','Hello','HELLO','LaunchSol','Hash',100,10,'finalized',now(),now()),
  (10270250,'failed',null,null,'Launcher','Creator','React','REACT',null,null,null,null,null,null,null),
  (7,'submitted','MintSub','PoolSub','Launcher','Creator','Sub','SUB','LaunchSub','Hash',100,null,null,null,null),
  (8,'ambiguous','MintAmb','PoolAmb','Launcher','Creator','Amb','AMB','LaunchAmb','Hash',100,null,null,null,null),
  (9,'prepared','MintIdx','PoolIdx','Launcher','Creator','Idx','IDX',null,'Hash',100,11,'finalized',now(),now());
insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,quote_asset_id,quote_mint,quote_registry_version)
  values (41881900,'reserved','Launcher','Creator','VSCode','VSCODE','msft-xstock','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX',1);`
const marketsCanonical = async pool => (await pool.query(`select md5(string_agg(row(github_repo_id,status,mint,pool,launcher_wallet,
  creator_wallet,token_name,token_symbol,launch_signature,indexed_at,quote_asset_id,quote_mint,quote_registry_version)::text, E'\\n' order by github_repo_id)) as sum
  from markets`)).rows[0].sum
async function refused(pool, sql, check, params = []) {
  await assert.rejects(pool.query(sql, params), error => {
    assert.ok(error.constraint === check || error.message.includes(check), `${error.message} (${sql.slice(0, 90)})`)
    return true
  })
}
const refusal = (key, status) => error => {
  assert.ok(error instanceof GithubWalletLinkError, error.stack)
  assert.equal(error.message, LINK_ERRORS[key]); assert.equal(error.status, status)
  return true
}
const signer = () => {
  const pair = generateKeyPairSync('ed25519')
  const address = new PublicKey(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58()
  return { address, sign: message => sign(null, Buffer.from(message, 'utf8'), pair.privateKey).toString('base64') }
}
const person = (id, login) => ({ githubUserId: String(id), githubLogin: login, type: 'User' })

test('migration 0059 and contributor wallet links on PostgreSQL', { timeout: 180_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  const at = journal.entries.findIndex(entry => entry.tag === '0059_early_access')
  assert.ok(at > 0, '0059 is in the journal')
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DATABASE}$`), 'postgres') })
  const folder = await mkdtemp(join(tmpdir(), 'repoing-0059-'))
  let created = false, pool
  try {
    await admin.query(`drop database if exists ${DATABASE}`)
    await admin.query(`create database ${DATABASE}`); created = true
    pool = new pg.Pool({ connectionString: URL_, max: 12 })
    await mkdir(join(folder, 'meta'))
    const baseline = { ...journal, entries: journal.entries.slice(0, at) }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(baseline))
    for (const entry of baseline.entries) await copyFile(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
    await migrate(drizzle(pool), { migrationsFolder: folder })
    await pool.query(SEED)
    const before = await marketsCanonical(pool)

    await t.test('upgrading keeps every market row with no early access, and re-applying 0059 and 0061 is a no-op', async () => {
      await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
      for (const file of ['0059_early_access', '0061_hook_rules']) {
        for (const statement of (await readFile(`drizzle/${file}.sql`, 'utf8')).split('--> statement-breakpoint')) await pool.query(statement)
      }
      assert.equal(await marketsCanonical(pool), before)
      const { rows: [row] } = await pool.query(`select count(*)::int as n from markets where early_access_end is not null or transfer_hook_program is not null
        or hook_rules is not null`)
      assert.equal(row.n, 0)
    })

    await t.test('the stamp is both-or-none, a real program key, GitHub-only and never a stock pair', async () => {
      // A stamped row also carries its hook rules (migration 0061): 1 is early access alone.
      const insert = (values, rules = 1) => `insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,early_access_end,
        transfer_hook_program,hook_rules) values ${values.replace(/\)$/, `,${rules})`)}`
      await pool.query(insert(`(94911145,'reserved','L','C','Docusaurus','DOCUSAURUS',now() + interval '1 hour','${HOOK}')`))
      await pool.query('delete from markets where github_repo_id = 94911145')
      await refused(pool, insert(`(94911145,'reserved','L','C','Docusaurus','DOCUSAURUS',now() + interval '1 hour',null)`), 'markets_early_access_check')
      await refused(pool, insert(`(94911145,'reserved','L','C','Docusaurus','DOCUSAURUS',null,'${HOOK}')`), 'markets_early_access_check')
      await refused(pool, insert(`(94911145,'reserved','L','C','Docusaurus','DOCUSAURUS',now(),'not a program')`), 'markets_early_access_check')
      await refused(pool, insert(`(94911145,'reserved','L','C','Docusaurus','DOCUSAURUS',now(),'11111111111111111111111111111111')`), 'markets_early_access_check')
      // A stock pair cannot also be early access: not on insert, and not added to an existing stock reservation.
      await refused(pool, `insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,quote_asset_id,quote_mint,
        quote_registry_version,early_access_end,transfer_hook_program) values (94911145,'reserved','L','C','D','D','meta-xstock','${META_MINT}',1,now(),'${HOOK}')`,
      'markets_early_access_sol_only')
      await refused(pool, `update markets set early_access_end = now(), transfer_hook_program = '${HOOK}' where github_repo_id = 41881900`, 'markets_early_access_sol_only')
      // A Hugging Face model market can never carry early access.
      const { rows: [model] } = await pool.query(`insert into hf_models(hf_id,repo_path,owner_handle,owner_kind) values (repeat('a',24),'org/model','org','org')
        returning market_ref::text as id`)
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at,source,hf_model_ref)
        values ($1,'org','model','org/model',0,0,false,now(),'huggingface',$1)`, [model.id])
      await refused(pool, insert(`(${model.id},'reserved','L','C','Model','MODEL',now(),'${HOOK}')`), 'markets_early_access_check')
      // Migration 0061: the rules are one of the three sets the launch form offers, and only with the window; a window without them
      // is early access alone (as stamped before 0061).
      const stamped = `(94911145,'reserved','L','C','Docusaurus','DOCUSAURUS',now() + interval '1 hour','${HOOK}')`
      for (const rules of [3, 7, 'null']) {
        await pool.query(insert(stamped, rules))
        await pool.query('delete from markets where github_repo_id = 94911145')
      }
      for (const rules of [0, 2, 4, 5, 6, 8, -1]) await refused(pool, insert(stamped, rules), 'markets_hook_rules_check')
      await refused(pool, `insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,hook_rules)
        values (94911145,'reserved','L','C','Docusaurus','DOCUSAURUS',1)`, 'markets_hook_rules_check')
    })

    await t.test('an unsent reservation may change or drop early access; a sent or indexed launch never can', async () => {
      const set = (id, end = `now() + interval '1 hour'`) => `update markets set early_access_end = ${end}, transfer_hook_program = '${HOOK}', hook_rules = 1
        where github_repo_id = ${id}`
      // failed → a new attempt with early access, a new window, then without, before anything was sent
      await pool.query(`update markets set status = 'reserved' where github_repo_id = 10270250`)
      await pool.query(set(10270250))
      await pool.query(`update markets set status = 'prepared' where github_repo_id = 10270250`)
      await pool.query(set(10270250, `now() + interval '6 hours'`))
      await pool.query(`update markets set hook_rules = 7 where github_repo_id = 10270250`)
      await pool.query(`update markets set early_access_end = null, transfer_hook_program = null, hook_rules = null where github_repo_id = 10270250`)
      await pool.query(`update markets set status = 'failed' where github_repo_id = 10270250`)
      await pool.query(set(10270250))
      for (const id of [1296269, 7, 8, 9]) await refused(pool, set(id), 'Market early access is immutable once its launch was sent')
      // Nor in the statement that sends the launch.
      await pool.query(`update markets set status = 'reserved', early_access_end = null, transfer_hook_program = null, hook_rules = null where github_repo_id = 10270250`)
      await refused(pool, `update markets set status = 'submitted', mint = 'MintReact', pool = 'PoolReact', launch_signature = 'LaunchReact',
        early_access_end = now() + interval '1 hour', transfer_hook_program = '${HOOK}', hook_rules = 1 where github_repo_id = 10270250`, 'immutable once its launch was sent')
      // Stamped, then sent: the stamp stays; other columns still update.
      await pool.query(set(10270250))
      const { rows: [{ end }] } = await pool.query('select early_access_end as end from markets where github_repo_id = 10270250')
      await pool.query(`update markets set status = 'submitted', mint = 'MintReact', pool = 'PoolReact', launch_signature = 'LaunchReact' where github_repo_id = 10270250`)
      await refused(pool, `update markets set early_access_end = null, transfer_hook_program = null, hook_rules = null where github_repo_id = 10270250`, 'immutable once its launch was sent')
      await refused(pool, `update markets set early_access_end = early_access_end + interval '1 minute' where github_repo_id = 10270250`, 'immutable once its launch was sent')
      await refused(pool, `update markets set transfer_hook_program = '${PublicKey.default.toBase58().replace(/^1/, '2')}' where github_repo_id = 10270250`, 'immutable')
      await refused(pool, `update markets set hook_rules = 3 where github_repo_id = 10270250`, 'immutable once its launch was sent')
      await refused(pool, `update markets set hook_rules = null where github_repo_id = 10270250`, 'immutable once its launch was sent')
      await pool.query(`update markets set status = 'confirmed' where github_repo_id = 10270250`)
      const { rows: [row] } = await pool.query('select status, early_access_end as end, transfer_hook_program as program from markets where github_repo_id = 10270250')
      assert.deepEqual(row, { status: 'confirmed', end, program: HOOK })
    })

    await t.test('contributor snapshots: one row per repository and account, at least one commit, GitHub repositories only', async () => {
      await pool.query(`insert into early_access_contributors(github_repo_id, github_user_id, github_login, contributions) values (1296269, 583231, 'octocat', 12)`)
      await refused(pool, `insert into early_access_contributors(github_repo_id, github_user_id, github_login, contributions) values (1296269, 583231, 'octocat', 1)`, 'early_access_contributors_pk')
      await refused(pool, `insert into early_access_contributors(github_repo_id, github_user_id, github_login, contributions) values (1296269, 2, 'a', 0)`, 'early_access_contributors_contributions_check')
      await refused(pool, `insert into early_access_contributors(github_repo_id, github_user_id, github_login, contributions) values (1296269, 0, 'a', 1)`, 'early_access_contributors_user_check')
      await refused(pool, `insert into early_access_contributors(github_repo_id, github_user_id, github_login, contributions) values (55555, 2, 'a', 1)`, 'early_access_contributors_github_repo_id_fkey')
      const { rows: [{ id }] } = await pool.query(`select github_repo_id::text as id from repositories where source = 'huggingface' limit 1`)
      await refused(pool, `insert into early_access_contributors(github_repo_id, github_user_id, github_login, contributions) values (${id}, 2, 'a', 1)`, 'early_access_contributors_github_only')
    })

    await t.test('link tables: one wallet per account, a wallet for one account, checked keys, logins, nonces and five-minute expiry', async () => {
      const a = signer().address, b = signer().address
      await pool.query(`insert into github_wallet_links(github_user_id, wallet, github_login) values (101, $1, 'alice')`, [a])
      await refused(pool, `insert into github_wallet_links(github_user_id, wallet, github_login) values (102, $1, 'bob')`, 'github_wallet_links_wallet_unique', [a])
      await refused(pool, `insert into github_wallet_links(github_user_id, wallet, github_login) values (101, $1, 'alice')`, 'github_wallet_links_pkey', [b])
      await refused(pool, `insert into github_wallet_links(github_user_id, wallet, github_login) values (103, 'not-a-wallet', 'carol')`, 'github_wallet_links_wallet_check')
      await refused(pool, `insert into github_wallet_links(github_user_id, wallet, github_login) values (103, $1, 'dependabot[bot]')`, 'github_wallet_links_login_check', [b])
      await refused(pool, `insert into github_wallet_links(github_user_id, wallet, github_login) values (0, $1, 'carol')`, 'github_wallet_links_user_check', [b])
      await pool.query('delete from github_wallet_links')
      const challenge = (nonce, expires = `now() + interval '5 minutes'`) => `insert into github_wallet_link_challenges(nonce, github_user_id, github_login, wallet, expires_at)
        values ('${nonce}', 101, 'alice', '${a}', ${expires})`
      await refused(pool, challenge('xyz'), 'github_wallet_link_challenges_nonce_check')
      await refused(pool, challenge('a'.repeat(48), `now() + interval '5 minutes 1 second'`), 'github_wallet_link_challenges_expiry_check')
      await refused(pool, challenge('a'.repeat(48), 'now()'), 'github_wallet_link_challenges_expiry_check')
    })

    const links = createGithubWalletLinks({ pool })
    const link = async (identity, wallet, nonce, signature) => links.link({ githubUserId: identity.githubUserId, wallet, nonce, signature })
    const challengeAndSign = async (identity, wallet) => {
      const challenge = await links.challenge({ identity, wallet: wallet.address })
      return { ...challenge, signature: wallet.sign(challenge.message) }
    }

    await t.test('challenge, signature, link: read back by account, by accounts and by wallet', async () => {
      const alice = person(583231, 'octocat'), wallet = signer()
      const challenge = await links.challenge({ identity: alice, wallet: wallet.address })
      assert.match(challenge.nonce, /^[0-9a-f]{48}$/)
      const { rows: [row] } = await pool.query(`select extract(epoch from expires_at - created_at)::int as seconds, consumed_at from github_wallet_link_challenges where nonce = $1`, [challenge.nonce])
      assert.deepEqual(row, { seconds: 300, consumed_at: null })
      assert.equal(challenge.message, ['repo.ing contributor wallet v1', 'GitHub user: octocat (583231)', `Wallet: ${wallet.address}`,
        `Nonce: ${challenge.nonce}`, `Expires: ${challenge.expiresAt}`].join('\n'))
      const linked = await link(alice, wallet.address, challenge.nonce, wallet.sign(challenge.message))
      assert.deepEqual([linked.githubUserId, linked.githubLogin, linked.wallet], ['583231', 'octocat', wallet.address])
      assert.deepEqual(await linkForGithubUser(pool, 583231n), linked)
      assert.deepEqual(await githubUserForWallet(pool, wallet.address), linked)
      assert.deepEqual(await linksForGithubUsers(pool, ['583231', 583231, '999', 583231n]), [linked])
      assert.deepEqual(await linksForGithubUsers(pool, []), [])
      assert.equal(await linkForGithubUser(pool, '999'), null)
      assert.ok((await pool.query('select consumed_at from github_wallet_link_challenges where nonce = $1', [challenge.nonce])).rows[0].consumed_at instanceof Date)
      // The same signature again: the nonce is spent.
      await assert.rejects(link(alice, wallet.address, challenge.nonce, wallet.sign(challenge.message)), refusal('used', 409))
    })

    await t.test('re-linking replaces the account\'s wallet and frees the old one; the same wallet keeps its link time', async () => {
      const alice = person(583231, 'octocat'), first = await linkForGithubUser(pool, 583231), next = signer()
      let signed = await challengeAndSign(alice, next)
      const replaced = await link(alice, next.address, signed.nonce, signed.signature)
      assert.equal(replaced.wallet, next.address)
      assert.ok(new Date(replaced.linkedAt) > new Date(first.linkedAt))
      assert.equal(await githubUserForWallet(pool, first.wallet), null, 'the old wallet is free')
      assert.equal((await pool.query('select count(*)::int as n from github_wallet_links where github_user_id = 583231')).rows[0].n, 1)
      signed = await challengeAndSign(person(583231, 'octocat-renamed'), next)
      const again = await link(alice, next.address, signed.nonce, signed.signature)
      assert.deepEqual([again.wallet, again.githubLogin, again.linkedAt], [next.address, 'octocat-renamed', replaced.linkedAt])
      assert.ok(new Date(again.updatedAt) > new Date(replaced.updatedAt))
    })

    await t.test('refused: another account\'s wallet, another account\'s or wallet\'s challenge, an expired challenge, a bot, a bad nonce', async () => {
      const alice = person(583231, 'octocat-renamed'), bob = person(777, 'bob'), bobWallet = signer()
      const aliceWallet = (await linkForGithubUser(pool, 583231)).wallet
      await assert.rejects(links.challenge({ identity: bob, wallet: aliceWallet }), refusal('taken', 409))
      const signed = await challengeAndSign(bob, bobWallet)
      await assert.rejects(link(alice, bobWallet.address, signed.nonce, signed.signature), refusal('mismatch', 403))
      await assert.rejects(link(bob, signer().address, signed.nonce, signed.signature), refusal('mismatch', 403))
      await assert.rejects(link(bob, bobWallet.address, signed.nonce, signer().sign(signed.message)), refusal('signature', 400))
      await pool.query(`update github_wallet_link_challenges set created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes 1 second' where nonce = $1`, [signed.nonce])
      await assert.rejects(link(bob, bobWallet.address, signed.nonce, signed.signature), refusal('expired', 410))
      await assert.rejects(link(bob, bobWallet.address, 'f'.repeat(48), signed.signature), refusal('expired', 410))
      await assert.rejects(link(bob, bobWallet.address, 'not-a-nonce', signed.signature), refusal('expired', 410))
      await assert.rejects(links.challenge({ identity: { ...bob, type: 'Bot' }, wallet: bobWallet.address }), refusal('bot', 403))
      await assert.rejects(links.challenge({ identity: { ...bob, githubLogin: 'bob[bot]' }, wallet: bobWallet.address }), refusal('bot', 403))
      await assert.rejects(links.challenge({ identity: bob, wallet: 'nope' }), refusal('wallet', 400))
      assert.equal(await linkForGithubUser(pool, 777), null, 'nothing was linked')
      // A wallet another account linked after this challenge was issued is refused at link time, and the nonce stays unused.
      const carol = person(888, 'carol'), shared = signer()
      const carolSigned = await challengeAndSign(carol, shared), bobSigned = await challengeAndSign(bob, shared)
      await link(carol, shared.address, carolSigned.nonce, carolSigned.signature)
      await assert.rejects(link(bob, shared.address, bobSigned.nonce, bobSigned.signature), refusal('taken', 409))
      assert.equal((await pool.query('select consumed_at from github_wallet_link_challenges where nonce = $1', [bobSigned.nonce])).rows[0].consumed_at, null)
      assert.equal((await githubUserForWallet(pool, shared.address)).githubUserId, '888', 'never moved to bob')
    })

    await t.test('races: one wallet, two accounts → one link; one nonce, two submissions → one link; two wallets, one account → one row', async () => {
      const dave = person(901, 'dave'), erin = person(902, 'erin'), wallet = signer()
      const daveSigned = await challengeAndSign(dave, wallet), erinSigned = await challengeAndSign(erin, wallet)
      const results = await Promise.allSettled([link(dave, wallet.address, daveSigned.nonce, daveSigned.signature), link(erin, wallet.address, erinSigned.nonce, erinSigned.signature)])
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, JSON.stringify(results.map(result => result.reason?.message)))
      refusal('taken', 409)(results.find(result => result.status === 'rejected').reason)
      assert.equal((await pool.query('select count(*)::int as n from github_wallet_links where wallet = $1', [wallet.address])).rows[0].n, 1)

      const frank = person(903, 'frank'), frankWallet = signer(), once = await challengeAndSign(frank, frankWallet)
      const twice = await Promise.allSettled([1, 2].map(() => link(frank, frankWallet.address, once.nonce, once.signature)))
      assert.equal(twice.filter(result => result.status === 'fulfilled').length, 1)
      refusal('used', 409)(twice.find(result => result.status === 'rejected').reason)

      const grace = person(904, 'grace'), [one, two] = [signer(), signer()]
      const [first, second] = [await challengeAndSign(grace, one), await challengeAndSign(grace, two)]
      const both = await Promise.all([link(grace, one.address, first.nonce, first.signature), link(grace, two.address, second.nonce, second.signature)])
      const { rows } = await pool.query('select wallet from github_wallet_links where github_user_id = 904')
      assert.equal(rows.length, 1)
      assert.ok(both.map(row => row.wallet).includes(rows[0].wallet))
    })

    await t.test('unlinking removes only the account\'s own link', async () => {
      assert.deepEqual(await links.unlink({ githubUserId: '888' }), { unlinked: true })
      assert.deepEqual(await links.unlink({ githubUserId: '888' }), { unlinked: false })
      assert.equal(await linkForGithubUser(pool, 888), null)
      assert.notEqual(await linkForGithubUser(pool, 583231), null)
    })

    await t.test('routes: dark without the flag; with it, same origin, a GitHub sign-in confirmed with GitHub, then challenge, link, read, unlink', async t2 => {
      const auth = await import('../app/lib/auth.mjs')
      const saved = { env: { ...process.env }, pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
      const KEYS = ['DATABASE_URL', 'APP_ORIGIN', 'EARLY_ACCESS_ENABLED', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET']
      t2.after(() => {
        for (const key of KEYS) { if (saved.env[key] === undefined) delete process.env[key]; else process.env[key] = saved.env[key] }
        globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch
      })
      Object.assign(process.env, { DATABASE_URL: URL_, APP_ORIGIN: 'https://repo.ing', GITHUB_APP_CLIENT_ID: 'Iv23-test', GITHUB_APP_CLIENT_SECRET: 'test-secret' })
      delete process.env.EARLY_ACCESS_ENABLED
      globalThis.__gitfunPool = pool
      let githubUser = { id: 4242, login: 'heidi', type: 'User' }
      const calls = []
      globalThis.fetch = async (input, init = {}) => {
        const target = String(input?.url ?? input)
        calls.push(target)
        if (target === 'https://github.com/login/oauth/access_token') {
          const body = JSON.parse(init.body)
          return body.code === 'good-code' ? Response.json({ token_type: 'bearer', access_token: 'ghu_heidi', expires_in: 28_800 }) : Response.json({ error: 'bad_verification_code' })
        }
        if (target === 'https://api.github.com/user') return init.headers?.Authorization === 'Bearer ghu_heidi' ? Response.json(githubUser) : new Response('{}', { status: 401 })
        throw new TypeError(`offline test: ${target}`)
      }
      const account = await import('../app/api/contributor-wallet/route.js')
      const { POST: challengeRoute } = await import('../app/api/contributor-wallet/challenge/route.js')
      const { POST: linkRoute } = await import('../app/api/contributor-wallet/link/route.js')
      const { GET: start } = await import('../app/api/github/start/route.js')
      const { GET: callback } = await import('../app/api/github/callback/route.js')
      const request = (path, { method = 'GET', jar = {}, body, origin = 'https://repo.ing' } = {}) => ({ url: `https://repo.ing${path}`, method,
        nextUrl: new URL(`https://repo.ing${path}`), headers: new Headers({ origin, 'sec-fetch-site': origin === 'https://repo.ing' ? 'same-origin' : 'cross-site' }),
        cookies: { get: name => jar[name] === undefined ? undefined : { value: jar[name] } }, json: async () => body })
      const send = async (handler, path, options) => {
        const response = await handler(request(path, options))
        assert.equal(response.headers.get('cache-control'), 'private, no-store', path)
        return { status: response.status, body: await response.json() }
      }
      const cookies = response => Object.fromEntries(response.headers.getSetCookie().map(line => {
        const pair = line.split('; ')[0]
        return [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]
      }))
      const wallet = signer()

      assert.equal((await send(account.GET, '/api/contributor-wallet')).status, 404, 'dark while EARLY_ACCESS_ENABLED is off')
      assert.equal((await send(challengeRoute, '/api/contributor-wallet/challenge', { method: 'POST', body: { wallet: wallet.address } })).status, 404)
      assert.equal(new URL((await start(request('/api/github/start?mode=contributor'))).headers.get('location')).pathname, '/explore')
      process.env.EARLY_ACCESS_ENABLED = 'true'

      // Sign in (contributor mode): identity only, back to the link page.
      let response = await start(request('/api/github/start?mode=contributor'))
      const authorize = new URL(response.headers.get('location'))
      assert.equal(`${authorize.origin}${authorize.pathname}`, 'https://github.com/login/oauth/authorize')
      const oauth = cookies(response).gitfun_oauth
      assert.equal(auth.unseal(oauth).mode, 'contributor')
      response = await callback(request(`/api/github/callback?code=bad-code&state=${authorize.searchParams.get('state')}`, { jar: { gitfun_oauth: oauth } }))
      assert.equal(new URL(response.headers.get('location')).pathname + new URL(response.headers.get('location')).search, '/contributors/link?error=verification-failed')
      // Switched off between start and callback: the sign-in does not finish and no session is set.
      process.env.EARLY_ACCESS_ENABLED = 'false'
      response = await callback(request(`/api/github/callback?code=good-code&state=${authorize.searchParams.get('state')}`, { jar: { gitfun_oauth: oauth } }))
      assert.equal(new URL(response.headers.get('location')).pathname, '/explore')
      assert.equal(cookies(response)[auth.githubSessionCookie], undefined)
      process.env.EARLY_ACCESS_ENABLED = 'true'
      response = await callback(request(`/api/github/callback?code=good-code&state=${authorize.searchParams.get('state')}`, { jar: { gitfun_oauth: oauth } }))
      assert.equal(new URL(response.headers.get('location')).pathname + new URL(response.headers.get('location')).search, '/contributors/link?verified=1')
      const session = cookies(response)[auth.githubSessionCookie]
      assert.deepEqual((({ scope, repoId, githubUserId, githubLogin, permission }) => ({ scope, repoId, githubUserId, githubLogin, permission }))(auth.readGithubSession(session)),
        { scope: 'builders', repoId: null, githubUserId: '4242', githubLogin: 'heidi', permission: 'identity' })
      const jar = { [auth.githubSessionCookie]: session }

      assert.deepEqual((await send(account.GET, '/api/contributor-wallet')).body, { signedIn: false, githubLogin: null, link: null })
      assert.deepEqual((await send(account.GET, '/api/contributor-wallet', { jar })).body, { signedIn: true, githubLogin: 'heidi', link: null })
      let result = await send(challengeRoute, '/api/contributor-wallet/challenge', { method: 'POST', body: { wallet: wallet.address } })
      assert.deepEqual([result.status, result.body.error], [401, LINK_ERRORS.signIn])
      result = await send(challengeRoute, '/api/contributor-wallet/challenge', { method: 'POST', jar, body: { wallet: wallet.address }, origin: 'https://evil.example' })
      assert.equal(result.status, 403)
      const before = calls.length
      result = await send(challengeRoute, '/api/contributor-wallet/challenge', { method: 'POST', jar, body: { wallet: wallet.address } })
      assert.equal(result.status, 200, JSON.stringify(result.body))
      assert.deepEqual(calls.slice(before), ['https://api.github.com/user'], 'the account is read from GitHub again')
      assert.match(result.body.message, /^repo\.ing contributor wallet v1\nGitHub user: heidi \(4242\)\n/)
      const challenge = result.body
      result = await send(linkRoute, '/api/contributor-wallet/link', { method: 'POST', jar, body: { wallet: wallet.address, nonce: challenge.nonce, signature: signer().sign(challenge.message) } })
      assert.deepEqual([result.status, result.body.error], [400, LINK_ERRORS.signature])
      result = await send(linkRoute, '/api/contributor-wallet/link', { method: 'POST', jar, body: { wallet: wallet.address, nonce: challenge.nonce, signature: wallet.sign(challenge.message) } })
      assert.equal(result.status, 200, JSON.stringify(result.body))
      assert.deepEqual([result.body.link.githubUserId, result.body.link.githubLogin, result.body.link.wallet], ['4242', 'heidi', wallet.address])
      assert.equal((await send(account.GET, '/api/contributor-wallet', { jar })).body.link.wallet, wallet.address)
      result = await send(linkRoute, '/api/contributor-wallet/link', { method: 'POST', jar, body: { wallet: wallet.address, nonce: challenge.nonce, signature: wallet.sign(challenge.message) } })
      assert.deepEqual([result.status, result.body.error], [409, LINK_ERRORS.used])

      // GitHub now answers for another account (or a bot) with this token: no challenge.
      githubUser = { id: 4243, login: 'mallory', type: 'User' }
      result = await send(challengeRoute, '/api/contributor-wallet/challenge', { method: 'POST', jar, body: { wallet: signer().address } })
      assert.deepEqual([result.status, result.body.error], [401, LINK_ERRORS.account])
      githubUser = { id: 4242, login: 'heidi', type: 'Bot' }
      result = await send(challengeRoute, '/api/contributor-wallet/challenge', { method: 'POST', jar, body: { wallet: signer().address } })
      assert.deepEqual([result.status, result.body.error], [403, LINK_ERRORS.bot])

      result = await send(account.DELETE, '/api/contributor-wallet', { method: 'DELETE', jar, origin: 'https://evil.example' })
      assert.equal(result.status, 403)
      result = await send(account.DELETE, '/api/contributor-wallet', { method: 'DELETE', jar })
      assert.deepEqual([result.status, result.body], [200, { unlinked: true }])
      assert.equal((await send(account.GET, '/api/contributor-wallet', { jar })).body.link, null)
    })
  } finally {
    await pool?.end()
    if (created) await dropTestDatabase(admin, DATABASE)
    await admin.end()
    await rm(folder, { recursive: true, force: true })
  }
})
