# Native max-wallet launcher: operator setup and acceptance

The route is `/hooks/launch-review`; it is also linked from `/hooks/new`.
GitHub is not required. Wallet identity is a separate signed nonce/session.
The HTTP boundary is `/api/hook-lab/native-launch` and is disabled by default.
Inclusive buy/sell has its own `/hooks/trade` page and
`/api/hook-lab/inclusive-trade` boundary, also disabled by default. Trading uses
the same wallet principal and durable lifecycle, with no mint/admin custody key.

## What is implemented

The server composition is `createNativeLaunchRuntime` in
`src/hooklab-native-launch-runtime.mjs`. It joins encrypted durable mint/config
custody, exact two-provider preparation and launch resolvers, immutable intent,
wallet-only partial signature retention, checked server/admin cosigning,
durable signer/send claims, exact-wire two-provider simulation, one HTTP send,
and finalized transaction/post-state reconciliation. The client calls
`signTransaction`, never `signAndSendTransaction`.

Inclusive mode is an explicit separate compiler family: policyVersion 2,
feeModel 2, protocolShareBps 2500. Platform receives floor(collected eligible
creator-quote fee / 4) per swap; creator receives the remainder. The creator
fee rate must be explicitly chosen and match the approved profile. This does
not select a 1% fee and does not add a 25% surcharge. Legacy fixtures cannot
activate inclusive production execution.

## Inputs still required before activation

- Exact newly built inclusive profile, IDL bytes, executable lengths/hashes,
  dependency pins and approved deployment dossier matching actual programs.
  Inclusive production setup requires dossier schema
  `repoing/production-observation/2`, with explicit `config-counters-v1`
  bindings for both launch-config and swap-config. Only canonical known
  monotonic counters are normalized; economics, authorities and all other
  bytes remain exact. Legacy full-hash schema1 is not a reusable inclusive
  runtime configuration.
- Owner/operator approval of custody, deployment, the creator fee rate,
  treasury/collector, max-wallet cap policy, debits and fee ceilings.
- Two independently operated HTTPS RPC connections with exact configured
  provider labels, trust domains and origins. Provider credentials belong in
  the operator's secure server environment, never source files or browser.
- A dedicated approved encryption key ring, active key ID, retention and backup
  procedure. Do not reuse an existing app secret. The JavaScript implementation
  cannot promise complete in-memory zeroization.
- Separately controlled admin signer with exact observed on-chain address.
  Its callback accepts only the checked message; no automatic key discovery.
- A durable PostgreSQL pool in the SAME database as wallet identity, custody,
  preparation journal and signing records. Do not route these across databases.

No such real configuration or live keys are included in this source package.
Passing booleans is an operator activation mechanism, not evidence of external
owner approval. The actual release process must record that approval.

## Schema order

For a fresh database apply these SQL files exactly once, in order, through the
normal reviewed migration process. Existing installations apply only missing
migrations; these files are not an idempotent reset script.

1. `src/hooklab-wallet-principal-schema.sql`
2. `src/hooklab-wallet-preparation-schema.sql`
3. `src/hooklab-native-signer-custody-schema.sql`
4. `src/hooklab-new-mint-preparation-schema.sql`
5. `src/hooklab-native-signing-schema.sql`
6. `src/hooklab-native-signing-attempt-schema.sql`
7. `src/hooklab-native-signing-context-schema.sql`
8. `src/hooklab-native-signing-refresh-schema.sql`
9. `src/hooklab-native-launch-context-schema.sql`
10. `src/hooklab-native-signing-trade-schema.sql` (inclusive trading)
11. `src/hooklab-native-signing-wallet-request-schema.sql`

Also apply `src/hooklab-wallet-identity-quota-schema.sql` for the wallet
identity HTTP quota. Do not use the disposable test harness on production.

## Server bootstrap

Construct `createNativeLaunchRuntime(pool, settings)` in a server-only startup
module with the explicit approved inputs above. Required settings are:
`enabled`, `origin`, `ownerCustodyApproved`, `operatorDeploymentApproved`,
`economicsApproved`, `config`, `profile`, `dossierJson`, `connections`,
`keyRing`, `activeKeyId`, `adminSigner`, `preparationLimits`, `launchLimits`.
Limits are the strict compiler's raw-unit fee/debit/review bounds, not user
browser values. For production, call `initializeNativeLaunchRuntime({settings})` from
`app/lib/hooklab-native-launch-runtime.mjs` once in each server process before
requests are served. This wrapper constructs the pool from the SAME wallet
identity database configuration and requires the identical origin. Direct
factory/installer injection is reserved for controlled local integration tests. The route does not load arbitrary modules or credentials
from environment variables. Runtime installation must be wired through the
host's reviewed server bootstrap; no operator-specific bootstrap is supplied.

Existing wallet identity settings are required. The additional public feature
switch is `HOOK_NATIVE_LAUNCH_ENABLED`; wallet identity also requires
`HOOK_WALLET_IDENTITY_ENABLED`, `HOOK_WALLET_IDENTITY_ORIGIN` and
`HOOK_WALLET_IDENTITY_DATABASE_URL`. Inclusive trading additionally requires
`HOOK_INCLUSIVE_TRADING_ENABLED` and its separately installed approved runtime. A flag alone cannot configure or activate the
runtime. Never put encryption/RPC/admin secrets in a NEXT_PUBLIC variable.

## Recovery rules

Save operation, preparation-signing and launch-signing IDs. Browser storage
holds these IDs only. Reauthenticate with the same wallet after a session
expires, then resume the retained signing ID.

- **Reviewed, bytes never issued to wallet:** explicitly refresh the unsigned review. The
  same mint/config/intent/configuration remains fixed; the prior review is
  archived and fresh chain state/bytes are verified. Review and accept again.
- **Wallet request issued:** its issuance is committed before any signable bytes
  leave the server. A rejected prompt or lost response does not erase this
  marker. Only same-message retry/recovery is available; absence of a saved
  signature is not proof no signature exists. Public review/get shows metadata
  and a message SHA only, not signable bytes.
- **Partial/signed or wallet-issued and expired:** stop. Do not refresh or create a replacement.
  The current release cannot automatically replace signed expired messages.
  The operator must retrieve the retained signature/message and prove its
  outcome/expiry against both providers before a separately reviewed recovery
  change. Until that procedure is approved, this state is a release usability
  limitation, not permission to clear records or regenerate keys.
- **Signing claimed/unknown:** no signer retry. If the original signer can
  recover its exact returned signature, use the internal
  `retainRecoveredServerSignature` method; it accepts only the pending key's
  valid signature over the original message. No public recovery endpoint exists.
- **Submission claimed/submitted/unknown:** reconcile the original signature.
  Trading uses authenticated transaction-local token transfer and swap events;
  later unrelated swaps do not replace the original receipt. The on-chain
  minimum output is binding. The impact ceiling is a review-only bound, so
  a proven finalized execution can separately require policy review if actual
  impact exceeded that bound. The UI shows quoted versus actual results and
  never treats a policy warning as permission to resend.
  Never send again, swap providers for a second send, or generate another mint.
- **Finalized failure/conflict:** retain all identities, signatures and evidence;
  halt dependent launch work for operator review. No timeout-based erasure.

## Final owner acceptance checklist

Browser/local acceptance and final live acceptance are separate evidence gates.
Use a disposable approved local/test configuration first; do not claim success
from compilation or fixture replay alone.

1. Wallet login, logout, expired session and reconnect with the same wallet.
2. New coin reserve, visible exact cap/rate/25–75 split and debit ceilings.
3. Reject wallet signature; verify no server signature/send occurred.
4. Prepare, refresh unsigned review, prepare/sign/finalize, then launch the SAME
   mint/config. Reject changed wallet, metadata, fee, cap and substituted bytes.
5. Resume after reload and after a simulated lost response. Unknown outcomes
   must reconcile only; no duplicate send or signer attempt.
6. Verify exact deployed profile/pins and two-provider finalized launch evidence.
7. Buy then sell with a fresh exact quote; verify inclusive fee rounding and
   actual creator/platform balances, collector PDA and max-wallet enforcement.
8. Test above-cap buy, wrong fee model/collector, revoked grant, expired blockhash,
   conflicting providers and actual finalized transaction failure.

Keep actual transaction IDs and acceptance receipts outside the source-only
patch. No live acceptance is asserted by this document.
