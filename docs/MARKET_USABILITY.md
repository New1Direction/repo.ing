# Market discovery and wallet usability

Requested on 2026-09-25: homepage discovery, a personal holdings/rewards page, market sharing, buy presets with clearer quotes, and bonding progress.

## Changes

- Home and Explore share integer-safe 24-hour volume ranking. The homepage's separate New tab orders launches by indexed time. The homepage and How it works explain the discovery reward share, lifetime cap, and earning window.
- `/wallet` uses the connected wallet and exposes Holdings, Launched, and Rewards tabs. A public read-only endpoint aggregates every legacy SPL token account for the wallet, matches only canonical indexed repo.ing markets, and keeps raw token amounts in integers. Failed RPC reads are unavailable, never fabricated zero holdings. Switching wallets clears the previous wallet's data. Discovery totals apply the existing lifetime cap and subtract settled claims. Builder claim links still use the existing GitHub authority and wallet verification flow.
- Market pages and launch receipts offer native sharing and a copy-link button. Repository-specific title, description, canonical URL, and a 1200×630 PNG preview use the existing smart repository logo. Image processing is size- and time-bounded with a readable fallback. `sharp` is a direct dependency at its already-installed version, 0.35.4.
- Buy presets are 0.01, 0.05, and 0.1 SOL. Quotes include exact SDK trading fees in SOL and fee-excluded execution-price impact versus the current pool spot price. USD is an estimate using the current SOL price. Network/account setup fees remain additional and are reviewed in the wallet. Signing, execution amounts, and fixed 1% slippage remain unchanged.
- Bonding progress comes from the canonical DBC pool's quote reserve divided by its configured migration threshold. It can decrease after sells. Curve completion and completed migration are separate states. After migration, derive the DAMM v2 pool from the canonical config's migration fee option, then verify its program owner, token pair, and enabled status before displaying a Meteora link. Unavailable or contradictory destination data never creates an unchecked link. The old chart labels its DBC price/cap as historical after bonding ends; its holder count is hidden until the new pool's vault can be excluded correctly.

## Verification

- `node --test tests/market-usability.test.mjs tests/token-balance.test.mjs tests/discovery-rules.test.mjs`: 11 tests passed, covering exact sorting, multi-account balances/owner checks, missing balances, reward caps and paid amounts, fee-excluded buy/sell impact, progress boundaries, and destination validation.
- Production build passed. The first build reported a shutdown cache warning on this nearly-full Mac; deleting only `.next/cache` and rebuilding removed that warning.
- Final web deployment `373c5193-53c8-48b1-a7a2-ca4c90a7eb93` succeeded. `/`, `/wallet`, `/explore`, the checked market page, and the new bonding endpoint returned HTTP 200. No worker redeploy or database migration was required.
- Live homepage Trending put OHIYO first by 24-hour volume; New put the most recent launch first. The wallet initially showed 9 token holdings and 11 launches, then refreshed to include the concurrent SKILLS launch. Its Paperclip raw token balance and discovery earned/remaining totals exactly matched the pre-existing balance and discovery endpoints. An invalid wallet returned HTTP 400.
- Live Paperclip buy quote for `10,000,000` lamports returned a `175,000` lamport trading fee and `0.4951%` price impact; a sell quote for `1,000,000,000,000` token base units returned an `18,023` lamport fee and `0.0519%` impact. These were quotes only. Bonding reserves were `29,475,000 / 29,954,748,784` lamports, displayed as `0.09%` with migration not yet complete.
- Desktop and 390px browser checks covered wallet tabs, direct trade navigation, the 0.01 SOL buy preset, USD/fee/impact display, bonding reserves, and copy-link feedback. Wallet connection persisted through client navigation and restored after a full load. Mobile wallet document width was 390px; the checked mobile market had no horizontal overflow.
- Social crawler HTML returned the repository title and absolute `https://repo.ing/` Open Graph/Twitter image URLs. The final share image returned HTTP 200 as a 1200×630 PNG with the selected repository image, ticker, and description. Visual review caught and fixed a shrinking image before final verification.

## Boundaries

No database migration, private-key export, mainnet launch, trade, claim, or migration transaction is needed for this release. The post-graduation continuation opens the verified pool on Meteora; repo.ing does not execute DAMM swaps itself in this release. Mainnet end-to-end graduation and the first discovery payout remain separate verification work.

SDK references: [Meteora migration flow](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/packages/dynamic-bonding-curve/README.md), [official DAMM v2 pool URL](https://app.meteora.ag/dammv2/93CarQ8SqZEQaFK1jQVdvCi749m3s8LAqXGVJv6Rz72t). Installed DBC SDK 1.5.13 and DAMM v2 SDK 1.4.10 supply derivation and account decoding.
