import test from 'node:test'
import assert from 'node:assert/strict'
import { appModule, h, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'
import { HF_DISCLAIMER } from '../src/hf-copy.mjs'

// Where a model market shows its 1% builder allocation: first in the token page's Rewards (locked, claimable by the
// verified owner, then settled with the recipient), the claim page's allocation step, and the launch review. Rendered
// offline; the token page section fetches /api/allocation/<id> in the browser, so here it shows its first, checking state.
const { ModelTokenPage } = await appModule('app/components/hf/model-token-page.jsx')
const { ModelAllocation } = await appModule('app/components/hf/model-allocation.jsx')
const { ModelClaimSteps } = await appModule('app/components/hf/claim-steps.jsx')
const { LaunchForm } = await appModule('app/components/launch-form.jsx')

const MODEL_ID = '4503599627370497', WALLET = 'Bound1111111111111111111111111111111111111'
const MODEL = { repoId: MODEL_ID, source: 'huggingface', mint: 'MintModelGpt2', pool: 'PoolModelGpt2', fullName: 'openai-community/gpt2', owner: 'openai-community',
  name: 'gpt2', description: null, symbol: 'GPT2', tokenName: 'gpt2', wasVerified: false, volume24hLamports: '0', earned: '0', claimed: '0', remaining: '0',
  stars: 0, forks: 0, priceSol: null, indexedAt: '2026-10-01T11:00:00.000Z', newRepo: false, promoted: true, officialLaunch: false, discoveryVersion: 2 }
const escaped = text => text.replaceAll("'", '&#x27;')
async function withFlag(work) {
  const before = process.env.HF_MARKETS_ENABLED
  process.env.HF_MARKETS_ENABLED = 'true'
  try { return await work() } finally { if (before === undefined) delete process.env.HF_MARKETS_ENABLED; else process.env.HF_MARKETS_ENABLED = before }
}

test('model token page: Rewards opens with the 1% builder allocation, before discovery rewards, under the page’s disclaimer', () => withFlag(async () => {
  const net = offlineFetch()
  try {
    const page = html(await resolveServer(await ModelTokenPage({ market: { ...MODEL, allocationVersion: 1 } })), { wallet: true })
    assert.ok(page.includes(escaped(HF_DISCLAIMER)), 'the full disclaimer')
    const rewards = page.slice(page.indexOf('<div id="rewards"'))
    const allocation = rewards.indexOf('<section class="inner-card builder-allocation model-allocation"'), discovery = rewards.indexOf('Discovery')
    assert.ok(allocation >= 0 && discovery > allocation, 'the allocation first, then discovery rewards')
    assert.match(rewards, /<h3 id="model-allocation-title">Builder allocation · 1%<\/h3><span class="small-chip">Checking<\/span>/)
    assert.match(rewards, /<strong>10,000,000 tokens<\/strong><p>A one-time allocation from the fixed supply, reserved for the model’s verified owner on Hugging Face/)
    // Without the stamp (every market launched before 0052) there is no allocation section.
    const unstamped = html(await resolveServer(await ModelTokenPage({ market: { ...MODEL, allocationVersion: null } })), { wallet: true })
    assert.ok(!unstamped.includes('model-allocation'))
  } finally { net.restore() }
}))

test('the token page’s allocation card never claims from its first render: it waits for the reviewed status', () => {
  const card = html(h(ModelAllocation, { repoId: MODEL_ID }))
  assert.match(card, /<p role="status">Checking allocation…<\/p>/)
  assert.ok(!card.includes('Claim 10 million tokens'))
})

const STEPS = { summary: null, repoId: MODEL_ID, signedIn: { username: 'TheBloke', expiresAt: Date.now() + 600_000 },
  authority: { ok: true, role: 'owner', ownerHandle: 'TheBloke', ownerKind: 'user', code: null, message: null }, beneficiaryWallet: WALLET,
  beneficiaryMethod: 'pasted', beneficiaryBoundAt: '2026-10-01T10:00:00.000Z', claimable: '0', usdEstimate: null, feeStatus: 'MATCH', payoutReady: true,
  settledClaim: null, justClaimed: false, errorCode: null, review: null, graduated: true }
const step = allocation => html(h(ModelClaimSteps, { ...STEPS, allocation }), { wallet: true })
const ALLOCATION = { state: 'available', wallet: WALLET, signature: null, boundBy: 'you', review: 'sealed-review' }

test('claim page: the allocation step is claimable by the signed-in owner who set the payout wallet, and only then', () => {
  const claimable = step(ALLOCATION)
  assert.match(claimable, /<span>Allocation<span class="sr-only"> \(not started\)<\/span><\/span>/, 'a fourth checklist item')
  assert.match(claimable, /<div class="claim-step last current"><div class="step-number ">4<\/div>/)
  assert.match(claimable, /<h2>Claim the 1% builder allocation<\/h2><\/div><span class="small-chip">Unlocked<\/span>/)
  assert.match(claimable, /A payout never repeats, even after a transfer or a wallet change\./)
  assert.match(claimable, /<button class="button primary" type="button">Claim 10 million tokens<\/button>/)
  assert.match(claimable, /<div class="claim-step current"><div class="step-number">3<\/div>/, 'step 3 is no longer the last')
  for (const [why, allocation, props, message] of [
    ['set by another user', { ...ALLOCATION, boundBy: 'another', review: null }, {}, /set by another Hugging Face user/],
    ['signed out', ALLOCATION, { signedIn: null, authority: null }, /Sign in with Hugging Face above as the model’s owner/],
    ['not the owner', ALLOCATION, { authority: { ok: false, code: 'HF_NOT_AUTHORIZED', message: 'Only the model’s owner can do this.' } }, /Sign in with Hugging Face above/],
    ['a binding made for a previous owner', ALLOCATION, { staleBinding: true }, /paid only to a wallet set by the model’s current owner/],
    ['payouts paused', ALLOCATION, { payoutReady: false }, /Payouts are paused/],
    ['locked', { ...ALLOCATION, state: 'locked', review: null }, {}, /stays reserved until this market graduates/],
  ]) {
    const markup = html(h(ModelClaimSteps, { ...STEPS, ...props, allocation }), { wallet: true })
    assert.ok(!markup.includes('Claim 10 million tokens'), why)
    assert.match(markup, message, why)
  }
  assert.match(step({ ...ALLOCATION, boundBy: 'another', review: null }), /<button class="button outline" type="button">Set my payout wallet<\/button>/)
})

test('claim page: a paid allocation shows its recipient and receipt; a market without the stamp keeps three steps', () => {
  const paid = step({ state: 'settled', wallet: WALLET, signature: 'GrantSignature', boundBy: 'you', review: null })
  assert.match(paid, /<span>Allocation<span class="sr-only"> \(done\)<\/span><\/span>/)
  assert.match(paid, /<h2>Allocation paid<\/h2><p>10,000,000 tokens were paid to the verified payout wallet\.<\/p>/)
  assert.ok(paid.includes('https://explorer.solana.com/tx/GrantSignature') && paid.includes('Bound1'))
  const plain = html(h(ModelClaimSteps, STEPS), { wallet: true })
  assert.ok(!plain.includes('builder allocation') && !plain.includes('>Allocation<'))
  assert.match(plain, /<div class="claim-step last current"><div class="step-number">3<\/div>/, 'unchanged markup without the allocation')
})

test('launch review: a model on an allocation config says the 1% is for the model’s verified owner; a repository’s copy is unchanged', () => {
  const card = repo => html(h(LaunchForm, { repo, available: true, allocationEnabled: true }), { wallet: true })
  const model = card({ repoId: MODEL_ID, source: 'huggingface', hfId: '621ffdc036468d709f17434d', fullName: 'openai-community/gpt2', owner: 'openai-community', name: 'gpt2' })
  assert.match(model, /<h3>1% for the model&#x27;s owner<\/h3><strong>10 million tokens reserved<\/strong><p>The model&#x27;s verified owner on Hugging Face can claim/)
  assert.ok(!model.includes('1% for the builders'))
  const repository = card({ repoId: '1296269', source: 'github', fullName: 'octocat/Hello-World', owner: 'octocat', name: 'Hello-World' })
  assert.match(repository, /<h3>1% for the builders<\/h3><strong>10 million tokens reserved<\/strong><p>The verified repository admin can claim this one-time allocation/)
})
