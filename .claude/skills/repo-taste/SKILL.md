---
name: repo-taste
description: Apply repo.ing's deliberate dark, tactile, lightly retro design language to frontend work without breaking financial truth, identity, accessibility, or live functionality. Use for UI design, review, restyle, UX polish, component creation, dashboards, launch screens, and trading screens.
---

# Repo Taste — frontend design skill

This is a product-specific art director and quality gate, NOT a permission to redesign the product or change financial behavior.

## Read first
1. design/repo-taste/CORE.md — portable taste principles and decision order.
2. design/repo-taste/profiles/repoing.md — actual brand, existing code, assets, and design exceptions.
3. design/repo-taste/REVIEW.md — before/after visual and functional acceptance.

For a different product, replace the repo.ing profile with that product's own approved profile. Never carry over Repo Cat or repo.ing's colours automatically.

## Workflow
1. Inventory the route, the user's primary task, real data, existing components, theme tokens, imagery, and responsive behavior. Preserve the current screen in screenshots before editing.
2. State one screen question and one product-specific visual device. Produce a compact change plan naming files and protected flows.
3. Work in the existing Next.js/React/CSS stack. Keep all routes, wallet state machines, onchain read semantics, formatting, API contracts, and claims/trading safeguards intact.
4. Prefer the existing CSS variables and brand assets. Make a screen legible and trustworthy first; retro texture and motion are second-layer accents.
5. Test visible empty, loading, delayed, error, disconnected, and confirmed states without inventing market activity or balances.
6. Inspect actual browser output at 1440, 768, and 390 px, dark and light if supported. Review the screenshots, fix the three largest issues, and repeat up to three rounds.
7. Report what changed, proof collected, remaining defects, and any tests/checks not run.

## Optional upstream skill
If Leonxlnx/taste-skill is installed, use design-taste-frontend as a SECONDARY tool. For real app screens choose its --app workflow and --keep palette,type. Use its browser inspector when possible, and document narrow, intentional exceptions for repo.ing's monospace, grid, borders, soft radii, and existing brand motion. Do not let its generic house rules overwrite this project's identity.

## Stop conditions
Do not claim visual verification without seeing the rendered screenshots. Do not fabricate market numbers, simulate a successful signing flow, alter buy/sell or settlement code as a visual cleanup, or deploy/merge without an explicit task.