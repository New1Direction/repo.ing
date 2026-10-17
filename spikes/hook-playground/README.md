# Hook Playground

An isolated educational simulation for repo.ing, with no runtime dependencies. It is not a route in the production app and imports no app code, SDK, wallet, RPC, or transaction functionality. Everything computes locally. This is a simulation release candidate, not a real launch product or protocol quote engine.

See [the integration plan](INTEGRATION.md) for the exact simulation/plain-recipe boundary, proposed implementation owners, acceptance tests and production blockers. It authorizes no integration or execution.

## Separate metadata export

Open **Scope & assumptions → Start separate plain draft**. The form starts blank and requires explicit acknowledgement that no simulation settings carry over. Review a name (1–32 UTF-8 bytes after trimming) and ticker (1–10 ASCII letters/digits, exported uppercase), then download `hook-plain-metadata-draft.json`. Editing either input or the acknowledgement invalidates the reviewed export. Cancellation and export leave the simulation and its storage unchanged.

The file uses the existing `repo-ing/hook-lab-recipe/1` envelope with `hook-lab/1`, `template: plain` and `blocks: []`. It is metadata authoring, not production intent, a scenario conversion, a custom Hook, or launch approval. No network, mint, wallet, fees or economics are selected. Metadata is not persisted; reopening starts blank. Playground import deliberately rejects this file. `plain-draft.mjs` imports no production module and refuses extra fields, including zero-valued rules. Any future consumer must independently validate the file and bind an approved network/profile and execution contract.

## Run

Requires Node 22 or newer. From this directory: `npm start` (port 4173; override with `PORT`). No install or build is needed to serve. In an Amp orb, use a supervised portal from the repository root:

```sh
amp orb service start hook-playground --cwd "$PWD/spikes/hook-playground" --command 'node server.mjs' --port 4173 --portal --title 'Hook Playground'
```

The server loads a fixed asset allowlist at startup; restart after changes. Do not expose the repository with a generic static file server.

## Verification

From this directory:

```sh
npm ci --ignore-scripts
npm test
npx playwright install chromium webkit --with-deps
npm run test:browser
```

In an orb with preinstalled Chromium, install only WebKit and set `CHROMIUM_PATH` to the existing Chrome binary for `npm run test:browser`. The suite starts its own server on port 4174. It checks price/revenue/guard interactions, incomplete draft reload and backup/import, corrupted storage recovery, simultaneous-tab conflicts, unavailable/quota-limited storage, keyboard dialogs, dependency/empty states, invalid imports, 320–1440px widths, and axe WCAG A/AA rules. Chromium desktop and WebKit with an iPhone profile are approximations, not real-device certification. Manual VoiceOver/TalkBack and real iOS/Android testing remain release checks.

## Draft storage and privacy

One versioned local draft per origin/browser (`repo.ing:hook-playground:draft:1`), including view, selected module, disconnected settings and incomplete edits. It is not cloud storage or a backup; private browsing, eviction, clearing site data, and changing origins can lose it. Download a draft backup before switching hosts. Draft backup JSON is distinct from a runnable scenario and preserves invalid inputs without producing results.

Web Locks serialize writes between tabs, with compare-before-write protection and explicit conflict resolution. Unsupported/blocked storage or locks leave editing usable and offer file backups. Unreadable/future drafts are not overwritten automatically; users can download raw saved data, load the saved version, or explicitly replace it. Clear, reset, import and replacement require confirmation. Reload/close warnings are best-effort browser behavior, not a durability guarantee. No analytics or remote error collection is installed; no input is sent over the network.

## Serving and release boundary

The standalone Node server permits only GET/HEAD on the client asset allowlist and `/healthz`. It rejects source/config paths, traversal and write methods. CSP blocks remote scripts and all fetch/RPC connections; inline styles are permitted for chart progress. Other headers restrict browser permissions, MIME sniffing and referrers. Amp review-widget injection is disabled to keep third-party scripts out of this sandbox.

For an approved release, serve this directory as a **separate origin** behind an HTTPS reverse proxy, with no production secrets or app credentials. Preserve its security and cache headers, enforce request/rate limits at the edge, supervise/restart the Node process, and monitor `/healthz` plus proxy 5xx responses. The app is mounted at `/`, not a production subroute. HTTPS is required for cross-tab Web Locks outside localhost. No database or migration is required.

Release procedure: run both test commands, smoke-test through the actual HTTPS host (draft save/reload, import, download, mobile controls and CSP), then switch traffic to the approved immutable build. Roll back to the prior build if health or smoke checks fail. Keep the v1 draft schema stable; incompatible future schemas must preserve old data and offer download, never silently reset it. Production hosting, domain/TLS, edge limits, monitoring, and deployment are not provisioned by this prototype and require separate authorization.

## Interaction contract

- Add or select modules from the library or canvas. Connecting requires the visible parent: curve → fees → treasury → governance; curve → graduation and safety. Disconnect removes descendants but retains their inputs. Layout is fixed and keyboard/touch-operable, not drag-and-drop or arbitrary wiring.
- Beginner explains each field. Expert adds model parameters and numerical breakdowns, not extra execution permissions.
- Changes update price, revenue routing, hypothetical first-buyer exit, graduation progress, and qualitative risk. Invalid values suppress results instead of showing stale numbers.
- Empty canvas, missing dependencies, blocked buyers, invalid numbers, invalid/unsupported imports, graduation completion, and custom-hook boundaries are explicit states.
- Narrow screens stack library, canvas, inspector, and simulation. Selecting a module scrolls its inspector into view. Escape closes native dialogs and restores focus.

## Model and boundaries

See `model.mjs` and the in-app “Read the model” dialog. Constant product with 1B virtual tokens, an adjustable virtual quote reserve, 1% hypothetical protocol fee, and an optional illustrative trading fee. Inputs and defaults are educational, not recommendations or actual Hook economics. Cumulative buy demand includes the first buyer and stops at the optional net graduation target. The buyer exits against final reserves immediately before graduation, including sell fees and price impact. When the buyer is blocked, aggregate demand represents other permitted buys and no personal outcome is displayed. Treasury locks and governance delays affect disclosures, never invented market returns.

No simulation of sniper fees, gas/rent, network behavior, real allocations, migration, post-graduation markets, adversarial trading, or arbitrary custom hooks. Fee splitting, treasury routing/locks, governance and purchase guards are **concept-only**, not enabled plain-Hook features. The `repoing-playground/1` export is deliberately incompatible with production recipes.

Brand provenance: the cat is an exact copy of `public/brand-cat.webp`; palette, system sans, mint accent, controls and wordmark follow `app/globals.css`, `app/theme.css`, and `app/components/brand-mark.jsx`. The standalone asset copy avoids serving or importing production code. Scope is grounded in `docs/HOOK_LAB_TEMPLATES.md` and `docs/HOOK_LAB_FRESH_PLAIN.md`.

Before real-launch integration: approve capabilities against the current SDK, replace the educational model with independently verified economics, complete security/accessibility review, and separately authorize integration. Nothing here enables a chain action.
