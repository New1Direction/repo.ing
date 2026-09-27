# Repository search and optional Jev matching

September 27, 2026. User-approved scope extension advancing repository resolution and explicit launch. No trading agent, new economics, automated market approval, or wallet authority.

## Experience

`/find-repos` offers one search input, three example searches, **All repos / No market yet / Live markets**, and an activity selector. Repository cards show GitHub stars/forks, measured star changes, checked age, current market state, and expandable original trend evidence. The list covers up to 48 fresh, verified, positive-score tracked candidates, instead of only five. It is not a full GitHub search engine.

Pasting `owner/repo` or a GitHub URL bypasses AI and calls the existing `/api/resolve` path. Existing markets open their market page; other resolved repositories open the ordinary launch form. Approved trend cards retain `/launch/<id>?from=trend` and all existing approval/config/identity guards. Other cards link to GitHub. Search cannot approve, launch, trade, bind, or claim.

Clear, empty/error/loading states, keyboard-accessible controls, URL-preserved query, theme tokens, and mobile layout are included. Editing/cancelling a pending search ignores its late response. Switching filters is instantaneous; they are disabled during a pending interpretation so a response cannot overwrite a new filter choice.

## Data and trust

`src/public-trends.mjs` shares the existing public projection with growth surfaces. It excludes stale (>6 hours), future, rejected, errored, and invalid-identity candidates; removes private notes and operator IDs; and links a market only with confirmed/indexed/finalized evidence. Pending markets are not called unlaunched. Current active config must match for the reviewed launch shortcut.

`app/lib/repo-discovery.mjs` reads trends without querying the discoverer and earnings ledgers. Concurrent requests share a 15-second public snapshot; freshness is rechecked on read. The visible tab refreshes every minute and expires old observations locally. Search interpretations never override fresh market state, canonical identity, source observations, score, or order. Existing launch guards revalidate identity/approval before a wallet signature.

## Jev integration

The web-only `REPO_SMART_SEARCH_ENABLED=true` plus `TYPESAFE_API_KEY` enable TypeSafe's official `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`. The native fetch adapter avoids a new runtime dependency. See [API](https://docs.typesafe.ai/api) and [confidence](https://docs.typesafe.ai/confidence).

One request contains bounded search text and only public repository names/descriptions. Typed choices interpret supported scope, market existence, one activity requirement, and topic relevance for each supplied candidate. It does not generate repository IDs, URLs, prose, financial facts, or trend scores. Code applies market and activity conditions and preserves deterministic trend order. Uncertain/unsupported requests produce a request to narrow the search. Invalid responses, timeout, missing key, and usage limits use explicitly labeled keyword matching; filters remain available.

Controls:

- At most 180 query characters, 2 KB request body, 48 candidates, 600 description characters per candidate.
- Fixed HTTPS endpoint, no redirects, 4-second timeout, no automatic retries, bounded 128 KB response.
- Enumerated choices and probability distributions validated. Selected probability ≥0.8 and confidence ≥0.65; these are starting thresholds, not evidence of correctness on all searches.
- At most two simultaneous model requests, 12 calls/minute and 500/day **per web process**. A 60-second cooldown follows errors. Up to 128 hashed interpretation cache entries expire in five minutes. Identical concurrent requests are shared.
- These are process limits, reset on restart, and multiply with replicas; use the provider's account spending controls for an account-wide budget. They are not a durable billing cap.
- POST requires the configured same origin; this is a browser abuse guard, not authentication. All data is public and read-only.
- UI discloses TypeSafe processing when enabled. No wallet/session data or credentials are sent as model context; no search text/provider errors are logged by the integration. API keys never go into client props or a `NEXT_PUBLIC_` variable.

## Activation and rollback

At implementation time, both the local Jev key value and Railway web key were absent. **Jev remains disabled and its live response quality has not been verified.** Keyword search and filters are independently usable.

To activate: save `TYPESAFE_API_KEY` in Railway **web** secret variables, exercise several public fixture queries through the adapter and inspect relevance/filters/latency, then deploy web with `REPO_SMART_SEARCH_ENABLED=true`. Confirm browser disclosure and error fallback. Keep the key out of chat and Git. Disable only this flag to return to ordinary search. No worker, database migration, financial gate or signing key change is required.

## Verification

- 14 focused search/trend checks: public projection, finality/pending/approval restrictions, input bounds, keyword/activity filters, conservative model interpretation, original sort order, response validation, shared request/cache behavior, stale market rebinding, disabled/failure/budget fallback, and streamed body bounds.
- Local HTTP checks on isolated `repoing_search_test`: public feed/search 200, keyword spreadsheet match, recent-release filter, oversized query 400, cross-origin POST 403.
- Desktop 1440px and mobile 390px, dark/light, actual search/clear/filter/empty states. Mobile document width equals viewport width. Fixtures use copied public descriptions and synthetic local observations only.
- Production build passed. Live Jev requests and semantic quality remain unverified until a key is supplied. No transaction or production fixture was created.

Deployment evidence is recorded below after production verification.

## Production rollout

- Implementation `a46f67d`, pushed to private `New1Direction/repoing` on main and the existing work branch.
- Railway web `e06ff178-0dfa-4d53-966c-f53da88d2a9d`, created `2026-09-27T14:49:19.247Z`, reached **SUCCESS**. No migration, worker deployment, or economic setting changes.
- Public API returned 18 fresh candidates with no operator fields. Spreadsheet search matched `dream-num/univer`; gaining-stars returned 12 candidates with actual positive measured deltas. No currently fresh tracked candidates had live markets, and that filter correctly returned empty. These counts are dated observations, not fixed application values.
- Three sequential live endpoint requests returned 200 in approximately 113–299 ms from the test machine. This is a small smoke check, not a load test or latency guarantee.
- Real browser search, query URL, desktop/mobile controls passed. At 390px, document width was exactly 390px. Entering `New1Direction/OntologyEX` opened its existing mint `3tcPoGD2xeZEkLYr3yMqtZxNQF5iThhsDjZ7u7TkJoSF`; no launch or transaction occurred.
- Synthetic delayed-response browser check confirmed loading feedback, disabled filters while pending, and rejection of an old response after editing the input.
- Server API/key references were absent from the client JavaScript output. Focused source secret checks and `git diff --check` passed. Temporary local app/database processes and the QA browser tab were closed.
- **Natural-language Jev matching remains disabled.** The key was absent in Railway web and empty in the installed local Jev configuration. Provider responses were exercised with fixtures only; activation still requires a real key and live semantic checks.
