# Native Neurons preview

Implemented on `feature/neuron-launch-integration` in an isolated repo.ing
worktree. Delivery is limited to this feature branch; it is not merged into main
or deployed to production.
The financial roadmap remains in [the integration plan](NEURON_INTEGRATION_PLAN.md).

Update: opt-in server-backed publishing is now implemented separately. See
[publishing setup, moderation and limits](NEURON_PUBLISHING.md). The no-config
local preview described below still works when publishing is disabled.

## Run and review

Use Node 22 and `npm ci`, then `npm run dev` (port 3001). No database, RPC,
signer, GPU, paid API or model configuration is needed for these routes:

- `/neurons`: six curated source cards plus approved community characters when
  publishing is configured. Community appears first, with creator attribution,
  content-review labels and a link to the source personality. Search names,
  `$tickers`, stories, creator wallets, tags and source DNA such as `9:166`;
  combine collection/category filters and sort by name or newest community first.
  Counts reflect both collections. Empty results, no community profiles yet and
  community outages have distinct recovery states; source browsing stays usable
  during a publishing outage. No popularity or market activity is invented.
- `/neurons/new?persona=crab`: personality → identity → review → local draft.
  The preview requires explicit confirmation and never prepares a transaction.
- `/neurons/coffee-bean`: chart/chat workspace, keyboard/pointer width slider,
  fixed scripted replies, source DNA, proposed earnings policy and non-executable
  buy/sell forms. Profiles have a personality-accented identity header and a
  primary Start chatting action that focuses and scrolls to the conversation.
  Desktop keeps chart left/chat right; narrow screens put chat first.
  Published profiles show creator/review/source attribution, share their stable
  public URL, and expose the full creator wallet and metadata hash under About →
  Publication details. Create similar reuses the source recipe, not the creator's
  identity. Unknown persona IDs return 404.
- Explore's shared navigation links to Neurons; existing markets are unchanged.

To review the complete flow, select a card, create with that persona, customize
the name/ticker/story, review and confirm the local-only disclosure, then open
the saved character. Reload to check persistence. Send three messages to reach
the scripted preview limit; reset starts a fresh local conversation.

Only one draft is retained in this browser, using `repoing-neuron-preview-v1`.
Drafts and messages are not published or sent to a server. Share copies the base
persona URL, not the private draft. Preview replies are a small, manually reviewed
allowlist and do not use or echo the user's input to generate content. This is
not a live model, server-enforced quota, public content-moderation system or
evaluation result. It is not proof of financial integration or activation steering.

## Data and boundaries

`app/lib/neurons-preview.mjs` credits the upstream Qwen library and records the
companion app's CSV SHA-256. Six recipe identities/directions/strengths are
transcribed from that import; descriptions, greetings and fixed replies are new
preview copy. No external artwork was copied: icons use platform emoji/text and
CSS. Upstream commercial reuse terms still require review; an import is not a
license or endorsement. The full 200-persona store is not integrated here yet.

The proposed 65/35 split is shown only as product copy. No fee rate, fee recipient,
mint, pool, custody authority, trade, claim, buyback or monetary balance is created.
The new components do not import financial clients or call launch/trade APIs.
Never connect this browser draft to a live launcher without server-side identity,
moderation, wallet authorization, fixed terms and finality/recovery verification.

## Verification, 2026-10-28

- `npm exec --package=node@22 -- npm run build`: production build passed on
  Node 22.23.4, including all three Neurons routes.
- `node --test tests/neurons-preview.test.mjs`: four tests for library discovery,
  bounded/non-authoritative drafts, preview disclosures/disabled execution and
  selected-recipe launch handoff. No database, network, signer or paid call.
- `node scripts/ci/run-quick-tests.mjs`: 3,011 tests, 2,468 passed, 543 skipped,
  zero failures. Service-backed cases intentionally remain unexecuted. This broad
  run used the orb's Node 26; the production build used supported Node 22.
- Initial quick run failed an existing stock-readiness stderr assertion because
  install scripts were skipped and bigint-buffer printed a missing-native-binding
  warning. `npm rebuild bigint-buffer --foreground-scripts` built the dependency;
  the same test and the full suite then passed without source/test workarounds.
- Browser: source search, combined category/empty state/reset, complete draft
  creation and reload, three-message cap/reset, keyboard width change (44%→58%),
  buy/sell modes, details panels, and narrow viewport overflow checks.
- Screenshots and a real-pointer interaction recording are captured in the source
  Neuron Characters thread's `.amp/in/artifacts/` for review, not committed here.

## Discovery polish verification, 2026-10-29

- Node 22 `npm run build`: production build passed.
- `NEURONS_TEST_DATABASE_URL=postgresql://user@127.0.0.1/repoing_neurons_publishing_test npm run test:neurons:release`:
  68 tests passed, zero failed or skipped. The database is disposable and local.
  Discovery coverage checks asymmetric community/source matches, creator/story/
  ticker search, category intersections, ordering, counts and empty/outage states.
- Chromium: Community → search Tide → open the approved Tide Club fixture reaches
  its stable profile URL and character chat. No extra public fixtures were added.
- Inspected default, community-only, no-match and 390px-wide layouts. The narrow
  layout has no horizontal overflow and uses a 16px search input; this is Chromium
  viewport testing, not a real-phone/Safari test.
- An isolated local instance with deliberately incomplete publishing configuration
  rendered the unavailable notice and retry button while retaining all six source
  cards. It was stopped after inspection; the main preview was not reconfigured.
- A real-pointer recording covers discovery filtering, not profile arrival.
  Screenshots/recording remain review artifacts, not production deployment proof.

## Character profile polish verification, 2026-10-29

- Node 22 production build passed. The same database-backed release command above
  passed 69 tests, with zero failures or skips. Added interaction coverage checks
  composer focus, public-identity sharing despite a conflicting private draft,
  all three fixed replies, the preview limit and reset. Public metadata remains
  escaped and available without claiming model validation.
- Chromium verified the approved Tide Club profile, Start chatting focus/scroll,
  successful clipboard feedback, Enter-to-send, three-reply exhaustion, reset,
  expanded publication details and Source DNA. Trading remains disabled.
- At 390px, the complete 560px chat panel fits after Start chatting; chat appears
  before the market and page width equals viewport width. Source-persona and
  maximum-length private-draft identities also fit without horizontal overflow.
  These are Chromium viewport checks, not real-device or Safari certification.
- Inspected screenshots and a real-pointer opening/composing recording are local
  review artifacts. No model calls, deployment or financial execution was enabled.

## Before public release

The initial audit above is historical. Patched direct dependencies, current
audit results and legacy-SDK dependency replacements are recorded in
[the security evidence](NEURON_SECURITY.md). Bot protection is implemented but
requires real Turnstile keys and an authenticated rate-limiting proxy before
public activation; see [publishing setup](NEURON_PUBLISHING.md).

The registry now supports authenticated off-chain submissions, human review and
approved public profiles. Live generated chat/automated moderation, wallet-bound
token launches, indexed trading, claims and the 35% buyback reserve/executor
remain unimplemented here. Their approval and proof gates are in the integration
plan. Preview access through an Amp portal may require the reviewer's Amp
permissions; it is not a public production deployment.
