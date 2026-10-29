# Product profile: repo.ing

Status: v1 profile, grounded in the public repository's existing code and assets as inspected on 2026-10-28. This is an art-direction specification, not proof of a production screenshot inspection.

## Identity

**repo.ing — the market layer for open source.** A canonical market for each eligible public GitHub repository; trading supports builders. Product feeling: a developer's trading terminal that grew a friendly cat. It should be credible for prices and signing, but lightly odd, tactile, and unmistakably a piece of the old internet.

Brand motto for design: **Soft controls. Sharp information.** Roughness lives around the product, never between the user and money.

## Existing source of truth (do not fork unnecessarily)

- app/globals.css defines the dark CSS tokens: --bg #101213, --surface #17191b, --surface2 #1c1f21, --border #32373a, --border-strong #464d52, --text #f4f6fa, --muted #aeb6c1, --dim #7f8892, --green #81e6ad, --green-dark #63d997 and --red #f28485.
- app/theme.css defines the existing light palette under :root[data-theme=light], including --bg #f7f9f7, --surface #fff, --green #2ec47c, --text #19221c. Light mode is an existing feature; preserve it and the theme toggle.
- app/home-fonts.js loads Archivo Black for display and JetBrains Mono for labels/numbers on the home page via next/font; app/home.css consumes --font-display and --font-mono. The base app body otherwise uses the existing system sans stack. Do not force a global font migration.
- app/home.css defines the hero, live $REPOING card, grid, proof strip, ticker and motion. It already uses gradients, subtle glow, hairlines and monospace deliberately. These are APPROVED brand exceptions to upstream Taste Skill's generic page bans.
- app/trade-panel.css defines actual trade field styles, buy/sell states, quote details and 52px trade submit. Preserve their semantics.
- app/components/ui.jsx owns shared nav, market rows, financial labels, official-market link and wallet header. app/components/brand-mark.jsx renders the pre-cropped cat from /brand-cat.webp.
- app/components/root-document.jsx imports the existing style layers and wallet providers. Avoid introducing a parallel global styling system.
- docs/CHARTS_AND_RESPONSIVENESS.md describes chart evidence/freshness, absent candles, accessibility, transaction states and explicit mobile checks. Treat it as an essential visual acceptance document.

## Approved identity assets already present

- /public/brand-cat.webp — current header mark and official token navigation icon. Preserve source, placement and aspect ratio.
- /public/gitcat.png — existing large-format brand art.
- /public/credits/repocat-512.png — existing Repo Cat image; check the intended variant against latest art references before changing or repurposing it.
- /public/art/*.webp and /public/launch-icons/*.webp — existing narrative illustrations; use sparingly where they explain an action.
- /public/badges/new.webp — current bespoke new badge.

The source images are identifiers, NOT permission to stylize them. If a newer approved turn-around/tail Repo Cat reference exists, request or locate the exact asset before replacing existing artwork. Do not substitute a round ball-shaped cat or synthetic hand illustration.

## Route-specific direction

### Home (public-facing explanation)
Archivo Black and mono accents are appropriate. Keep the functional repo lookup and live $REPOING fragment as the true hero; the central promise must read in five seconds. Art or texture is atmospheric and outside data/CTA hit targets. Use the page workflow of upstream Taste Skill only for marketing sections; live market fragments are app UI.

### Explore (/explore and discovery lists)
This is a working application, not a marketing page. Make search, filtering, repository identity, ticker, cap, volume, builders' earnings and Trade action rapidly scannable. Money/volume values align to a consistent edge. Preserve status provenance, including unverified/official distinctions. On phones use a deliberate compact layout, not an impossible horizontally clipped table.

### Market (/token/[mint])
Chart plus trade panel is the main event. Visually distinguish finalized and confirming data, unavailable values, price/estimated market cap, DBC vs DAMM history, token amounts and USD estimates. A zero is not a missing value. An estimate is not a historical fact. Preserve range controls and keyboard access, and do not bury slippage/fees behind decoration.

### Launch (/launch and launch review)
A short step-by-step flow: repository lookup -> immutable identity -> token image/cost preview -> wallet review/signing. Clarify community launch vs owner endorsement. Nothing looks successful until actually confirmed. Never casually change initial buy, quote, supply or signing flows.

### Builders/claims and operations
Evidence-led: who owns what, what is available to claim, what is verified, what is pending, what cannot be acted on. Low decoration, high traceability. Do not make back-office operator tools look like a public CTA.

## Visual direction

- **90% trusted finance app; 10% carefully placed retro weirdness.** Do not turn dense trading screens into full-screen CRT art.
- Prefer one distinctive product object per screen: GitHub repo name/commit strip, graduation progress, real fee record, or Repo Cat artwork. Not generic neon icon cards.
- Soft small and medium radii in controls are intentional. Keep hierarchy between the large hero, measured numeric data, utility labels and muted metadata.
- Mint green communicates primary buy/positive/action where appropriate. Red is a trade side/warning when semantics require it. Amber is for meaningful caution/status. Never communicate buy/sell solely by colour.
- Stick to the current product's dual themes. No blanket ban on grid lines, hairlines, glows or monospace if already part of repo.ing. Use these with intent, not everywhere.
- No floating unrelated stickers or invented mascot anatomy in transaction surfaces.

## Prototype vs live

Local fixtures are permitted to test empty/loading/error flows if clearly marked and never connected to production/API code. Do not introduce promotional "example earnings" into real market tables. Do not screenshot account secrets, wallets, or privileged operator controls. No real signing for design validation.

## To improve next, after approval

Audit /explore first for density and phone composition, then the market chart/trade hierarchy, then the launch review clarity. Do each as a small before/after change with proof; do not overhaul every route in one pass.