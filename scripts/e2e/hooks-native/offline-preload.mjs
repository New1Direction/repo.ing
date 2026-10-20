// Preloaded (node --import) into the website and owner agent processes of the local e2e stack, never into production:
//   - the three public SOL/USD sources (src/sol-usd-sources.mjs) answer one fixed price, HOOKS_E2E_SOL_USD, so USD launch
//     pricing runs its real quorum, virtual-quote and on-chain bounds code without the internet and deterministically;
//   - every fetch to a public Solana cluster RPC is refused, so nothing in the stack can read or send on mainnet/devnet.
// Market data is the only thing substituted here. Signing, RPC and the chain are untouched.
const price = Number(process.env.HOOKS_E2E_SOL_USD)
if (!(price > 0)) throw Error('offline-preload: HOOKS_E2E_SOL_USD must be a positive price')
const FIXED = new Map([
  ['https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { solana: { usd: price } }],
  ['https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', { So11111111111111111111111111111111111111112: { usdPrice: price } }],
  ['https://api.coinbase.com/v2/prices/SOL-USD/spot', { data: { amount: String(price), base: 'SOL', currency: 'USD' } }],
])
const PUBLIC_RPC = /(^|\.)(mainnet-beta\.solana\.com|devnet\.solana\.com|testnet\.solana\.com|publicnode\.com|helius-rpc\.com|helius\.xyz|quiknode\.pro|alchemy\.com|ankr\.com|triton\.one|rpcpool\.com)$/
const realFetch = globalThis.fetch
globalThis.fetch = async function e2eFetch(input, init) {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
  const url = new URL(href)
  if (FIXED.has(url.href)) return new Response(JSON.stringify(FIXED.get(url.href)), { status: 200, headers: { 'content-type': 'application/json' } })
  if (PUBLIC_RPC.test(url.hostname)) throw new TypeError(`e2e network guard: ${url.hostname} is a public cluster RPC; the local stack never contacts it`)
  return realFetch(input, init)
}
