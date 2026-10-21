# Creator-selected hooks V1 — acceptance checklist

Reference: Bordrless `7fde54001d7f0c88b17c87babf73fb40be07b3cb`.
The receipt-only release packet is withdrawn. Nothing here approves deployment,
spending, permanent freezes or activation. Upgrades remain **NOT SIGNABLE**.
The deployed source baseline remains `89d060b68c507a0d5f31dd5784145ad701336985`;
the reference above is not the deployed source.

- [ ] Developers publish versioned compatible hooks; creators discover and select
  between distinct hooks without a platform release. Publication is not endorsement.
- [ ] Creators configure and initialize their selected hook inside the application;
  immutable intent, exact-message consent and journal recovery cover setup too.
- [ ] Server-observed executable/authority identity replaces singleton admission;
  retained evidence survives reload/restart and rejects changed code or authority.
- [ ] Applicable reference behavior works: pool burns, compatible rules/modules,
  rewards, author shares and claims. Custom hooks and Kit rules have the reference's
  mutual exclusion; do not turn this into an undocumented product-wide exclusion.
- [ ] New custom-hook coins use share model 1. Creator, hook and protocol amounts
  have correct bases, ordering, rounding, recipients and displayed totals. Existing
  gate/model-2 coins retain their behavior and accounting.
- [ ] Real economic-hook browser/validator acceptance proves setup, launch,
  buy/sell deductions and payouts, graduation, post-graduation trading, claims,
  reload/server restart, and tamper refusal. Receipt and synthetic arithmetic
  evidence are supporting evidence, not this acceptance.
- [ ] Corrected source/features/ELFs, simulations and release inputs produce one
  reconciled Step 8 packet: execution order, recipients, funding/fees/refunds,
  permanent effects, deployment versus activation, and post-signing checks.

Local evidence now includes the economic-hook browser/validator lifecycle: catalog
publication and discovery of two hooks, creator configuration, journaled setup,
atomic launch with collector holding, taxed buys/sells, graduation, postgraduate
trades, claims, reload/restart and tamper refusal. The selected hook is model 1
with a 200-bps token tax; the alternate transfer-receipt hook exercises the same
full lifecycle. Both configure asymmetric burns of 37/83 bps and requested author
share of 2500 bps. Config author equals creator, so effective author share is zero;
the review states that there is no separate recipient. Both RPC proxies share one
local validator. This is not independent-provider or production proof.

The supplemental table is creator-funded and permanently frozen during reviewed
setup. Exact rent and maximum wallet debit remain visible before approval, along
with unreclaimable rent and the inability to change or close the table. Diagnostics
are collapsed by default. Missing disclosure still blocks approval. Maximum UTF-8
metadata across both models, zero/one/two atomic holdings and one/32 hook extras
produces 12 launch packets of 920–1055 bytes, below the 1232-byte limit. Exact-message,
table identity/inventory, warm-up, settlement and per-message approval checks remain.

The deployed dependency mismatch is resolved without a token upgrade. V1 requires
the retained token hash `5fbbb2ebca32ed3df4c0299da3376141969ac6088700c86390d8b05d0c451dab`,
not the differing same-sized local rebuild. Two retained public observations agree.
Launch/swap remain the only upgrade targets; fixture hooks are not platform
deployment requirements. The gate remains unchanged and immutable.

The current corrected-token two-hook browser run passes 10/10 with no failures,
skips or flaky tests (1438.17 seconds), including both full nonzero-burn lifecycles.
Run: `01a15d23-cb12-7dd4-94ba-588e3e15d9ae`.
The earlier corrected-token zero-burn browser run passed 5/5 with no skips;
it remains historical supporting evidence, not the two-hook/nonzero-burn result.
Current exact run/hash bindings are retained in the corrected offline packet.
Full hook regression: 884 passed, zero failed, 506 skipped. Focused durable-store,
bootstrap, UI and approval checks: 29 passed, zero failed/skipped. Skips are not
passing coverage and do not establish production readiness.

Corrected-token contract verification passes 52 tests, including actual config
creation and guarded model1 launch with asymmetric burns, capped custom SOL cut,
author share, partial fill/atomic graduation, postgraduate trading and claims.
No created economic account is rewritten. Custom hooks plus Kit holder-reward
or max-wallet modules are refused; burns alone work. Positive custom-hook/Kit
combinations are not supported parity cases. Native hook-vault trading is
unreachable through its legacy bridged swap entry point; enabling native vault
trading/exemptions would expand scope. Nonzero custom SOL-cut payouts and separate
author-recipient payouts retain contract evidence, not browser evidence. Both
pinned browser hooks implement token callbacks only: positive SOL-cut caps cause
`InstructionFallbackNotFound (101)` and HTTP 409 before approval. Do not fabricate
a quote-cut callback or relax the refusal to call that configuration supported.

Production release2 bootstrap now requires a verified durable authority-evidence
store before runtime enablement. Apply the registered `selected-trade-quotes`
migration after the existing custody, setup and signing migrations. Startup checks
the required columns and five enabled immutability triggers; a quote table alone
or a caller-supplied readiness flag cannot satisfy the application gate.

Non-signable estimates retain the original hook executable/authority identity in
SQL, bound to wallet, stage, configuration and intent, for at most five minutes.
New reviews revalidate that identity; unsigned refresh uses the existing review's
immutable SQL context after estimate expiry. Setup recovery also rechecks the
original authority. Disposable database tests cover restart, identity mutation,
expiry and changed-executable refusal. No private custody columns are read by
the readiness check. Local two-proxy evidence does not establish independent
production-provider trust, and migrations have not been applied in production.
No model/tool safeguard blocked these local tests; no safeguard was bypassed.

The nonzero-burn browser case exposed the local configuration's zero burn ceiling.
The release proposal now sets `max_burn_bps` to 200 while preserving the 200-bps
total rules ceiling and all other rule bounds. The owner driver requires explicit
`maxBurnBps` approval when supplied; omission preserves the observed bound. This
proposal is not owner adoption or permission to change production configuration.

The refreshed offline packet binds committed source, features, ELF hashes,
corrected dependency evidence and captured costs from 2026-10-21T04:37:24.828Z.
No production state or fee observation was refreshed in this revision. Its
1897-step unsigned local rehearsal passes, including separate activation rehearsal; no activation is
approved. Observed net cost is 453863760 lamports, peak payer balance 4913494240,
and arithmetic minimum top-up 691450451 at the observed balance. Creator-specific
canary spend and external funding-wallet fees are excluded until exact messages
exist. Source/roles, funding, upgrades, setup, irreversible table freezes and
activation each retain their required approval/review boundaries. Historical
receipt-only budgets remain withdrawn; local rehearsal is not production consent.
