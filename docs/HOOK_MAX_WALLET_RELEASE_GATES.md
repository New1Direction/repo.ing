# Max-wallet release gates

This document describes missing production boundaries. It is not approval to deploy,
upgrade, sign, send, grant access, or enable execution. Current builders and journal
remain offline/candidate-only; successful local tests do not change that status.

## Implemented read-only ABI integration

The same-ID max-wallet event profile requires both source commit
`a33957a3f4285351949852ce5fb49cb3616ef496` and source patch SHA-256
`d1c5447d6e4c0400ad641679cb0e409425f2ce1ef9aaf6500611215f3491c13f`.
The launch IDL is pinned to
`b1f564880120eac65ba7f35031260b74f93c9b5004edb55ce0543884fa6b5f8f`.
The unchanged swap IDL retains its previous exact pin. Explicit patch identity is
propagated through index manifests, stream IDs, CLI construction, retained reads,
and response identity. The default decoder remains the old plain profile.

Matching program addresses never choose this profile automatically. Candidate
receipts still report no economic acceptance or deployment adoption. The new ABI
is a source candidate, not evidence that deployed programs run those bytes.

## Production preparation resolver: required boundary

The ordinary `buildMaxWalletLaunchReview` must remain closed until all these
requirements are implemented and independently reviewed together:

1. **Principal and wallet ownership.** Resolve a server-authenticated launcher
   principal and verify the bound wallet; do not accept an owner ID from JSON.
   The current journal is scoped to GitHub user IDs for operator/offline reads.
   A general coin launcher needs a wallet-first principal model. GitHub remains
   optional metadata; reusing the existing GitHub-only owner field as public
   launcher authentication would silently contradict that product scope.
2. **Explicit server release profile.** Pin complete source/patch/build/IDL/ELF
   identities, chain, quote mint, immutable gate, and approved program addresses.
   Candidate files and self-reported hashes cannot adopt a release. Deployment
   and dependency provenance must be established separately.
3. **Trusted collection ingress.** Construct provider transports from server-only
   configuration. Enforce HTTPS, redirect rejection, response byte bounds,
   cancellable timeouts, and independently reviewed provider origins. Distinct
   provider labels or connection objects do not establish independence. Existing
   collector callbacks and `configured-readonly-rpc` labels alone are not proof.
4. **Durable ownership and original wire.** Persist the exact reviewed preparation,
   signed wire, signature, owner, mint, intent, profile and message hashes before
   any submission. A DB/submit timeout has an unknown outcome: reconcile the same
   identity rather than create a new mint, re-prepare or silently retry.
5. **Finality and immutable evidence.** Reconcile both providers' exact signed wire,
   inclusion, successful execution, current source bytes and canonical prepared
   accounts. Preserve earliest finalized evidence and sticky conflicts. Missing,
   pending, failed, conflicting, changed or already-launched state cannot authorize
   launch. Replaying durable JSON validates consistency, not its ingress provenance.
6. **Fresh launch revalidation.** Re-read program state, policy/registry/config,
   governance/grant, fees, balances, absent targets, blockhash and lookup tables
   immediately before producing a bounded launch review. Bind the review to the
   authenticated durable record and current checks; never transform an arbitrary
   fixture proof into accepted production evidence.
7. **Signing lifecycle.** The future mint signer, creator and required launch
   admin cosigner need an explicit custody/recovery policy and exact-message
   approval. Browser refusal, partial signatures, expired blockhash, cancellation,
   duplicate calls and uncertain submission need separate durable states.

A resolver can return a read-only eligibility assessment before execution is
implemented, but must not produce a production review or accepted receipt merely
because every candidate check passed. No resolver capability is created by this
change.

## Acceptance matrix before public execution

- Disposable DB: owner isolation, immutable identity, sticky conflict, exact replay,
  duplicate requests, concurrency, crash/restart and unknown-outcome reconciliation.
- Transport: blocked redirects, oversized/malformed bodies, aborts, wrong genesis,
  provider disagreement and same-origin aliases.
- Wallet-first launcher: no GitHub prerequisite, wallet binding, signer custody,
  reject/cancel, partial-signature and expiry paths in the actual browser.
- Exact approved deployment: verify deployed ELF/IDL/profile and dependency code;
  reviewers distinguish same-address upgrades from legacy plain capability.
- Controlled live acceptance: separately authorized preparation, launch, capped buy,
  rejected over-cap transfer, sell, authenticated graduation and receipt indexing.
  Keep any costs, signatures, grants and enablement separately authorized.

Local unit, database and SBF results cover only their stated environments. Browser
and live acceptance evidence are still required for a live-readiness claim.
