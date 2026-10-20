# Nongate acceptance (local only)

```sh
HOOKS_E2E_MODES=selected-hook HOOKS_E2E_KEEP=1 \
  node scripts/e2e/hooks-native-stack.mjs test
```

This is a separate suite, not the `self-serve` max-wallet regression. Run that
regression separately with `HOOKS_E2E_MODES=self-serve`. Neither run constitutes
production approval. Keep the production selected-hook refusal until the actual
selected suite passes and the deployment is separately reviewed.

`selected-fixture.mjs` reads only named ELF artifacts and public IDs/IDLs from the
repair contracts checkout. Launch/swap come from
`target/selected-hook-upgrade-candidate`; the compatibility token, gate and
test-only `hook_tester` come from the preserved `.amp/in/elf-deployed-token`.
All five ELF hashes are pinned in the fixture. No archive, real keypair, custody
export, production RPC, source upload or source publication is used. Public program IDs
are reused on a fresh loopback validator; **all signing identities are synthetic**.
The descriptor is deliberately `placeholder`, never an owner-reviewed release.

The nongate is `FbAuVaTqVPzs43KdsQE8ByfbMJdRFABanya3fuEVjdRM`, flags `3`
(before/after transfer). Its default test script returns no token fees; the suite
requires real callback invocation and increased on-chain script counters. That
does not prove support for arbitrary token-fee hooks. The hook program itself is
immutable; its public test script remains creator-controlled, as its source says.

Agave 4.0.1's `--upgradeable-program ... none` produces
`Some(SystemProgram)` rather than Borsh `None`. The acceptance validator therefore
loads exact loader-owned program/ProgramData genesis rows with the actual `None`
tag, and checks the bytes through RPC before any app flow. This is synthetic
genesis, not evidence of a production deployment/finalization.

## Application integration contract

Only this mode passes `HOOK_LOCAL_SELECTED_HOOKS_ENABLED=true` and
`HOOK_LOCAL_SELECTED_HOOK_PIN_JSON={program,elfSha256,elfLength}`. The bootstrap
must enforce local acceptance, loopback endpoints and non-mainnet genesis before
mapping them to `selectedHooksEnabled` and `config.selectedHookPin`. Client input
is never a pin source. The existing production guard is not removed by this harness.

The creator UI reserves a mint and returns `SELECTED_HOOK_REGISTRY_REQUIRED`
without signing. The suite initializes that mint's registry using the test hook's
**own public** `init_script` interface with the synthetic creator, then retries
the same app reservation. This external hook-specific handoff is intentional:
no owner/control API builds or submits the app preparation or launch. The UI must
show an exact selected-hook transaction review and require separate Continue
consent for preparation and launch, followed by actual wallet signatures.

The ordered suite checks browser launch, buy/sell, reload, server restart,
graduation, postgraduation trading, receipt-summed creator claim, and tamper
refusals. It stops on the first failure; skipped downstream cases are **unverified**.
`HOOKS_E2E_KEEP=1` preserves the disposable stack root and logs, while teardown
stops processes and drops the database. Preserve the e2e report before another run
overwrites `tests/e2e/hooks-native/.e2e/report.json`.

## Executed evidence, 2026-10-20

- Full selected lifecycle: **7 passed, 0 failed**, repeated in runs 14 and 15.
  Run 15: 707.89 seconds, `.amp/in/artifacts/selected-hook-acceptance-15-suite.log`
  and `selected-hook-acceptance-15-report.json`. Includes real creator and platform
  claims and callback counters, not merely page navigation or fake receipts.
- Independent substituted-message/stale-review acceptance: **2 passed, 0 failed**,
  `selected-hook-revalidation-final.log` / `selected-hook-revalidation-final-report.json`.
  Real guardian pause changes the creation-control pin. Cleanup reopens and recollects
  the local operator dossier; a stale dossier correctly refuses the next preparation.
- Gate browser regression: **12 passed**, `self-serve-application.log`. This is
  retained regression evidence only, never selected-hook completion evidence.
- Final selected/UI/metadata/serializer suites: **168 passed, 0 failed, 0 skipped**,
  `selected-final-commit-verification.tap`, with disposable PostgreSQL on 55432.
- Full hooks release run: **1,342 passed, 0 failed, 4 skipped**, 1,346 total,
  `selected-complete-release-check/`. Its wrapper correctly returned failure.
  Every skipped case was then executed successfully: **12 passed, 0 failed,
  0 skipped**, `selected-closed-release-skips/` (`RESULT: PASS`). These are separate
  runs, not a claim that the original monolithic wrapper returned green.

The two frozen curve examples were recovered by building the checked-in app harnesses
against allowlisted Cargo/Rust source exported locally from preserved Hook Lab commit
`f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32`. The original checkout was not modified.
`repoing_curve_parity` used host Rust 1.95.0; LiteSVM/Agave 4.3.0 requires host Rust
1.97.1, already installed, for `repoing_curve_runtime`. Both builds used
`--offline --locked`, without dependency changes. This host test toolchain is
separate from the unchanged release SBF toolchain (Agave 4.3.0/platform-tools v1.57/
rustc 1.95.0). No production source identity was repinned to this old curve reference.

The final targeted wrapper passed with these explicit inputs:

```sh
HOOKLAB_CURVE_PARITY_BINARY="$PWD/.amp/in/artifacts/frozen-curve-tools/repoing_curve_parity" \
HOOKLAB_CURVE_RUNTIME_BINARY="$PWD/.amp/in/artifacts/frozen-curve-tools/repoing_curve_runtime" \
HOOKLAB_PRODUCTION_ELF_DIR="$HOME/Documents/ChatGPT/hooks-local-state/rebuilt-inclusive/elf" \
  bash scripts/hooks-release-check.sh tests/hooklab-curve.test.mjs \
    tests/hooklab-curve-runtime.test.mjs tests/hooklab-production-operator-bundle.test.mjs
```

Frozen runtime ELFs use the wrapper's recovered hash-pinned `SBF_OUT_DIR` default.
The full run additionally used `HOOKLAB_OPEN_ELF_DIR` pointing to
`hooks-local-state/native-open-36dd07e/elf`, `HOOKLAB_INDEPENDENT_DIR` pointing to
`hooks-local-state/independent-2b8b92a`, and `HOOKLAB_SELECTED_TEST_PGPORT=55432`.
There is no remaining unexecuted test from those four skip reasons. Local acceptance
does not authenticate current mainnet state, approve a production profile, recover
historical final.sh or authorize signing/deployment/activation. **NOT SIGNABLE.**

The app implementation cut is `7a6562ca5f9d1dc3f4a731775047fee4873e716a`, tree
`0cbb1c0cc9ed47d10d227419510355a13a4209da`. The sanitized production Next.js build
passed (`selected-final-next-build.log`), including `/h/[alias]`. It retains the
existing optional `model-pulse.mjs` warning and bigint JS fallback; neither was
silenced or changed. A 1,150-file app/src/vendor/migrations/config/dependency
manifest is preserved in `selected-app-candidate.json`, SHA256
`fbb23b00c6850a2ca8027ccac6465146f101894960c54021fdf9d62082df243d`.
The later documentation commit does not change those executable inputs.

The final visual rerun also passed all six ordered lifecycle tests (677.04 seconds,
`selected-visual-final.log` / `selected-visual-final-report.json`); serial-group
selection intentionally includes the lifecycle through claims. Inspected final
screenshots are in `selected-hook-ui/`: creator configuration, exact preparation,
launch and trade consent, curve trading, postgraduation hook rules and native-wallet
risk copy. A temporary unsigned review/cancel capture checked zero transaction
signatures and was removed after validation. Its visible Stopped state is deliberate
consent cancellation, not a transaction failure. Frozen curve binaries and their
host/source/harness hashes remain under `frozen-curve-tools/`; temporary source and
compilation directories were removed after validating the preserved binaries.
