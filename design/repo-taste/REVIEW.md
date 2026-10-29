# Repo Taste — review and release gate

Treat screenshots and real user flows as evidence, not embellishment. This check is for UI changes; engineering changes still require the project's domain-specific tests.

## Before writing code

- Record the baseline route and files, screenshot it at 1440, 768 and 390 px where a browser is available.
- Verify desktop and mobile in the project's supported dark and light themes.
- State the screen's single main question, the one user action, and the one product-specific visual device.
- Identify every data source, special status, identity asset and protected flow touched.

## After the change

1. **Visual:** balanced outside margins, legible contrast, single visual focal point, aligned table numbers, consistent radii, no accidental whitespace bands, no clipped titles, no document-level sideways scrolling at 390.
2. **Product identity:** exact approved Repo Cat asset and image proportions, brand typography and colour roles, unique repo/market context, deliberate subtle motion/retro detail rather than generic dashboard slop.
3. **Data truth:** real vs estimated, zero vs missing, confirmed vs finalized vs pending, SOL vs USD units, token supply and prices, earned vs claimed vs available, repo owner verification, actual time period and freshness. A UI adjustment must not alter these.
4. **Interaction:** primary action reachable by keyboard and thumb, input labels and focus, active/disabled/hover/press states, responsive menus, back/forward navigation. Do not trigger live trades or signing while testing cosmetics.
5. **Adverse states:** empty search, no trades, loading and delayed data, quote retry, disconnected wallet, invalid amount, expired estimate, a failed request, and a previously submitted transaction awaiting status.
6. **Accessibility:** semantic headers, labels, keyboard focus, reduced motion, alternative text where needed and screen-reader descriptions for nontextual charts/progress.
7. **Preservation:** original navigation, working controls, API output semantics, chart evidence and transaction safeguards remain unchanged. Run existing relevant tests and a production build when the environment permits.

## Taste Skill integration

When installed, choose the --app mode for the screens people work in. Run its static lint and browser inspector with --app, using --keep palette,type when choosing a style. Exceptions to upstream generic bans (monospace, hairlines, subtle glow, grid, existing gradient, approved rounded buttons) must be identified narrowly. Never turn off all checks or change project identity just to make a validator pass.

If browser access, the server or dependencies are unavailable, run the tests you can and explicitly report missing screenshots; do not invent a score or call the review complete.

## Outcome format

- **Route / objective:** what screen and job were improved.
- **Before:** baseline screenshot paths or a clear "not captured" note.
- **Changed files:** exact paths, and scope of the changes.
- **After:** screenshot paths at 1440/768/390, both themes where relevant.
- **Findings:** biggest three issues fixed and remaining limitations.
- **Verified:** real commands and test outcomes only; separate unrun steps.
- **Protected flows:** confirmation that quotes, financial semantics, signing, claims, routes and permission boundaries were not modified.

## Release standard

No broken mobile navigation, truncated critical value, misleading balance/fee state, unresponsive primary action, unintended transaction change, or unreviewed brand replacement. Obtain explicit approval before deploying or merging a visual change into live production.