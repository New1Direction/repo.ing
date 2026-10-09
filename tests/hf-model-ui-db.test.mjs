import test from 'node:test'
import assert from 'node:assert/strict'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Keypair } from '@solana/web3.js'
import { appModule, h, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'
import { HF_DISCLAIMER, HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'

// Real PostgreSQL with every committed migration: one GitHub market and one Hugging Face model market (registry row,
// repositories.source = 'huggingface'). The token page's data path, the lists, /stats, the logo route, token metadata and
// the sitemap read both with the right shapes, and the model surfaces follow HF_MARKETS_ENABLED.
const url = process.env.HF_MODEL_UI_TEST_DATABASE_URL
const SOL = 1_000_000_000n
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const GITHUB_ID = '1384142609', GPT2_HF_ID = '621ffdc036468d709f17434d'
const AVATAR = 'https://cdn-avatars.huggingface.co/v1/production/uploads/5dd96eb166059660ed1ee413/9NY4jfufqo1uyv8oNXQju.png'
const BASE_MODEL = { hfId: '0123456789abcdef01234567', path: 'openai-community/gpt2-base', relation: 'finetune' }

test('real PostgreSQL: a GitHub market and a model market through the token page, lists, /stats, logos, metadata and sitemap', { skip: !url, timeout: 120_000 }, async t => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_hf_model_ui_test', 'Disposable HF model UI test database required')
  process.env.DATABASE_URL = url
  process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'
  process.env.APP_ORIGIN = 'https://repo.ing'
  const before = process.env.HF_MARKETS_ENABLED
  const net = offlineFetch()
  const { database, listMarkets, marketByMint } = await import('../app/lib/server.mjs')
  const pool = database()
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query(`truncate trade_events, fee_events, repo_claims, graduation_events, graduation_observations, repo_verifications,
      repo_beneficiaries, markets, repositories, hf_models restart identity cascade`)
    const githubMint = Keypair.generate().publicKey.toBase58(), modelMint = Keypair.generate().publicKey.toBase58()
    const now = Date.now(), hourAgo = new Date(now - 3_600_000)
    // base_models as the launch stores it (src/hf-launch.mjs baseModelList): [{ hfId, path, relation }].
    const { rows: [{ ref: MODEL_ID }] } = await pool.query(`insert into hf_models(hf_id,repo_path,owner_handle,owner_kind,gated,base_models)
      values ($1,'openai-community/gpt2','openai-community','org',true,$2) returning market_ref::text as ref`, [GPT2_HF_ID, JSON.stringify([BASE_MODEL])])
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at,github_created_at) values
      ($1,'New1Direction','Waternot','New1Direction/Waternot','Water','https://avatars.githubusercontent.com/u/1',1200,31,false,now(),'2025-01-01T00:00:00Z')`, [GITHUB_ID])
    // As the launch writes it (src/hf-launch.mjs): stars and forks stay 0, so Hugging Face metrics never feed promotion.
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at,source,hf_model_ref)
      values ($1,'openai-community','gpt2','openai-community/gpt2','Text generation · License: mit',$2,0,0,false,now(),'huggingface',$1)`, [MODEL_ID, AVATAR])
    for (const [id, mint, symbol] of [[GITHUB_ID, githubMint, 'WTR'], [MODEL_ID, modelMint, 'GPT2']]) {
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
        launch_slot,launch_finality,indexed_at,last_verified_at,discovery_version) values ($1,'confirmed',$2,$3,'Launcher','Creator',$4,$5,$6,1,'finalized',$7,now(),2)`,
      [id, mint, `Pool${symbol}`, symbol.toLowerCase(), symbol, `Launch${symbol}`, hourAgo])
    }
    // Volume: 3 SOL (GitHub) and 2 SOL (model). Fees: 0.5 SOL and 0.25 SOL. One settled GitHub payout of 0.1 SOL.
    const trade = (poolName, n, lamports) => pool.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price)
      values ($1,$2,0,$3,$4,'buy',$5,'1000','18446744073709551616')`, [poolName, `trade-${poolName}-${n}`, 100 + n, new Date(now - 60_000 * n), lamports])
    await trade('PoolWTR', 1, String(2n * SOL)); await trade('PoolWTR', 2, String(SOL)); await trade('PoolGPT2', 3, String(2n * SOL))
    const fee = (id, mint, poolName, n, lamports) => pool.query(`insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot,created_at)
      values ($1,$2,$3,$4,0,$5,$6,'dbc_creator_quote',$7,$8)`, [id, mint, poolName, `fee-${n}`, lamports, SOL_MINT, 200 + n, new Date(now - 60_000 * n)])
    await fee(GITHUB_ID, githubMint, 'PoolWTR', 1, String(SOL / 2n)); await fee(MODEL_ID, modelMint, 'PoolGPT2', 2, String(SOL / 4n))
    await pool.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at)
      values ($1,'Builder',$2,$3,'claim-1','settled',$4)`, [GITHUB_ID, String(SOL / 10n), SOL_MINT, new Date(now - 30_000)])

    const { isModelMarket, modelView } = await import('../app/lib/hf-model-display.mjs')
    const { readModelRegistry, shownMarkets } = await import('../app/lib/hf-markets.mjs')

    await t.test('token page data path: both markets read with their source; the model has its registry row', async () => {
      const { market: github } = await marketByMint(githubMint), { market: model } = await marketByMint(modelMint)
      assert.equal(github.source, 'github'); assert.equal(isModelMarket(github), false)
      assert.equal(model.source, 'huggingface'); assert.equal(isModelMarket(model), true)
      assert.deepEqual([model.repoId, model.fullName, model.stars, model.avatarUrl, model.earned], [MODEL_ID, 'openai-community/gpt2', 0, AVATAR, String(SOL / 4n)])
      assert.equal(model.volume24hLamports, String(2n * SOL))
      const registry = await readModelRegistry(pool, MODEL_ID)
      assert.deepEqual({ ...registry, pathConfirmedAt: typeof registry.pathConfirmedAt }, { marketRef: MODEL_ID, hfId: GPT2_HF_ID, path: 'openai-community/gpt2',
        ownerHandle: 'openai-community', ownerKind: 'org', ownerSubject: null, gated: true, baseModels: [BASE_MODEL], pathConfirmedAt: 'object' })
      assert.equal(await readModelRegistry(pool, GITHUB_ID), null, 'a GitHub id never reads the registry')
      const view = modelView(model, registry)
      assert.deepEqual([view.owner, view.ownerKind, view.likes, view.gated.label, view.base], ['openai-community', 'org', null, 'Gated',
        { relation: 'finetune', paths: ['openai-community/gpt2-base'] }], 'repositories.stars (0) is never read as likes')
    })

    await t.test('token page: the model renders its own page from the database; off, it is not found; a GitHub market keeps its page', async () => {
      const page = await appModule('app/(site)/token/[mint]/page.jsx')
      const { ModelTokenPage } = await appModule('app/components/hf/model-token-page.jsx')
      const modelParams = { params: Promise.resolve({ mint: modelMint }), searchParams: Promise.resolve({}) }
      delete process.env.HF_MARKETS_ENABLED
      await assert.rejects(resolveServer(await page.default(modelParams)), error => String(error.digest).startsWith('NEXT_HTTP_ERROR_FALLBACK;404'))
      assert.deepEqual(await page.generateMetadata(modelParams), { title: 'Market not found — repo.ing' })
      process.env.HF_MARKETS_ENABLED = 'true'
      const element = await page.default(modelParams)
      assert.equal(element.type, ModelTokenPage)
      const markup = html(await resolveServer(element), { wallet: true }).replaceAll('&#x27;', "'")
      assert.ok(markup.includes(HF_DISCLAIMER))
      assert.match(markup, /<dt>Author<\/dt><dd>openai-community<small>Organization<\/small><\/dd>/)
      assert.match(markup, /<span class="badge model-gated"/)
      assert.match(markup, /<a class="badge model-derivative" href="https:\/\/huggingface\.co\/openai-community\/gpt2-base"/)
      assert.ok((await page.generateMetadata(modelParams)).description.startsWith(HF_DISCLAIMER_SHORT))
      // The GitHub market keeps its own metadata (its page body needs a live request scope, rendered in the headless QA).
      const githubMetadata = await page.generateMetadata({ params: Promise.resolve({ mint: githubMint }) })
      assert.equal(githubMetadata.title, '$WTR · New1Direction/Waternot — repo.ing')
      assert.equal(githubMetadata.description, 'Water')
    })

    await t.test('lists: both rows carry their source; without the flag the model drops out; with it, it renders as a model row with display-only likes', async () => {
      const { MarketTable } = await appModule('app/components/ui.jsx')
      const { homeMarketTabs } = await import('../app/lib/market-order.mjs')
      const { selectModelStrip } = await import('../app/lib/hf-model-display.mjs')
      const { createModelCards, withModelFacts } = await import('../app/lib/hf-markets.mjs')
      const { markets, unavailable } = await listMarkets()
      assert.equal(unavailable, undefined)
      assert.deepEqual(Object.fromEntries(markets.map(market => [market.repoId, market.source])), { [GITHUB_ID]: 'github', [MODEL_ID]: 'huggingface' })
      assert.deepEqual(shownMarkets(markets, {}).map(market => market.repoId), [GITHUB_ID])
      assert.deepEqual(shownMarkets(markets, { HF_MARKETS_ENABLED: 'true' }).map(market => market.repoId).sort(), [GITHUB_ID, MODEL_ID].sort())
      // Likes come only from a live card for the registry's own _id: refreshed after a first view, then attached to the row.
      // (The token page above already asked the offline Hub once; that failure is remembered for a minute, so start clean.)
      const cards = globalThis.__repoingHfModelCards
      globalThis.__repoingHfModelFacts.clear()
      globalThis.__repoingHfModelCards = createModelCards({ read: async path => ({ hfId: GPT2_HF_ID, path, likes: 4194, downloads30d: 15740994 }) })
      try {
        let refresh = null
        assert.deepEqual(withModelFacts(markets, { schedule: fn => { refresh = fn } }), markets, 'nothing known yet')
        await refresh()
        const listed = withModelFacts(markets, { schedule: () => {} })
        assert.deepEqual(selectModelStrip(listed), [{ repoId: MODEL_ID, mint: modelMint, fullName: 'openai-community/gpt2', symbol: 'GPT2', volume24hLamports: String(2n * SOL), likes: 4194 }])
        const table = html(h(MarketTable, { markets: homeMarketTabs(listed).Trending }))
        assert.match(table, /<div class="market-row is-model">/)
        assert.match(table, /href="https:\/\/huggingface\.co\/openai-community\/gpt2"[^>]*title="4,194 likes on Hugging Face/)
        assert.match(table, /<small>Community launch · Text generation · License: mit<\/small>/)
        assert.ok(table.replaceAll('&#x27;', "'").includes(HF_DISCLAIMER))
      } finally { globalThis.__repoingHfModelCards = cards; globalThis.__repoingHfModelFacts.clear() }
      // /waiting is about repositories: a settled payout on the model market is not among "Recently claimed".
      await pool.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at)
        values ($1,'Owner',$2,$3,'claim-model','settled',now())`, [MODEL_ID, String(SOL / 20n), SOL_MINT])
      const { waitingBoard } = await import('../app/lib/waiting-board.mjs')
      const board = await waitingBoard()
      assert.equal(board.unavailable, undefined)
      assert.deepEqual(board.claimed.map(payout => payout.mint), [githubMint])
    })

    await t.test('/stats: per-source volume, fees, payouts, trades and markets come from the same snapshot and add up to the totals', async () => {
      const { readProtocolAnalytics } = await import('../src/protocol-analytics.mjs')
      const stats = await readProtocolAnalytics(pool, { now: new Date(now + 1000) })
      assert.deepEqual(Object.keys(stats.totals).sort(), ['earned', 'graduated', 'markets', 'paid', 'trades', 'volume'])
      assert.deepEqual(Object.keys(stats.builders).sort(), ['earned', 'paid'])
      // The model's 0.05 SOL payout was settled by the lists check above.
      assert.deepEqual(stats.sources, {
        github: { volume: String(3n * SOL), earned: String(SOL / 2n), paid: String(SOL / 10n), trades: 2, markets: 1 },
        huggingface: { volume: String(2n * SOL), earned: String(SOL / 4n), paid: String(SOL / 20n), trades: 1, markets: 1 } })
      for (const metric of ['volume', 'earned', 'paid']) {
        assert.equal(BigInt(stats.sources.github[metric]) + BigInt(stats.sources.huggingface[metric]), BigInt(stats.totals[metric]), metric)
      }
      assert.equal(stats.sources.github.trades + stats.sources.huggingface.trades, stats.totals.trades)
      assert.equal(stats.sources.github.markets + stats.sources.huggingface.markets, stats.totals.markets)
      const day = await readProtocolAnalytics(pool, { now: new Date(now + 1000), range: '24h' })
      assert.equal(BigInt(day.sources.github.volume) + BigInt(day.sources.huggingface.volume), BigInt(day.totals.volume))
    })

    await t.test('logo route, token metadata and sitemap read the model from the database', async () => {
      const { GET: logo } = await appModule('app/api/repo-logo/[repo]/route.js')
      const { GET: metadata } = await appModule('app/api/token-metadata/[mint]/route.js')
      const sitemap = (await appModule('app/sitemap.js')).default
      const response = await logo(new Request(`https://repo.ing/api/repo-logo/${MODEL_ID}?v=3`), { params: Promise.resolve({ repo: MODEL_ID }) })
      assert.equal(response.status, 302)
      assert.equal(response.headers.get('location'), AVATAR)
      // The token's Metaplex URI is fixed when the launch is prepared and must keep describing the model whatever the flag
      // later says: the same model description while prepared and once confirmed, flag on or off, and no GitHub link.
      const readMetadata = async () => (await metadata(new Request(`https://repo.ing/api/token-metadata/${modelMint}`), { params: Promise.resolve({ mint: modelMint }) })).json()
      const page = `https://repo.ing/token/${modelMint}`, links = { website: page }
      const expected = { name: 'gpt2', symbol: 'GPT2', description: '$GPT2 is the repo.ing market for the Hugging Face model huggingface.co/openai-community/gpt2. ' +
        `Trading fees pay the model's owner in SOL. ${HF_DISCLAIMER}`, image: `https://repo.ing/api/repo-logo/${MODEL_ID}?v=4`, external_url: page, ...links, extensions: links }
      assert.deepEqual(await readMetadata(), expected)
      await pool.query(`update markets set status = 'prepared' where mint = $1`, [modelMint])
      try {
        assert.deepEqual(await readMetadata(), expected, 'prepared')
        delete process.env.HF_MARKETS_ENABLED
        assert.deepEqual(await readMetadata(), expected, 'flag off')
      } finally {
        process.env.HF_MARKETS_ENABLED = 'true'
        await pool.query(`update markets set status = 'confirmed' where mint = $1`, [modelMint])
      }
      const urls = async () => (await sitemap()).map(entry => entry.url).filter(entry => entry.includes('/token/'))
      assert.deepEqual((await urls()).sort(), [`https://repo.ing/token/${githubMint}`, `https://repo.ing/token/${modelMint}`].sort())
      delete process.env.HF_MARKETS_ENABLED
      assert.deepEqual(await urls(), [`https://repo.ing/token/${githubMint}`])
      assert.equal((await logo(new Request(`https://repo.ing/api/repo-logo/${MODEL_ID}`), { params: Promise.resolve({ repo: MODEL_ID }) })).status, 404)
    })
    // Nothing asked GitHub about anything; the only Hub request is the model card's read of the registry row's own path.
    assert.ok(net.requested.every(requested => !/github\.com/.test(requested)), `no GitHub request: ${net.requested.join(', ')}`)
    assert.ok(net.requested.filter(requested => /huggingface\.co/.test(requested))
      .every(requested => requested.startsWith('https://huggingface.co/api/models/openai-community/gpt2?')), net.requested.join(', '))
  } finally {
    net.restore()
    if (before === undefined) delete process.env.HF_MARKETS_ENABLED; else process.env.HF_MARKETS_ENABLED = before
    await pool?.end().catch(() => {}); delete globalThis.__gitfunPool
  }
})
