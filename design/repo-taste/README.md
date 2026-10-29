# Repo Taste

A reusable art-direction and UI-verification system, starting with repo.ing. It encodes the difference between **our intended aesthetic** and any coding model's default UI preferences. This is documentation and agent guidance; it does not modify the running site.

## The idea

**Soft controls. Sharp information. A little old-internet magic.**

Build interfaces that feel authored and alive without making financial facts hard to read. The mascot, type, rhythm, and tiny tactile interactions make the product recognisable; users still get a clear answer, clear status, and a safe next action.

## Contents

- CORE.md — portable decisions, brand inheritance, interaction and content rules.
- profiles/repoing.md — repo.ing's current design assets, colours, type, route-specific direction, and non-negotiables.
- tokens/repoing.css — opt-in reference aliases for existing token names; NOT imported into the site.
- REVIEW.md — browser, accessibility, data-truth and interaction quality gates.
- BRIEF.md — reusable prompt for a design task and a blank project-profile starter.
- .agents/skills/repo-taste/SKILL.md — Codex/agent entry point.
- .claude/skills/repo-taste/SKILL.md — Claude Code entry point.

## Use

In the repo root, ask Codex to **use repo-taste to audit and polish /explore**, or ask Claude Code **/repo-taste audit and polish /explore**. Scope one route or component at a time. The skill first records the original, inventories the real data and assets, edits minimally, then verifies the rendered result at three widths.

If the upstream Taste Skill is also installed, its --app draw and inspector can supply composition options and automated browser checks. Its general anti-slop bans are NOT higher priority than the repo.ing profile. Preserve sanctioned monospace, borders, soft interactions and existing brand textures; justify exceptions individually.

This first version intentionally ships **design instructions only**, not a site redesign. There are no claims of completed browser screenshots or changed production UI.

## Port to another project

Copy CORE.md and REVIEW.md, then create a project-specific profile documenting the real UI, current files, palette, fonts, art assets, permitted style and forbidden changes. Copy one or both skill entry points and update the profile path. Do not copy Repo Cat, colours or token values into FYNCH/Colony/Burrow unless they belong to that brand.

## Precedence

Financial and security correctness > real data and accessibility > established brand identity > the task brief > optional taste-skill defaults. An attractive screenshot never justifies changing account state, prices, fees, trade preflight, signatures, or consent.