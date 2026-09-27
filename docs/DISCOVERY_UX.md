# README badges, watchlists, and repository categories

Requested 2026-09-25: add the three discovery/return-visit features while keeping repo.ing's GitHub-style interface simple.

## Behavior

- **README badge:** Market sharing and the launch success card expose a compact, keyboard-accessible badge menu with a preview and copyable Markdown. It links to the canonical mint and uses immutable repository ID for the image. `/api/badge/[repo]` sums recorded builder fee events for the finalized canonical pool. It includes paid and unpaid earnings, excludes discovery rewards, and does not decrease after a claim. The SVG reports SOL with four display decimals; nonzero dust is shown as `<0.0001 SOL`. It escapes repository labels, does not fetch GitHub or SOL/USD, and caches successful responses for five minutes. Unknown repositories return 404; database failures return 503 with an unavailable badge, never a fabricated zero. GitHub's image proxy can retain its own cache longer.
- **Watchlist:** Small eye buttons on market rows and Watch/Watching on market pages save up to 50 repositories in `repo.ing.watchlist.v1` localStorage. Explore has a Watchlist tab. No wallet or GitHub login is required. State survives navigation/reload and synchronizes across tabs of the same browser. Browser storage failures retain the current visit and show a warning. This version does not sync across devices or wallets.
- **Optional alerts:** Off by default. Select 10% or 25% moves from Watchlist settings. While a repo.ing tab is visible, one bounded request per minute reads the latest indexed finalized DBC trade for the watched canonical markets. A first observation establishes the baseline without notifying. Subsequent price changes compare squared sqrt prices with integer arithmetic, use the selected threshold in either direction, and reset the baseline after notification. The bell menu supports opening the market, marking read, and dismissing. At most 20 alerts are kept; replay of the same event is deduplicated. There is no push, email, background job, or post-graduation DAMM price source in this feature. Missed intermediate moves while the site is closed are not reconstructed; the next observation compares against the stored baseline.
- **Categories:** AI & agents, Developer tools, Infrastructure, Games, and Other use conservative matching against cached repository names/descriptions. Repositories may match multiple categories. The matching is a discovery aid, not a maintainer assertion or token endorsement. Filters retain the existing Trending/New and repository-admin verification options and use shareable URL parameters. No new GitHub requests are added.
- **Presentation:** Existing colors, typography, thin borders, and compact controls remain. Explore uses underlined view tabs and native category/owner selects. Badge menus support outside-click and Escape dismissal. Mobile market rows keep Watch, Trade, stars, volume, and earnings visible without horizontal scrolling. New controls work in both existing color themes.

## Verification

- `node --test tests/discovery-ux.test.mjs tests/market-usability.test.mjs`: **11 passed**. Covers SVG escaping/dust, canonical badge URLs, category overlaps, malformed storage, unwatch cleanup, exact thresholds, invalid/wrong-market price data, and event replay, plus existing market-order and wallet/curve display checks.
- Production build and `git diff --check` passed.
- Real route checks against a disposable localhost PostgreSQL database copied from public production market/fee/trade records: SKILLS had `1,858,920` recorded builder-fee lamports and its badge showed `0.0019 SOL`. Valid badge/price routes returned 200; invalid/unknown badge IDs returned 404; invalid watchlist IDs returned 400.
- Browser checks at desktop and 390px: watch, navigation, reload, persisted alert preference, badge preview/copy confirmation, Escape dismissal, category filtering, and light/dark appearance. Badge panel bounds were x=16..346 at a 390px viewport; no horizontal overflow in checked mobile pages.
- An explicitly local 12.36% price-change fixture triggered one 12.4% notification, Mark all read persisted, and reloading did not duplicate it. No real trade was sent to generate test alerts.

No new dependency, schema migration, worker change, signing key, launch, trade, or payout is needed. Existing production DAMM builder-fee integration and mainnet graduation work remain separate.

## Production release

- Web deployment `019a932e-d842-4654-86dc-592673232299` succeeded on 2026-09-25. Implementation commit: `76a130c`.
- Live `/`, `/explore?category=infra`, `/api/badge/1148788086`, and `/api/watchlist?repos=1148788086` returned HTTP 200. The SVG rendered `0.0019 SOL`; the price endpoint returned the canonical SKILLS mint, indexed sqrt price `18724889876763266`, and trade event `SX9GAQUpdVt3bbrBhj72aSEmCa7D2WqszagjR7DwJ7ZCwFpgknDMGTmne1w49yvRKKWHqjN9d3r4iuCdFpZDXgw:0`.
- The live badge loaded at its intrinsic width of 227px and its Markdown linked to the canonical mint. Watch/reload/unwatch succeeded at 390px; the document remained 390px wide. The existing connected wallet remained connected. The QA watch entry was removed without changing any wallet or submitting a transaction.
- The agent-created browser workspace was closed. The disposable localhost server/database and copied records were stopped and removed after local verification.
