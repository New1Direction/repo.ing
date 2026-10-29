# Neuron Characters on repo.ing: execution plan

2026-10-28. Planning only: no application behavior, production data, signers,
deployment switches, chain state or market economics changed.

## Scope and delivery state

Latest owner direction: real user-launched tokens and real trading on repo.ing,
with simulated personalities instead of activation-steered inference for v1.
The earlier Modal L4 research is optional future work, not a v1 dependency and
not authorized spending. Keep the Neuron Characters brand; label chat accurately.

Work is isolated in `feature/neuron-launch-integration`, worktree
`/home/user/workspace/repos/repo.ing-neurons`, based on fetched `origin/main`
at `2c4cea701fae1954f2638d98f4e946b7ed6515c7`. The companion clone is
`/home/user/workspace/repos/repo.ing`. No branch was pushed or merged.
The neuron-characters checkout's extensive local changes are NOT in this
worktree; do not assume a worktree copied them or silently transplant them.

## What is confirmed, and what is not

- Public repo.ing advertises existing repository-token trading and builder
  earnings. This inspection did not execute live launches, inspect deployment
  configuration or verify a production payout.
- `src/launch-coordinator.mjs`, `src/meteora-launch.mjs`,
  `src/launch-sessions.mjs`, `app/api/launch/route.js` already implement a durable
  prepare/sign/submit/reconcile flow. Reuse its protections, not the demo ledger.
- `src/market-identity.mjs` accepts only GitHub and Hugging Face ID namespaces.
  `src/db/schema.mjs` and migrations 0049/0052 enforce source-specific authority.
  A neuron is neither a fake GitHub repository nor a new Hugging Face model.
- Native arbitrary-coin launch/trade/claim code exists behind separate default-off
  runtimes: `app/api/hook-lab/native-launch/route.js`,
  `app/api/hook-lab/inclusive-trade/route.js`, and
  `app/api/hook-lab/native-claim/route.js`. Its operator/profile/custody approval
  gates are documented in `docs/HOOK_NATIVE_LAUNCH_RUNBOOK.md`; source presence
  is NOT proof it is production enabled or ready for this use.
- `src/hooklab-launch-menus.mjs` and the native runbook specify a 25% platform /
  75% creator fee split. This does NOT implement the requested 35% / 65% policy.
- `src/platform-revenue.mjs` separates settled collection, allocation, funding
  and executed buybacks. Existing platform revenue must not fund a new creator
  obligation or be relabeled as neuron buybacks.
- Neuron app `src/market.rs` is a demo-only credit ledger. Never convert its
  credits, positions, fees, receipts or fixture evaluation scores into live assets.

## Product experience

Use native repo.ing routes: `/neurons` (browse), `/neurons/new` (create/review),
`/neurons/[characterId]` (character, chat, verified market), and a Neurons filter
on Explore. These are PROPOSED routes, not implemented routes.
Preserve existing repository/Hugging Face pages and fee terms unchanged.

Visitor journey:

1. Browse source-attributed library cards or create a custom personality.
2. Preview identity, story, simulation disclosure and the market's exact terms.
3. Connect wallet and bind the draft to a signed, expiring, domain/cluster-specific
   nonce. Editing another creator's draft or changing the payout wallet is refused.
4. Review total launch SOL, rent, fee schedule, slippage, allocation, graduation
   rules, creator recipient and 65/35 split before signing the exact transaction.
5. Show pending until verified chain evidence settles. Reconnect resumes the
   same attempt; an unknown outcome must never mint a replacement token.
6. Live page shows canonical mint/pool, actual wallet holdings and finalized trades.
7. Creator dashboard shows accrued, claimable, pending and paid amounts separately.
   Earnings depend on actual trading and fees; there is no guaranteed return.

Required copy beside chat and on launch review:
“AI persona inspired by the neuron library. Chat is prompt-simulated, not
activation-steered. The token does not convey ownership of a neuron or model.”
If replies are scripted, say “scripted demo” instead of implying live AI.
Do not reuse the source site's name/ratings as validation, endorsement or rights.
Review source-data reuse terms and model/provider policies before commercialization.

## Implementation order and ownership

### 1. Isolated integrated preview (safe work to start now)

Build the three `/neurons` routes, navigation and Explore filter on this branch.
Use existing wallet and market components in `app/components/`, not an iframe or
copied wallet stack. Adapt the persona cards into repo.ing's React components;
the Rust app remains a separate demo/reference, not a second financial backend.
Preview launch/trade/earn buttons must be explicitly demo or disabled until wired.
Use local fixtures and a disposable database; never production credentials.
Accept when desktop/narrow layouts and keyboard interactions are reviewed in a
running preview, including pending, rejected, failed and unavailable states.

### 2. Character registry and canonical launch identity

Preferred trading route: reuse ordinary Meteora DBC/DAMM infrastructure through
an explicit third market source, rather than activating a new custom program
under deadline pressure. First validate source/fee compatibility offline. If
the native coin runtime is already approved by the operator, assess it instead;
do not switch families without reviewing its economics and recovery limitations.

Add an expand-only registry/schema migration and an immutable, non-colliding
neuron market namespace. Extend `src/market-identity.mjs`, `src/db/schema.mjs`
and source guards as a coherent change; enumerate callers before implementation.
Persist character ID, immutable launch metadata hash, simulation mode, persona
prompt/version, source attribution and optional unverified source DNA. Bind these
to creator wallet, cluster, mint, pool, config and fee-policy version. Keep secrets
out of metadata and distinguish source Qwen revision (unknown) from the actual
persona-chat model/version. Freeze launch snapshots; later persona edits need a
visible version history and must not rewrite token economics or attribution.
Reuse one-market locks and add uniqueness at the registry/database boundary.
Library selection does not confer exclusive rights over the source recipe.

Adapt `src/launch-coordinator.mjs` and `app/api/launch/route.js` through their
existing source boundary. Audit `src/launch-evidence.mjs`, market metadata,
indexer, trade preparation/recording and `scripts/run-worker.mjs` for the new
source. Never bypass source checks by borrowing the neuron app repository ID.

### 3. Fees and the ability to earn (release-critical)

Retain the requested economics: 65% of the settled creator-fee entitlement to
the launcher and 35% to a segregated REPOING-buyback reserve, excluding unrelated
LP/protocol fees. Choose and display the creator-fee rate/menu separately; do not
silently adopt the paper demo's 1% or change existing repository market schedules.
Specify both pre-graduation and post-graduation collection, rounding and costs.
For an integer settled amount A, reserve floor(A * 3500 / 10000), credit the
launcher with the remainder, and preserve the total exactly. Pay network costs
from an explicitly agreed separate budget, not invisibly out of the promised 35%.

First determine whether approved Meteora authorities/configs support the chosen
receivers without new program code. If platform collection plus server-authorized
payouts is used, explicitly disclose custody: this is not a trustless on-chain
split. Reuse durable claim/reconciliation patterns with wallet-based authority,
NOT GitHub admin claims. Keep the neuron ledger/recipients isolated and stamp
the agreed policy at launch. No new contract is presumed audited or deployed.
If on-chain enforcement needs a custom router or changes to native program
economics, that is a separate reviewed security/deployment task, not a flag change.

Implement creator review/claim/recovery and an earnings page before advertising
“launch and earn.” Buyback funding is not a completed buyback. Automatic buys
need a separate approved executor: allowlisted REPOING mint/receiver/venue,
size/daily/slippage/impact/fee caps, durable idempotent intents, finalized receipts,
pause and reconciliation. A deferred executor leaves the full reserve owed and
must be shown as pending, not “automatic buybacks live.” Do not assume burn.

### 4. Simulated-persona chat (independent of trading)

Add explicit `persona` vs `steered` vs `scripted` provenance; never use
`DEMO_MODE=true` to make live financial routes available. No GPU is necessary
for persona prompts. A cheap shared model API is still a paid dependency unless
a verified free allowance covers it. Keep it off without approved provider,
policy, credentials and spend controls. Launch can show a profile with chat
unavailable instead of pretending a canned response is live intelligence.

Treat creator persona text as untrusted input, moderate public content and every
reply, cap prompt/history/output sizes and per-visitor/global usage, fail closed,
and prevent prompt content from authorizing wallet or fee actions. Public chat
needs separate load/abuse checks; signed wallets are not Sybil-proof. No Claude
judge/GPU evaluation spending is required for this clearly disclosed persona v1.

### 5. Local proof, network rehearsal, operator canary, release

Run existing offline tests/build and add regression coverage through public
boundaries. Use a fresh local database and local Solana/Meteora fixtures first;
rehearse on devnet where the approved program/config family actually exists.
Do not assume all mainnet programs are deployed on devnet. If unavailable,
require exact local evidence and a separately authorized bounded mainnet canary.

Release proof must cover launch, buy, partial sell, full sell, creator claim,
fee reserve reconciliation, and migration to DAMM on the representative fixture
stack. Cover concurrent duplicate launch, same ticker, forged metadata/wallet,
wrong cluster/config/mint, unauthorized claim, expired nonce/blockhash, wallet
rejection, dropped responses, process restart, RPC disagreement, unknown finality,
duplicate callbacks and worker replay. Assert exact base-unit balances and
receivers, not only HTTP success. Existing GitHub/HF flows must pass unchanged.

Before a public-money release, operator reviews actual deployment/config/signers,
fee schedule and custody, licensing/disclosures, backups/restore and monitoring.
Use one approved small canary with exact maximum SOL exposure and fee recipients;
that authorization is separate from local work, publishing a preview or merging.
Independent review of changed financial paths is required before public rollout.
Keep feature gates off until receipts and recovery checks pass. Pause new launches
and buys on incident; do not strand selling, already-earned claims or reserves.

## Same-day target and honest stop line

The controllable same-day deliverable is a reviewable native UI and verified
offline integration work. Public mainnet launch/earn/trade TODAY is conditional
on all financial gates above, approved production access and exact terms. The
current state is not a deployment-ready character market. Simulated personalities
remove the GPU blocker, not identity, custody, fee, claim or security blockers.
If any critical gate remains open, ship a clearly labeled preview/registration
experience with execution disabled, not a page that claims people can already earn.

## Merge and deployment path

Keep UI, source/schema, financial policy and chat as separately reviewable changes
on this worktree. No commits are made by this planning task. When requested,
commit logical slices, refresh against then-current `origin/main`, review, run the
combined suite/build, capture previews, and open the integration PR. Do not merge
blindly from the base inspected here: repo.ing may be changing concurrently.
Review migration SQL against production schema before executing it; never run
local reset/test scripts on production. Merge and rollout are separate actions.
Preview with execution off first; deploy reviewed expand-only schema and dormant
code, perform authorized canary, then enable launch/trade/claims independently.
Rollback disables new execution without erasing receipts or changing market terms.

## Inputs needed before real execution

- Approved launch/config family and evidence of its actual deployment; repo.ing
  production access through secure channels, never pasted keys.
- Exact fee rate/menu, accepted custody model, launcher recipient rules and the
  promised 65/35 policy for new neuron markets only.
- REPOING mint/treasury and hold-vs-burn policy, plus buyback/transaction budget.
- Network-specific RPCs, protected signer boundaries, migration/deployment approval
  and bounded canary exposure; no unreviewed remote actions in this planning task.
- Persona source reuse rights, final disclosure wording, and chat-provider budget
  if live persona chat is included. Otherwise explicitly unavailable at launch.

No user earnings, investor return, successful mainnet release date or first-to-market
status is guaranteed by this plan. Progress should be reported as preview-ready,
offline-verified, canary-verified or publicly enabled, not an undifferentiated “done.”
