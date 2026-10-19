// The coin page's market reader around graduation: accounts encoded with the pinned IDLs, pools from the Rust vectors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import { readHookCoinMarket } from '../src/hooklab-coin-market.mjs'
import { loadArtifacts } from '../src/hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS, QUOTE_MINT, holdingAddress } from '../src/hooklab-owner-driver/pins.mjs'
import { hookCoinAddresses } from '../src/hooklab-inclusive-max-wallet-swap.mjs'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/hooklab-graduation-vectors.json', import.meta.url)))
const config = vectors.configs.find(c => c.name === 'Vq 53.25 SOL, fee 100'), at = label => config.states.find(s => s.label === label)
const { coders, idls } = loadArtifacts(), profile = { programs: PROGRAMS, quoteMint: QUOTE_MINT }
const mint = Keypair.generate().publicKey.toBase58(), wallet = Keypair.generate().publicKey.toBase58(), a = hookCoinAddresses(profile, mint)
const zero = (role, type) => {
  if (typeof type === 'string') return type === 'pubkey' ? PublicKey.default : type === 'bool' ? false : type === 'string' ? '' : /64|128/.test(type) ? new BN(0) : 0
  if (type.option) return null
  if (type.array) return Array.from({ length: type.array[1] }, () => zero(role, type.array[0]))
  return Object.fromEntries(idls[role].types.find(t => t.name === type.defined.name).type.fields.map(f => [f.name, zero(role, f.type)]))
}
const encode = (role, name, values) => coders[role].accounts.encode(name, { ...zero(role, { defined: { name } }), ...values })
const holding = amount => { const b = Buffer.alloc(204); b.writeBigUInt64LE(BigInt(amount), 74); return b }
const bn = v => new BN(String(v))

async function chain({ pool, status = 0, graduatedAt = 0, topup = 0, burned = 0, lpSupply = 0, lockedLp = 0 }) {
  const launch = await encode('launch', 'Launch', { version: 1, mint: new PublicKey(mint), creator: new PublicKey(wallet), pool: new PublicKey(a.pool), quote_mint: new PublicKey(QUOTE_MINT),
    status, creator_fee_bps: config.creatorFeeBps, virtual_quote: bn(config.virtualQuote), virtual_base: bn(config.curve.virtualBase), graduation_quote: bn(config.curve.graduationQuote),
    curve_tokens: bn(config.curve.curveTokens), reserve_tokens: bn(config.curve.reserveTokens), graduated_at: bn(graduatedAt), graduation_topup: bn(topup), graduation_burned: bn(burned),
    config: new PublicKey(PROGRAMS.launch), custom_hook: new PublicKey(PROGRAMS.gate), custom_hook_flags: 1 })
  const poolBytes = await encode('swap', 'Pool', { version: 1, base_mint: new PublicKey(mint), quote_mint: new PublicKey(QUOTE_MINT), base_reserve: bn(pool.baseReserve), quote_reserve: bn(pool.quoteReserve),
    virtual_base: bn(pool.virtualBase), virtual_quote: bn(pool.virtualQuote), protocol_fees_quote: bn(pool.protocolFeesQuote), lp_supply: bn(lpSupply), curve: status === 0, swap_count: bn(12), fee_model: 2 })
  const policy = await encode('gate', 'PolicyV2', { version: 2, mint: new PublicKey(mint), initial_supply: bn(config.supply), cap_bps: 200, quote_mint: new PublicKey(QUOTE_MINT), fee_model: 2, protocol_share_bps: 2500, creator_fee_bps: config.creatorFeeBps })
  const coin = await encode('token', 'Mint', { version: 1, decimals: 6, supply: bn(BigInt(config.supply) - BigInt(burned)), max_supply: bn(config.supply), name: 'Graduate', symbol: 'GRAD', uri: '' })
  const accounts = new Map([[a.launch, [PROGRAMS.launch, launch]], [a.pool, [PROGRAMS.swap, poolBytes]], [a.policy, [PROGRAMS.gate, policy]], [mint, [PROGRAMS.token, coin]],
    [a.launchReserve, [PROGRAMS.token, holding(BigInt(config.curve.reserveTokens) - BigInt(topup) - BigInt(burned))]], [a.launchLp, [PROGRAMS.token, holding(lockedLp)]],
    [wallet, [PublicKey.default.toBase58(), Buffer.alloc(0), 5_000_000_000]], [holdingAddress(QUOTE_MINT, wallet), [PROGRAMS.token, holding(7)]], [holdingAddress(mint, wallet), [PROGRAMS.token, holding(9)]]])
  return { getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: 77 }, value: keys.map(k => {
    const hit = accounts.get(k.toBase58()); return hit ? { owner: new PublicKey(hit[0]), data: hit[1], lamports: hit[2] ?? 1 } : null }) }) }
}

test('on the curve: progress, and what a buy costs right now to finish it', async () => {
  const s = at('near the end'), { market } = await readHookCoinMarket({ connection: await chain({ pool: s.pool }), mint })
  assert.equal(market.graduated, false); assert.equal(market.curveComplete, false); assert.equal(market.graduation, null)
  assert.equal(market.solToGraduationLamports, s.finalFill.amountIn, 'the exact final fill from the Rust core')
  assert.equal(market.curveProgressBps, Number(BigInt(s.pool.quoteReserve) * 10000n / BigInt(config.curve.graduationQuote)))
  assert.equal(market.reserveTokens, config.curve.reserveTokens)
})

test('a full curve waiting for graduate: complete, nothing left to buy, and what graduate will do', async () => {
  const s = at('complete'), { market } = await readHookCoinMarket({ connection: await chain({ pool: s.pool }), mint })
  assert.equal(market.curveComplete, true); assert.equal(market.graduated, false); assert.equal(market.solToGraduationLamports, null); assert.equal(market.curveProgressBps, 10000)
  assert.deepEqual([market.graduation.topup, market.graduation.burned, market.graduation.lockedLp, market.graduation.quoteReserve],
    [s.graduation.topup, s.graduation.burned, s.graduation.lpLocked, s.graduation.after.quoteReserve])
})

test('graduated: status 1, what graduate did, the locked LP, and the burned supply out of the market cap', async () => {
  const g = at('complete').graduation
  const { market, wallet: mine } = await readHookCoinMarket({ connection: await chain({ pool: g.after, status: 1, graduatedAt: 1_760_000_000, topup: g.topup, burned: g.burned,
    lpSupply: g.lpSupply, lockedLp: g.lpLocked }), mint, wallet })
  assert.equal(market.graduated, true); assert.equal(market.curveComplete, false); assert.equal(market.solToGraduationLamports, null); assert.equal(market.curveProgressBps, 10000)
  assert.deepEqual(market.graduation, { at: 1_760_000_000, topup: g.topup, burned: g.burned, lockedLp: g.lpLocked, lpSupply: g.lpSupply })
  const supply = BigInt(config.supply) - BigInt(g.burned)
  assert.equal(market.marketCapLamports, String(BigInt(g.after.quoteReserve) * supply / BigInt(g.after.baseReserve)))
  assert.deepEqual(mine, { address: wallet, lamports: '5000000000', bridgedSol: '7', coin: '9' }, 'wallet balances still come from their own accounts')
})
