# Where finished work lives

Read this, and the Hooks rollout doc it points to, before calling anything missing. Paths are relative to the owner's home
directory on the build Mac; nothing here is a secret.

## repo.ing (this repository)

| Work | Where |
| --- | --- |
| Self-serve Hooks site (independent stack, ships OFF) | Merged into main: `ba96aac` (release), `30ae808` (site work), `615a41b` (acceptance). Branches `feat/hooks-self-serve`, `e2e/hooks-self-serve`, `rc/hooks-self-serve` |
| Hooks worker branches | `~/Documents/ChatGPT/repoing-hooks-local` worktree and its `.claude/worktrees/*` (trade scope, graduation, coin activity, USD pricing) |
| Group (bundle) launches | `src/bundles.mjs`, `src/bundle-launch.mjs`, `/api/bundles`, `docs/BUNDLE_LAUNCH.md`; review-only recovered config `cf88db9` |
| Recovery, claims, DBC configs, charts | Branch `fix/chart-writer-20261025` (this checkout) |
| Creator-selected third-party hooks (do not ship) | Branch `repair/creator-selected-hooks`; risk note kept with the owner's records |

## Hook programs (hook-lab, private)

| Work | Where |
| --- | --- |
| Deployed independent stack | `release/independent-real-keys` @ `89d060b` (build server private clone) |
| Zero-fee open route (deployed 2026-10-26) | `fix/gate-route-continuous-fee` (`ffeff18` + test updates), built on `89d060b` |
| Native SOL, open creation | `feat/native-sol`, `feat/open-creation`, `feat/independent-stack` |

## Owner records (not in git)

| Record | Where |
| --- | --- |
| Hooks handoff and decisions | `~/Documents/ChatGPT/hooks-local-state/HANDOFF.md` |
| Hooks release rollout (Oct 19) | `~/Documents/ChatGPT/hooks-local-state/RELEASE-ROLLOUT.md` |
| Step 8 (stack setup) signing sheet | `~/Documents/ChatGPT/hooks-local-state/STEP8-SETUP-SIGNING.md` |
| Deploy kits, ELFs, evidence | `~/Documents/ChatGPT/hooks-local-state/independent-*` |
| Program rollback binaries | `~/Documents/ChatGPT/hooks-local-state/mainnet-rollback-*` |
| Owner driver config and run journal | `~/.hooklab-owner/` |
| Restoration status (private) | `STATUS.private.md` in this checkout (git-ignored) |
| Amp threads | The Amp thread IDs are recorded in the commits' `Amp-Thread-ID` trailers |
