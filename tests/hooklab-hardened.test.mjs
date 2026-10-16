import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import * as sdk from '@repo-ing/hooklab-hardened-candidate'
import { hardenedLaunchIdentity, previewHardenedTrade } from '../src/hooklab-hardened.mjs'
import { GET, POST } from '../app/api/hook-lab/hardened/route.js'

test('candidate provenance and bounded exports; no instruction builders, signers or senders', async () => {
  const root = new URL('../vendor/hooklab-hardened-candidate/', import.meta.url)
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)))
  assert.equal(provenance.revision, '826b5a480dfafbe9395f9e9b9c280d07fc7eb809')
  for (const [file, hash] of Object.entries(provenance.files)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(file, root))).digest('hex'), hash, file)
  }
  assert.deepEqual(Object.keys(sdk).sort(), ['HARDENED_DEVNET_PROGRAMS', 'creationControlHash', 'creatorAuthorizationAddress',
    'creatorAuthorizationHash', 'decodeHolding', 'decodeLaunch', 'decodeLaunchConfig', 'decodeMint', 'decodePool',
    'decodeSwapConfig', 'governanceAddress', 'governanceCommitment', 'hardenedCandidateManifest', 'mainnetLaunchAddresses', 'quoteLaunchSwap'].sort())
})

test('readiness and every attempted execution stay disabled, including claimed activation/mainnet', async () => {
  const before = await GET().json()
  assert.equal(before.observedSlot, null)
  assert.equal(before.deploymentVerified, false)
  assert.ok(Object.values(before.actions).every(value => value === false))
  for (const action of Object.keys(before.actions)) {
    const response = POST(new Request('http://localhost/api/hook-lab/hardened', { method: 'POST',
      body: JSON.stringify({ action, network: 'mainnet', enabled: true, approved: true }) }))
    assert.equal(response.status, 423)
    assert.equal((await response.json()).code, 'HARDENED_EXECUTION_DISABLED')
  }
  assert.deepEqual(await GET().json(), before)
})

test('identity and commitments use hardened IDs, matching independent producer vectors, never frozen defaults', () => {
  const profile = sdk.hardenedCandidateManifest()
  const input = { creator: new PublicKey(Buffer.alloc(32, 5)).toBase58(), mint: profile.roles.mint,
    quoteMint: profile.quoteMint, lpFeeBps: 30,
    governanceCommitment: '4257db8c55f35c3073b4a86202fac9cf24ab05b5bfdce4a87ba9729405197d91',
    authorization: { enabled: true, expiresAtSlot: '901', maxLaunches: '9007199254740993', consumed: '0', revision: '7' } }
  const result = hardenedLaunchIdentity(input)
  assert.equal(result.controlHash, '91697ab9701d56197d5bb00f61c6faaf95c25580776f53e5306838aa2d6deaae')
  assert.equal(result.canSign, false)
  assert.equal(hardenedLaunchIdentity({ ...input, creator: profile.roles.creator }).authorization, profile.pdas.creatorAuthorization)
  assert.equal(hardenedLaunchIdentity({ ...input, authorization: { ...input.authorization, consumed: '1' } }).controlHash, result.controlHash)
  assert.notEqual(hardenedLaunchIdentity({ ...input, authorization: { ...input.authorization, revision: '8' } }).controlHash, result.controlHash)
  assert.throws(() => hardenedLaunchIdentity({ ...input, quoteMint: profile.roles.mint }), /quote mint/)
})

test('plain buy/sell models distinguish quote fees, real liquidity, slippage and requested-CU fee rounding', () => {
  const input = { schema: 'repoing/hardened-trade-model/1', side: 'buy', amountIn: '101', maxInput: '101', slippageBps: 50,
    reserves: { baseReserve: '10000', quoteReserve: '3000', virtualBase: '0', virtualQuote: '2000' },
    effectiveLpFeeBps: 73, protocolShareBps: 2000,
    budget: { rentLamports: '222', networkFeeLamports: '5000', computeUnitLimit: 600001,
      computeUnitPriceMicroLamports: '1001', maxNativeDebitLamports: '5823' } }
  // Independent integer expectations: buy floor(100*10000/5100)=196;
  // sell floor(101*5000/10101)=49, minus ceil(49*73/10000)=1.
  const buy = previewHardenedTrade(input), sell = previewHardenedTrade({ ...input, side: 'sell' })
  assert.equal(buy.quote.delivered, '196'); assert.equal(buy.minimumOutput, '195')
  assert.equal(sell.quote.delivered, '48'); assert.equal(sell.minimumOutput, '47')
  assert.deepEqual(buy.nativeBudget, { priorityFeeLamports: '601', totalLamports: '5823' })
  assert.deepEqual(buy.refusals, [])
  assert.equal(buy.canSign, false); assert.equal(sell.canSubmit, false)
  assert.deepEqual(previewHardenedTrade({ ...input, budget: { ...input.budget, maxNativeDebitLamports: '5822' } }).refusals, ['native-cap-exceeded'])
  assert.equal(previewHardenedTrade({ ...input, side: 'sell', reserves: { ...input.reserves, quoteReserve: '0' } }).quote.failure, 'insufficient_liquidity')
  assert.throws(() => previewHardenedTrade({ ...input, amountIn: '102' }), /cap/)
  for (const extra of [{ rules: {} }, { initialBuy: 0 }, { sourceCommit: 'unknown' }]) assert.throws(() => previewHardenedTrade({ ...input, ...extra }))
  for (const amountIn of ['-1', '1.2', '01', '18446744073709551616', 101]) assert.throws(() => previewHardenedTrade({ ...input, amountIn }))
})
