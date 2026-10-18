# Wallet-owned launch assessment flow

This default-off UI/API connects authenticated wallet identity to the co-located
preparation journal and fresh two-provider preparation reconciliation. GitHub is
not required. No transaction builder, signer, submitter or adoption bypass is wired.

`/hooks/launch-review` presents wallet sign-in, a retained preparation ID, the exact
wallet/mint/cap/original signature, and a separate refresh/review action. The signed
preparation is immutable; the browser does not supply account snapshots, RPC URLs,
owner IDs, raw signed wire or acceptance flags. A changed connected wallet aborts
the local review display. This is a retained-preparation review flow, not a new-mint
creation/custody flow.

`/api/hook-lab/wallet-launch-assessment` defaults to unavailable unless both the
identity and assessment flags are explicitly enabled. It uses the same configured
application DB, the same host-only authenticated session cookie, exact-origin CSRF
checks on POST, bounded strict JSON, and fail-closed shared quotas. Reader URLs and
the frozen candidate profile are server-only explicit settings; none are supplied
or activated in this source change.

The first owner-scoped read verifies exact preparation ID, creator, mint, profile,
immutable request and canonical preparation-intent hash. A separate server-owned
collection refreshes signed transaction/inclusion/post-state evidence. Its returned
identity must still match the original before an assessment is displayed.

Even matching evidence returns explicit blockers:

- `SIGNED_RELEASE_ADOPTION_REQUIRED`: no exact signed owner-approved adoption packet
  has been verified. There is no boolean/environment/callback override for adoption.
- `PRODUCTION_LAUNCH_REVALIDATION_REQUIRED`: full current launch inventory, governance,
  creator grant, signer custody, fees, lookup table and blockhash need a production
  resolver before unsigned launch bytes may be produced.
- Unresolved, conflicting or no-longer-prelaunch preparations also retain
  `PREPARATION_RECONCILIATION_REQUIRED`.

Every response keeps execution/sign/submit/launch false and unsigned launch message
null. The ordinary production builder remains closed; the fixture builder is never
imported or invoked. A synthetic result cannot emit production bytes.

Tests cover injected local HTTP flow, canonical wallet/mint/cap/plan mismatches,
failed/pending/conflicting evidence, CSRF/body/identity/flag rejection, and actual
wallet-owned PostgreSQL evidence plus in-memory two-provider reads through to the
explicit adoption gate. Build success is not browser acceptance; no browser/live
claim is made. New-mint preparation signing/custody and production launch resolver
implementation remain separate open work after release adoption is established.
