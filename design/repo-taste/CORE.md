# Portable taste principles

## Working definition

An excellent interface feels specific to the thing it serves. Avoid the generic recipe of centered hero + pills + icon cards + lavender glow, but also avoid replacing it with empty minimalism. Each screen must contain the product's actual subject, task, and evidence.

## The six laws

### 1. One job is dominant
Write one sentence before building: **The visitor came here to [job] and needs to know [fact] before taking [action].** The largest visual element answers that sentence. Secondary blocks answer distinct follow-up questions. No repeated dashboard KPI cards merely to occupy space.

### 2. Authenticity beats decoration
Inventory 8–12 objects, constraints, people, numbers, product rituals, and image assets unique to the project. Use these to design a visual device that a competitor could not simply rebrand. Render real product data where available; clearly label fixtures in local-only mockups. Never invent customers, onchain numbers, returns, volume, badges, quotes, or signing success.

### 3. Three visual brightness tiers
Keep a ground, raised/active surfaces, and primary ink hierarchy. A single action colour should indicate the next move. Status colours must express actual meaning (success, warning, danger), not decorate unrelated cards. Secondary copy stays readable. Support a project's existing light theme when it has one.

### 4. Tactile, not noisy
Offer small satisfying press/hover/focus feedback, rounded hit targets where brand-approved, and a cohesive easing curve. Pixel/CRT/dither treatment is permitted on a mascot, illustration, poster, easter egg, or restrained background. Never put scanlines or texture over figures, charts, labels, input fields, warnings, or wallet consent. No infinite bounce on a primary decision control.

### 5. Characters have identity
Use approved source artwork, with fixed anatomy, face, silhouette, proportions, crop and colours. Do not generate a new mascot because a placeholder is missing. Do not add fingers or humanlike hands to a brand character whose approved references lack them. Prioritise supplied images over SVG caricatures or generic emoji. Respect asset/licence provenance.

### 6. Inspect the thing people use
At desktop and phone widths, verify real content, overflow, contrast, focus, states and primary action reachability. Beautiful code with a broken render fails. Three screenshot-led improvement rounds maximum, largest defects first.

## Design primitives

- **Typography:** One strong headline voice plus one readable utility/data voice. Monospace is encouraged for actual identifiers, code, tabular numbers, and brands that deliberately use it; don't let decorative tracking shrink essential figures. Aim for visibly different primary/secondary levels, not six near-identical sizes.
- **Spacing:** Consistent outer edges. Dense screens stay dense when the task needs scanning. Avoid accidental gaps, orphan cards and giant blank areas. Compact tables need aligned figures, adequate row targets, headers and a mobile alternative.
- **Forms and actions:** One clear primary action. Keep labels near their controls, real errors near their fields, confirmation states distinct, and dangerous decisions reversible or clearly gated when the product supports it.
- **Charts:** No ornamental invented lines. Preserve units, time ranges, source freshness, empty history, uncertainty and accessible tabular or textual alternatives. Data takes priority over colour effects.
- **Motion:** Transform/opacity first; provide prefers-reduced-motion behavior and static fallbacks. No motion that hides content if JavaScript fails or changes transaction meaning.
- **Responsive:** Compose for 1440, 768 and 390 px; no sideways document scroll, tiny chart labels, cut-off balances or inaccessible wallet actions.
- **Copy:** Plain, specific, short and evidence-led. Do not imply endorsement of community-launched markets, guaranteed fees, or that a user has signed before a confirmed result.

## Decision sequence for agents

1. Inventory the route, source code, task, actual available assets, and states.
2. State one screen question and one uniquely owned art-direction idea.
3. Identify existing patterns and choose what to keep.
4. Draft a restrained change plan showing exact affected files and protected flows.
5. Implement the smallest cohesive set of changes within the existing stack.
6. Run relevant tests and inspect real screenshots.
7. Fix the three largest user-visible issues; report evidence, not confidence adjectives.

## Never as a side effect of visual work

No migrations, key/credential changes, wallet provider rewrites, balance aggregation changes, price calculation changes, quote/fee/slippage changes, fee withdrawal or buyback automation, transaction submission, custody, live deploy, or main-branch merge. Those require a separately scoped engineering task and its own proof.