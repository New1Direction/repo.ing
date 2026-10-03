import test from 'node:test'
import assert from 'node:assert/strict'
import { HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'
import { buildLaunchMessage, isModelAlert, X_MAX_WEIGHT, xWeight } from '../src/launch-alerts-message.mjs'
import { alertSources, createLaunchAlerts, createModelAlertFacts, LAUNCH_ALERT_DEFAULTS, launchAlertsConfig, liveModelFacts } from '../src/launch-alerts.mjs'
import { buildMilestoneMessage } from '../src/milestone-alerts-message.mjs'
import { createMilestoneAlerts, MILESTONE_ALERT_DEFAULTS, milestoneAlertsConfig, milestoneMarkets } from '../src/milestone-alerts.mjs'
import { graduationColumns, SOL } from './fixtures/graduation-rows.mjs'

// Hugging Face model markets in launch and milestone posts: model copy with the short disclaimer, sanitized like repository
// text and within X's 280 weighted characters; GitHub posts byte-identical; models only when the config includes them.
const ORIGIN = 'https://repo.ing'
const MINT = 'So11111111111111111111111111111111111111112'
const LINK = `https://repo.ing/token/${MINT}`
const NOW = Date.parse('2026-10-03T12:00:00Z')
const MODEL_ID = '4503599627370497', GPT2_HF_ID = '621ffdc036468d709f17434d'
const MODEL = { githubRepoId: MODEL_ID, fullName: 'openai-community/gpt2', modelPath: 'openai-community/gpt2', hfId: GPT2_HF_ID, tokenSymbol: 'GPT2',
  stars: 0, description: 'Text generation · License: mit', mint: MINT }
const GITHUB = { githubRepoId: '42', fullName: 'octo/hello-world', tokenSymbol: 'HELLO', stars: 12_345, description: 'A friendly greeter.', mint: MINT }
const curve = (remainingSol, thresholdSol = 85n) => ({ remainingLamports: String(remainingSol * SOL), thresholdLamports: String(thresholdSol * SOL) })
const launch = (market, channel) => buildLaunchMessage(market, { channel, origin: ORIGIN })
const milestone = (post, channel) => buildMilestoneMessage(post, { channel, origin: ORIGIN })

// ---------- copy ----------
test('GitHub posts are byte-identical, whatever model-looking fields a GitHub row carries: the id decides', () => {
  // Arrange
  const lookalike = { ...GITHUB, source: 'huggingface', modelPath: 'openai-community/gpt2', hfId: GPT2_HF_ID, likes: 9, downloads30d: 9 }
  const post = { githubRepoId: '7', fullName: 'New1Direction/webmcp-anything', tokenSymbol: 'RCAT', mint: MINT, milestone: 50, curve: { remainingLamports: '42500000000', thresholdLamports: String(85n * SOL) } }

  // Act
  const texts = ['telegram', 'x'].flatMap(channel => [launch(GITHUB, channel), launch(lookalike, channel), milestone(post, channel), milestone({ ...post, modelPath: 'a/b' }, channel)])

  // Assert
  for (const text of texts.filter((_, index) => index % 4 < 2)) {
    assert.equal(text, `🚀 New on repo.ing: octo/hello-world — $HELLO\n⭐ 12.3k · A friendly greeter.\nEvery trade pays the repo's builders.\n${LINK}`)
  }
  for (const text of texts.filter((_, index) => index % 4 >= 2)) {
    assert.equal(text, `📈 $RCAT passed 50% of the way to graduating on repo.ing — 42.5 SOL to go.\nNew1Direction/webmcp-anything\n${LINK}`)
  }
  assert.equal(isModelAlert(GITHUB), false)
  assert.equal(isModelAlert(MODEL), true)
  assert.equal(isModelAlert({ source: 'huggingface' }), true, 'no id: the source column decides')
})

test('a model launch post names the model, ticker, likes and task, then the owner tagline, the disclaimer and the link', () => {
  // Arrange
  const live = { ...MODEL, likes: 3149, downloads30d: 12_400_000 }

  // Act
  const telegram = launch(live, 'telegram'), x = launch(live, 'x')

  // Assert
  assert.equal(telegram, '🚀 New on repo.ing: Hugging Face model openai-community/gpt2 — $GPT2\n❤️ 3.1k likes · Text generation · License: mit\n'
    + `Every trade pays the model's owner.\n${HF_DISCLAIMER_SHORT}\n${LINK}`)
  assert.equal(x, telegram)
  assert.equal(xWeight(x), 275)
  assert.equal(launch({ ...live, likes: 1 }, 'x').split('\n')[1], '❤️ 1 like · Text generation · License: mit')
  assert.doesNotMatch(x, /price|moon|profit|guarantee|100x|pump|buy now/i)
})

test('without live likes a model post shows its downloads, else only its stored summary; whole facts drop first on X', () => {
  // Arrange
  const downloads = { ...MODEL, downloads30d: 12_400_000 }

  // Act
  const telegram = launch(downloads, 'telegram'), x = launch(downloads, 'x'), stored = launch(MODEL, 'x'), bare = launch({ ...MODEL, description: null }, 'x')

  // Assert
  assert.equal(telegram.split('\n')[1], '⬇️ 12.4M downloads (30d) · Text generation · License: mit')
  assert.equal(x.split('\n')[1], '⬇️ 12.4M downloads (30d) · Text generation', 'the last whole fact is dropped, never cut')
  assert.ok(xWeight(x) <= X_MAX_WEIGHT && xWeight(`${x} · License: mit`) > X_MAX_WEIGHT)
  assert.equal(stored.split('\n')[1], 'Text generation · License: mit')
  assert.deepEqual(bare.split('\n'), ['🚀 New on repo.ing: Hugging Face model openai-community/gpt2 — $GPT2', "Every trade pays the model's owner.", HF_DISCLAIMER_SHORT, LINK])
  assert.equal(launch({ ...MODEL, modelPath: null }, 'x').split('\n')[0], '🚀 New on repo.ing: Hugging Face model openai-community/gpt2 — $GPT2', 'no registry path: the stored name')
})

test('model text is cleaned exactly like repository text: no links, tags, controls or HTML', () => {
  // Arrange
  const hostile = { ...MODEL, modelPath: 'evil/<b>@you#x$y‮', tokenSymbol: '<i>$X', likes: 5,
    description: 'Ping @elonmusk #crypto $SOL · Docs: https://evil.example/x and www.spam.io · <script>alert("x")</script> & co' }

  // Act
  const telegram = launch(hostile, 'telegram'), x = launch(hostile, 'x')

  // Assert
  assert.equal(telegram.split('\n')[0], '🚀 New on repo.ing: Hugging Face model evil/byouxy — $iX')
  assert.equal(telegram.split('\n')[1], '❤️ 5 likes · Ping elonmusk crypto SOL · Docs: and · &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co')
  assert.doesNotMatch(telegram, /<|‮/)
  // Only the token page link is a link; the model's own lines carry no link, tag or stray $ (the ticker is ours).
  for (const text of [telegram, x]) for (const line of text.split('\n').slice(0, 2)) assert.doesNotMatch(line, /https?:|www\.|[@#]|\$(?!iX$)|‮/)
  assert.ok(xWeight(x) <= X_MAX_WEIGHT)
})

test('X model posts stay within 280 weighted characters; a model id too long for the post is shortened visibly, never silently', () => {
  // Arrange
  const longest = `${'o'.repeat(96)}/${'n'.repeat(96)}`
  const variants = [{}, { likes: 999_999, downloads30d: 9_999_999 }, { description: 'Text generation · '.repeat(30) }, { description: '漢字'.repeat(200) },
    { modelPath: longest, tokenSymbol: 'S'.repeat(16), likes: 999_999 }, { modelPath: longest, tokenSymbol: '' }, { modelPath: 'a.io/b.io', description: 'x.io '.repeat(50) }]

  for (const variant of variants) {
    // Act
    const text = launch({ ...MODEL, ...variant }, 'x')

    // Assert
    assert.ok(xWeight(text) <= X_MAX_WEIGHT, `${xWeight(text)} for ${JSON.stringify(variant).slice(0, 60)}`)
    assert.ok(text.endsWith(`\n${HF_DISCLAIMER_SHORT}\n${LINK}`), 'the disclaimer and the link always stay')
    assert.match(text, /^🚀 New on repo\.ing: Hugging Face model /)
    assert.equal(text.isWellFormed(), true)
  }
  const shortened = launch({ ...MODEL, modelPath: longest, tokenSymbol: 'ABCDEFGHIJ' }, 'x')
  assert.match(shortened.split('\n')[0], /^🚀 New on repo\.ing: Hugging Face model o{96}\/n+… — \$ABCDEFGHIJ$/)
  assert.equal(launch({ ...MODEL, modelPath: longest }, 'telegram').split('\n')[0].includes(longest), true, 'Telegram keeps the whole id')
})

test('model milestone and graduation posts carry the model id and the disclaimer, within 280 on X', () => {
  // Arrange
  const post = { ...MODEL, milestone: 50, curve: { remainingLamports: '42500000000', thresholdLamports: String(85n * SOL) } }
  const longest = `${'o'.repeat(96)}/${'n'.repeat(96)}`

  // Act
  const telegram = milestone(post, 'telegram'), graduated = milestone({ ...post, milestone: 100, curve: curve(0n) }, 'x')

  // Assert
  assert.equal(telegram, `📈 $GPT2 passed 50% of the way to graduating on repo.ing — 42.5 SOL to go.\nHugging Face model openai-community/gpt2\n${HF_DISCLAIMER_SHORT}\n${LINK}`)
  assert.equal(milestone(post, 'x'), telegram)
  assert.equal(graduated, `🎓 $GPT2 graduated to Meteora after reaching its 85 SOL target on repo.ing.\nHugging Face model openai-community/gpt2\n${HF_DISCLAIMER_SHORT}\n${LINK}`)
  assert.equal(milestone({ ...post, tokenSymbol: '' }, 'x').split('\n')[0],
    '📈 Hugging Face model openai-community/gpt2 passed 50% of the way to graduating on repo.ing — 42.5 SOL to go.', 'no ticker: the model names it')
  assert.equal(milestone({ ...post, modelPath: 'a/<b>@x' }, 'telegram').split('\n')[1], 'Hugging Face model a/bx')
  for (const step of [25, 50, 75, 90, 100]) for (const extra of [{ modelPath: longest, tokenSymbol: 'S'.repeat(16) }, { modelPath: longest, tokenSymbol: '' }]) {
    const text = milestone({ ...post, ...extra, milestone: step, curve: curve(339_999n, 340_000n) }, 'x')
    assert.ok(xWeight(text) <= X_MAX_WEIGHT, `${xWeight(text)} for ${step}`)
    assert.ok(text.endsWith(`\n${HF_DISCLAIMER_SHORT}\n${LINK}`))
    assert.match(text, /…/, 'the over-long id is visibly shortened')
  }
  assert.throws(() => milestone({ ...post, milestone: 60 }, 'x'), /Unknown milestone/)
  assert.throws(() => milestone(post, 'email'), /Unknown/)
  assert.throws(() => launch(MODEL, 'email'), /Unknown/)
})

// ---------- configuration ----------
test('model markets are included only with HF_MARKETS_ENABLED=true in the worker environment', () => {
  // Arrange
  const env = { TELEGRAM_BOT_TOKEN: '123456:SECRET-token', TELEGRAM_CHAT_ID: '@repoing_launches', LAUNCH_ALERTS_ENABLED: 'true',
    LAUNCH_ALERTS_SINCE: '2026-10-01T00:00:00Z', GRADUATION_ALERTS_ENABLED: 'true', GRADUATION_ALERTS_SINCE: '2026-10-01T00:00:00Z' }

  // Act
  const off = [launchAlertsConfig(env).models, milestoneAlertsConfig(env).models, launchAlertsConfig({ ...env, HF_MARKETS_ENABLED: 'yes' }).models]
  const on = [launchAlertsConfig({ ...env, HF_MARKETS_ENABLED: 'true' }).models, milestoneAlertsConfig({ ...env, HF_MARKETS_ENABLED: 'true' }).models]

  // Assert
  assert.deepEqual(off, [false, false, false])
  assert.deepEqual(on, [true, true])
  assert.deepEqual([alertSources(false), alertSources(undefined), alertSources(true)], [['github'], ['github'], ['github', 'huggingface']])
})

// ---------- launch job ----------
const HOUR = 3600_000
const progress = (percent, mint) => {
  const columns = graduationColumns({ mint, reserveLamports: 850_000_000n * BigInt(percent), now: NOW })
  return { graduationStatus: columns.status, observation: columns.observation, graduationError: columns.error_code, migrationEvidenceHash: columns.migration_evidence_hash }
}
const modelCandidate = (n, percent, extra = {}) => ({ ...MODEL, githubRepoId: String(4503599627370496n + BigInt(n)), fullName: `org/model-${n}`,
  modelPath: `org/model-${n}`, hfId: String(n).padStart(24, 'a'), mint: `MintModel${n}`, tokenSymbol: `M${n}`, indexedAt: new Date(NOW - HOUR), ...progress(percent, `MintModel${n}`), ...extra })
const githubCandidate = n => ({ ...GITHUB, githubRepoId: String(n), fullName: `octo/repo-${n}`, mint: `MintRepo${n}`, githubCreatedAt: new Date(NOW - 400 * 86_400_000),
  stars: 500, indexedAt: new Date(NOW - 2 * HOUR) })

// Mirrors the store's SQL: model markets only with models: true, one claim per market and channel.
function launchJob({ markets, models, modelFacts = null, channels = ['telegram', 'x'] }) {
  const claims = new Set(), asked = [], sent = []
  const store = { async withLock(fn) { return { locked: true, value: await fn() } }, async expireStale() { return [] }, async sentRecently() { return 0 },
    async candidates({ channel, models: included, limit, offset = 0 }) {
      asked.push(included)
      return markets.filter(market => (included || !isModelAlert(market)) && !claims.has(`${market.githubRepoId}:${channel}`)).slice(offset, offset + limit)
    },
    async claim({ channel, market }) { const key = `${market.githubRepoId}:${channel}`; if (claims.has(key)) return null; claims.add(key); return key },
    async finish() {} }
  const senders = Object.fromEntries(channels.map(channel => [channel, async ({ text }) => { sent.push([channel, text]); return { status: 'sent', messageId: String(sent.length) } }]))
  const job = createLaunchAlerts({ store, senders, now: () => NOW, sleep: async () => {}, modelFacts,
    config: { ...LAUNCH_ALERT_DEFAULTS, channels, since: new Date(NOW - 24 * HOUR), origin: ORIGIN, maxPerRun: 5, excluded: new Set(), models } })
  return { job, asked, sent }
}

test('the launch job posts model markets only when included, once they earn promotion like any new market', async () => {
  // Arrange
  const markets = [githubCandidate(1), modelCandidate(1, 12), modelCandidate(2, 9), modelCandidate(3, 50)]
  const without = launchJob({ markets, models: false }), included = launchJob({ markets, models: true })

  // Act
  await without.job.runOnce()
  await included.job.runOnce()

  // Assert
  assert.deepEqual(without.asked, [false, false])
  assert.deepEqual(without.sent.map(([channel, text]) => [channel, text.split('\n')[0]]),
    [['telegram', '🚀 New on repo.ing: octo/repo-1 — $HELLO'], ['x', '🚀 New on repo.ing: octo/repo-1 — $HELLO']])
  assert.deepEqual(included.asked, [true, true])
  assert.deepEqual(included.sent.filter(([channel]) => channel === 'x').map(([, text]) => text.split('\n')[0]), ['🚀 New on repo.ing: octo/repo-1 — $HELLO',
    '🚀 New on repo.ing: Hugging Face model org/model-1 — $M1', '🚀 New on repo.ing: Hugging Face model org/model-3 — $M3'], 'model-2 (9%) has not earned it: likes never count')
  for (const [, text] of included.sent.filter(([, text]) => text.includes('Hugging Face model'))) assert.ok(text.includes(HF_DISCLAIMER_SHORT))
})

test('live model facts are read once per market per run, only for the registry _id, and never block a post', async () => {
  // Arrange
  const reads = []
  const hf = { async model({ path }) {
    reads.push(path)
    if (path === 'org/model-2') return { hfId: 'b'.repeat(24), path, likes: 77, downloads30d: 1 }
    if (path === 'org/model-3') throw Object.assign(Error('Hugging Face request timed out'), { code: 'HF_TIMEOUT' })
    return { hfId: '1'.padStart(24, 'a'), path: 'org/Model-1-Renamed', likes: 4200, downloads30d: 10 }
  } }
  const { job, sent } = launchJob({ markets: [modelCandidate(1, 12), modelCandidate(2, 30), modelCandidate(3, 30), githubCandidate(4)], models: true,
    modelFacts: createModelAlertFacts({ hf }) })

  // Act
  await job.runOnce()

  // Assert
  assert.deepEqual(reads, ['org/model-1', 'org/model-2', 'org/model-3'], 'one read per model market across both channels; none for GitHub')
  const x = sent.filter(([channel]) => channel === 'x').map(([, text]) => text.split('\n').slice(0, 2))
  assert.deepEqual(x[0], ['🚀 New on repo.ing: Hugging Face model org/Model-1-Renamed — $M1', '❤️ 4.2k likes · Text generation · License: mit'], 'same _id: live path and likes')
  assert.deepEqual(x[1], ['🚀 New on repo.ing: Hugging Face model org/model-2 — $M2', 'Text generation · License: mit'], 'a different _id: stored facts only')
  assert.deepEqual(x[2], ['🚀 New on repo.ing: Hugging Face model org/model-3 — $M3', 'Text generation · License: mit'], 'a failed read still posts')
  assert.equal(sent.length, 8)
  assert.equal(await createModelAlertFacts({ hf })({ ...MODEL, hfId: null }), null, 'no registry row: nothing is read')
  assert.equal(liveModelFacts(null)(MODEL), MODEL, 'no reader: the market as stored')
})

// ---------- milestone job ----------
test('the milestone job includes model markets only when configured, marks first, then posts model copy', async () => {
  // Arrange
  let reserveSol = 10n, clock = NOW
  const rows = () => [{ githubRepoId: MODEL_ID, mint: MINT, tokenSymbol: 'GPT2', fullName: 'openai-community/gpt2', modelPath: 'openai-community/gpt2',
    ...graduationColumns({ now: clock, reserveSol, thresholdSol: 100n }) }]
  const marks = new Map(), alerts = [], asked = [], sent = []
  const store = { async withLock(fn) { return { locked: true, value: await fn() } }, async expireStale() { return [] }, async forgetMarks() {},
    async progressRows({ models }) { asked.push(models); return models ? rows() : [] },
    async channelState() { return { marks: new Map(marks), alerts: new Map() } },
    async mark(channel, list) { for (const { githubRepoId, milestone: level } of list) marks.set(githubRepoId, { milestone: level, markedAt: new Date(clock) }) },
    async sentRecently() { return 0 }, async claim({ post }) { alerts.push(post.milestone); return String(alerts.length) }, async finish() {} }
  const job = models => createMilestoneAlerts({ store, now: () => clock, sleep: async () => {},
    senders: { telegram: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: '1' } } },
    config: { ...MILESTONE_ALERT_DEFAULTS, channels: ['telegram'], since: new Date(NOW - HOUR), origin: ORIGIN, excluded: new Set(), models } })

  // Act
  await job(false).runOnce()
  await job(true).runOnce()
  clock += 60_000; reserveSol = 52n
  await job(true).runOnce()

  // Assert
  assert.deepEqual(asked, [false, true, true])
  assert.deepEqual([...marks.values()].map(mark => mark.milestone), [0], 'first sight only marks')
  assert.deepEqual(sent, [`📈 $GPT2 passed 50% of the way to graduating on repo.ing — 48 SOL to go.\nHugging Face model openai-community/gpt2\n${HF_DISCLAIMER_SHORT}\n${LINK}`])
  assert.deepEqual(milestoneMarkets(rows(), new Set([MODEL_ID]), clock), [], 'the do-not-promote list covers model markets')
  assert.equal(milestoneMarkets(rows(), new Set(), clock)[0].modelPath, 'openai-community/gpt2')
})
