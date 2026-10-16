# Production-source curve candidate — execution disabled

This increment does **not** make real users able to trade. No accepted production trading
policy, deployed-profile adoption, authenticated transaction-history adapter, or owner execution
approval exists. `submitCurveTransaction` always throws 423. Neither environment flags, supplied
approval hashes, valid signatures, simulation success nor matching receipts enable it.

Trading a **plain coin on Hook Lab DEX is not live programmable Hooks**. Kit and custom hooks
remain independently refused, even if plain curve trading eventually receives acceptance. They
need their own source/ABI, authority, policy and receipt acceptance; this candidate implies no parity.

## Source contract and deliberately narrow first trial

Frozen Hook Lab source is `f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32`, tree-equivalent to
`b3dc4297735fe2e061fca7b6563d69cf81e0911c`. Runner merge `b5a4c3a52f11fb5fecd42a14159b2630f8668ea3`
does not repin it. Production profile SHA256 is
`9df8e9ceaa3a73fb37c8af35254382f27e38bfc35d6a1fcfa4b72223e75e9cb7`.
The exact frozen production swap IDL has SHA256
`ba5409de62f8d56f3500a72f5b7d11cfdefd85027d2ec3bd56e2137ae76bc414`.
Its swap instruction and SwapArgs match the retained vendor ABI. References in Hook Lab:
`programs/bordrless_swap/src/{client.rs,instructions/swap.rs}`,
`programs/bordrless_launch/src/{client.rs,instructions/hooks.rs}` and
`crates/bordrless-core/src/lib.rs::swap_out`.

The candidate constructs the production swap instruction directly: 31 Borsh bytes, 19 ordered
metas, fixed production IDs, all four launch callback extras, and historical Kit PDA placeholders.
It never remaps a generic default-ID instruction. Kit is not supported. Holdings are custom-token
PDAs, not SPL ATAs; the input/output quote is not native SOL.

Only zero LP/protocol-share/creator/sniper fees, plain mint/launch rules, existing funded holdings,
pre-graduation curves and no ALTs are supported. Both directions and separate recipients/payers
are supported by the builder; the bounded trial proposal requires a self-recipient round trip.
Nonzero fees, wrapping/unwrapping SOL, holding creation/rent, custom hooks, graduation, liquidity
and public trading are rejected or absent. Existing hypothetical devnet quote code is unchanged.

`inspectCurveState` validates supplied account identities/layouts, pool/launch/vault/holding/registry
bindings, pauses, economics, input/minimum output, real liquidity, overflow and rounded-up price
impact. The quote is hypothetical; these supplied snapshots are not authenticated observations.
`inspectCurveArtifacts` hashes the **actually imported** SDK/profile and checks pinned source
metadata. It does not verify Sigstore provenance. `provenanceVerified` stays false.

On chain, the swap binds exact input and minimum delivered output. There is **no trade deadline,
economics/config hash, executable hash, fee cap or creator grant guard**. The 15-second/32-slot
review window and network-fee cap are consumer checks, not on-chain enforcement. Creation controls
cannot be presented as trade controls. Acceptance must explicitly resolve this risk.

## Internal integration boundaries

- `prepareCurveReview` produces a v0 review; `simulateCurveReview` revalidates it and uses injected
  unsigned simulation without blockhash replacement. It does not verify simulation postconditions.
- `curveRecoveryJournal(pool, providers).prepare(owner,id,intent,observed)` persists the exact plan.
  The owner must come from an authenticated application session, never public body data. No HTTP
  route or wallet signing prompt is installed. Do not reuse payout-binding consent.
- Private `challenge(owner,id,plan,{sessionId,origin})` and
  `prepareAuthenticated(owner,id,plan,context,{nonce,signature})` use a separate
  `repo.ing curve review retention v1` purpose. The proof binds the trader, GitHub user/session
  hash, canonical HTTPS origin, operation UUID, full genesis, profile, message, state, intent,
  nonce and five-minute expiry. It authorizes retaining an offline review, **not spending or a
  persistent wallet link**. Consumption, plan and audit commit atomically; the per-owner quota is
  ten challenges per ten minutes, serialized in PostgreSQL. Recovery survives proof expiry.
  Future HTTP integration must derive owner/session via `readGithubSession`, apply
  `assertSameOrigin(request, publicOrigin(request.url))` before bounded parsing and durable quotas,
  and rebuild the plan server-side. Never expose the legacy internal `prepare` method directly.
  This does not import the consumer's plain-specific proof or install a public curve proof route.
- `retainPartial` accepts existing external signatures, verifies each against the unchanged message,
  merges without dropping previous signers, and atomically stores the wire plus ordered audit event.
  Expiry/disconnect does not erase recovery. It never generates keys or asks a wallet to sign.
- `indexCurveReceipts` uses two explicit independent read adapters. Standard finalized RPC supplies
  signed transaction/fee/balance evidence; safe-integer validation refuses rounded RPC values.
  Original SDK transaction responses are retained beside normalization. Read timeouts are bounded.
  History outages preserve known transaction evidence. No latest-account snapshot substitutes for
  transaction-slot history. An accepted replay/archive source is still required.
- `createCurveArchiveReader` is **unaccepted archive-authentication scaffolding**, not a configured
  history provider. Server-owned pins select one source identifier, Ed25519 public key and complete
  payload SHA256; the injected reader cannot select a replacement key/hash. It authenticates an
  author's assertion, never whether that author's replay or historical capture is correct.
  The candidate `repoing/curve-archive-assertion/1` payload contains `source`, full `genesisHash`,
  `profileSha256`, exact normalized `receipt` and `history`. The envelope contains canonical
  `payloadBase64` (at most 32768 characters) and `signatureBase64`. Signatures cover the UTF-8
  domain `repo.ing curve archive assertion v1\n` followed by the exact JSON payload bytes; parsing
  and reserialization must preserve those bytes. No signing implementation or private key is used
  by the adapter. Exact receipt, message, genesis, profile, signature and slot bindings are checked.
  Both original RPC responses, complete archive bytes/signature and public-key fingerprint/key are
  retained through indexing/restart. Invalid/unavailable archives preserve finalized RPC evidence.
  `signatureVerified` means archive-author authentication only. `historyProvenanceVerified` and
  `chainVerified` remain false even for a valid signature and matching accounting. Tests deliberately
  authenticate a false state assertion and require accounting refusal. No real archive, trusted
  replay method, signer authority or historical producer receipt has been accepted or supplied.
- `inspectCurveReceipt` checks supplied matching history: signature, slot/index, exact prestate,
  raw poststate changes, custom holdings, reserves, protocol fees, volumes, counter and native debit.
  `candidate-deltas-matched` is **not** chain verification. Evidence provenance remains unverified.
  Events retain every observation in acquisition order per operation; the first finalized receipt
  survives later outages/conflicts. Slot/index are retained, not inferred from acquisition order.
  Finalized provider/retained-evidence contradictions set a durable conflict marker. Later matching
  reads cannot clear it; no automatic resolution or retry mechanism exists.
- Alert rows commit atomically with status transitions. `deliverCurveAlert(pool,sender)` uses the
  existing channel-sender contract, posts only journal/event identifiers, retries proved failures
  at most three times, and quarantines unknown/stale in-flight outcomes instead of duplicating sends.
  Invoke only after private destination approval. Private `readCurveAlertEscalations` lists unknown
  delivery, exhausted retries, stale in-flight claims (two minutes), and acknowledgements overdue
  five minutes from the original event (not from the latest attempt). `recordCurveAlertReview`
  retains the authenticated operator ID and evidence hash separately for acknowledgement/escalation;
  neither overwrites the first record, rewrites delivery status, clears a trade conflict nor releases
  reservations. The caller must authorize the operator and retain the referenced evidence. No public
  attestation endpoint, scheduler or real destination is installed; local HTTP tests do not prove
  private production delivery or human acknowledgement.
- `inspectCurveTrialProposal` checks one buy/one sell, exact messages/identities, exclusive bounded
  window, inputs, native network budget and quote-loss bound. Supplied evidence/approval hashes are
  references, not verified authority. `curveTrialBudgets` adds durable internal reservations:
  one journal per trial side, and one reservation per journal across all trials. Reserve before
  retaining any signature; reject expired reviews and require the sell's exact supplied prestate
  to match the retained finalized buy's poststate. Stop, expiry, RPC failure, disconnect and
  conflicting outcomes never release a hold. Idempotent reads of a prior hold are not retry grants.
  These are candidate accounting holds, **not actual wallet locks or accepted live budgets**.
  The pair of exact messages must already be proposed; no automatic reblockhash/reapproval of the
  sell exists. A changed buy result or expired sell review requires separate manual review, not a
  replacement transaction. All reservation results still report signing/submission/policy false.

## Reproducing source parity and provenance checks

The direct Rust check calls the actual frozen `bordrless_launch::client::swap` helper with production
features. It matched all 31 bytes and 19 ordered metas for asymmetric buy/sell inputs, with both
self and separate recipients. It is **builder parity, not SBF execution or round-trip acceptance**.
In a separate Hook Lab checkout at `f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32`, copy
`scripts/hooklab-curve-parity.rs` to `programs/bordrless_launch/examples/repoing_curve_parity.rs`, then:

```sh
cargo build -p bordrless-launch --features production --example repoing_curve_parity --locked
# Run from repo.ing; the path is the binary built in that frozen checkout.
HOOKLAB_CURVE_PARITY_BINARY=/path/to/hook-lab/target/debug/examples/repoing_curve_parity \
  node --test tests/hooklab-curve.test.mjs
```

Without the binary, the direct Rust test explicitly skips; the ordinary ABI/policy tests still run.
The production-feature Rust library's six unit tests also passed locally. No live RPC writes or
production signatures are involved.

The received frozen producer archive matched SHA256
`a97e8fcb7c8ef7538fe3a16dd81cd11e89b61bd64f3960af265dff0fb561342b` and all 46 manifest members.
Independent `gh attestation verify` runs passed for `binaries/bordrless_launch.so`,
`binaries/bordrless_swap.so` and `ci/source.tar.gz`, using the producer runner's exact pins:

```sh
gh attestation verify binaries/bordrless_swap.so \
  --repo New1Direction/hook-lab --bundle ci/provenance.sigstore.json \
  --signer-workflow New1Direction/hook-lab/.github/workflows/beta.yml \
  --source-digest b3dc4297735fe2e061fca7b6563d69cf81e0911c \
  --signer-digest b3dc4297735fe2e061fca7b6563d69cf81e0911c \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --deny-self-hosted-runners --format json
```

Run inside the hash-checked packet and repeat for launch and source. These attestations bind the
frozen **paused producer build**; tree-equivalent vendor revisions do not replace the signer/source
digest. They do not authenticate this new adapter, current deployments, policy approval, custody
or transaction history. Runtime curve provenance/acceptance flags therefore remain false.

## Exact-message unsigned production runtime round trip

The separate `scripts/hooklab-curve-runtime.rs` harness loads production launch/swap/custom-token
ELFs into LiteSVM at their production IDs. It executes the **exact JS-compiled v0 message**, not a
Rust recompilation with different static-account ordering. Signature verification and blockhash
checking are disabled; every signature is zero. This is local synthetic-state execution, not a
production signing action, deployed-program equivalence check or historical mainnet receipt.

Copy the harness to `programs/tests/examples/repoing_curve_runtime.rs` in the same frozen checkout:

```sh
cargo build --locked -p bordrless-program-tests --features production --example repoing_curve_runtime
# Run from repo.ing. SBF_OUT_DIR contains the three hash-pinned production .so files.
SBF_OUT_DIR=/path/to/frozen-artifact/production \
HOOKLAB_CURVE_RUNTIME_BINARY=/path/to/hook-lab/target/debug/examples/repoing_curve_runtime \
  node --test tests/hooklab-curve-runtime.test.mjs
```

The test refuses ELF hash drift and explicitly skips without its runtime binary. It ran locally;
ordinary quick CI does not execute the Rust/SBF test. Both self and separate-recipient round trips
buy 101 quote for 667 base, then sell 667 base for 100 quote. All raw account bytes, reserves,
volumes, swap counters, unchanged protocol fees, owner/executable/rent metadata and native balances
are checked. Each two-signer attempt charges exactly 10000 lamports to the synthetic payer only.
Buy minOut668, sell minOut101, wrong Kit placeholder and paused config are refused with account
rollback. Valid execution stays within the reviewed 400000-CU limit. Rent-exempt fixture accounts
use the runtime's `u64::MAX` rent-epoch sentinel; no rent metadata change is silently ignored.

The missing custom-token ELF was recovered from existing Hook Lab CI run **38808508085**, artifact
**12008331886**, named `hardened-candidate-production-b3dc4297735fe2e061fca7b6563d69cf81e0911c`.
Its `production/bordrless_token.so` independently passed the same pinned `gh attestation verify`
checks above using that artifact's `ci/provenance.sigstore.json`. The runtime test pins SHA256:

| ELF | SHA256 |
| --- | --- |
| launch | `faa3d46728a4848789413c3f55599b116bfa5984e371504e4f56afcccc88f9ec` |
| swap | `abda98457f24e5581ba8fe82cbe9caabfb8f39c4323fee8f972046c9003ecc62` |
| token | `3d6b8dc962b74da69984e783d94da5369d5850584d2e3c6ee525b7a641c81241` |

This extends instruction parity to local SBF compatibility. It does not establish a creator/grant
creation lifecycle, nonzero-fee policy, real liquidity/custody availability, live history or Hooks parity.

An additional read-only check on 2026-10-16 observed the deployed custom-token ProgramData at
finalized slots 457789834/457789833 through the two public RPCs. Its complete data SHA256 remains
`ce477d831af66664ce6f5ae6c6ad13ae619270be045dffd2bbb8cf057a8e5b27`, matching the frozen producer
dependency observation. Its 326504-byte ELF payload hash is
`7aa07deb41a5545bcaff0d3fb966d5344538ec8f5c9f2155db4de030e3255df1`, **not** the source-built token
hash above. A temporary copy of the same runtime test, changing only the token hash and test label,
passed with that observed payload and the frozen launch/swap ELFs: both recipient modes, exact
round-trip state and refusal controls. The temporary test was removed; no runtime pin was adopted.
This checks that observed binary's compatibility on synthetic unsigned state, not its source-build
equivalence or historical execution. The launch/swap candidate accounts were absent on both RPCs;
the current quote-account full data hash also differed from the frozen proposal. A refreshed reviewed
dossier is required; no mutable-supply exception or deployment/trading approval follows from these reads.

## Alert drill and review runbook — delivery remains opt-in

`createCurveEmailSender` uses the fixed Resend API and captures a server-owned recipient/sender.
It requires **all** of `HOOKLAB_CURVE_EMAIL_ENABLED=true`, `HOOKLAB_CURVE_ALERT_FROM`,
`HOOKLAB_CURVE_ALERT_TO` and `RESEND_API_KEY`; no builder-reminder feature or consent is reused.
Keep the private destination and API credential out of source, public responses and logs. Configure
credentials through the private secret store, never a command argument or thread message. The sender
must be verified with the provider. No worker, public route or deployment is enabled by this module.
The outbox supplies a stable journal/event idempotency key. Provider conflicts, timeouts, 5xx,
malformed successes and lost responses remain `unknown`, never automatically retried. Resend's
24-hour key retention is only an extra defense; the durable unknown/claim state is the retry boundary.

`node scripts/check-hooklab-curve-email.mjs` checks configuration without sending. After separate
destination/drill approval, `node scripts/check-hooklab-curve-email.mjs --send UUID` sends one clearly
labelled synthetic alert. Before HTTP it exclusively claims and fsyncs a private record in
`.amp/hooklab-curve-email-drills/`; it retains only hashes, timestamps and the provider outcome/ID.
The same UUID can never send again, including after a crash or unknown response. Preserve that
directory across process restarts and archive the record privately; an orb-local file is not an
off-site backup. Do not delete claims or choose a new UUID to retry an ambiguous send. Provider
acceptance is not inbox delivery or human acknowledgement: both flags remain false. Retain the
recipient's separate acknowledgement and escalation evidence before claiming a real drill passed.
Local loopback tests exercise this adapter and its journal integration; no real email has been sent.

| Retained outcome | Required operator action before any further execution |
| --- | --- |
| `sent` with message ID | Confirm the approved private recipient actually received it; retain acknowledgement separately. A provider ID is not human acknowledgement. |
| `failed`, attempts below three | Only the sender's proved-nondelivery outcome may retry after its bounded delay. Verify the approved destination/configuration. |
| `failed`, attempts three | Escalate manually through an already approved channel; do not reset attempt counts. |
| `unknown`, including stale `sending` | Inspect provider delivery history using journal/event identity. Do not resend automatically; a lost response may already have delivered. |
| Conflicting/missing trade evidence | Preserve signed bytes, ordered events and held budgets; keep submission disabled. Never rebuild/re-sign or use later account reads as historical proof. |

The disposable PostgreSQL/loopback-HTTP drill checks successful delivery, lost responses,
concurrent workers, bounded retries, exhausted retries after reconnect, crash-after-claim quarantine,
durable operator review records and overdue-acknowledgement escalation. It sends no transaction
bytes or credentials in alerts. A real drill requires an approved private destination and escalation
owner, a uniquely labelled synthetic incident, retained provider ID plus the recipient's acknowledgement,
an ambiguous-delivery exercise with no resend, and restart/recovery evidence. Record each approved
operator action via `recordCurveAlertReview` with the hash of the retained evidence; that row alone
does not prove the external action happened. No real channel drill was performed. Web stop is not
on-chain re-pause; neither action is authorized here. Emergency re-pause, when separately authorized,
must never wait for receipt acceptance or alert acknowledgement.

## Adoption and delivery stops

Plain launch/auth/readiness/UI/monitor work remains owned by its existing consumer thread. Its
published changes are now on main; no unpublished consumer work was copied here.
`src/hooklab-curve-schema.sql` is a **candidate**, not a registered migration:
the consumer owns 0082. Assign numbering during authorized integration, inspect all pending
migrations and approve encrypted backup/disposable restore before shared application. Preserve
journals on rollback. No shared database, web, on-chain or consumer activation has been performed.

Local validation additionally performed `pg_dump` → authenticated AES-256-GCM encryption/decryption
with tamper refusal → independent `pg_restore` on synthetic disposable databases. All seven populated
curve tables, plain recovery, migration ledger, exact messages/partials/archives/proofs/audit,
stopped holds, alert reviews and index definitions matched after restore. The key was ephemeral and
local; this does not validate production key recovery or the owner's backup system.

Migration adoption must follow this order; these are gates, not commands approved for a shared DB:

1. Inventory the exact target database/deployment identity, PostgreSQL version, applied migration
   hashes/order and all pending migrations at the integration head. Fetched `origin/main`
   at `b2afc0f1449fb1d2ded7e4cd49d9ae064a53e881` ends at idx82, version7,
   `0082_hook_lab_plain_authorization`, when1792173600000. This is repository inventory, **not target DB
   inventory**. No shared application of consumer0082 or curve tables is established by this inventory.
2. Agree final merge order with the consumer; allocate the next collision-free tag/index/timestamp
   only then. Review exact schema SQL/hash and pending changes. The seven curve tables remain
   unregistered. Do not use `IF NOT EXISTS` to conceal partial installation or drift.
3. Take an owner-approved encrypted backup under the target retention/key-access policy; verify
   its checksum, decrypt and restore into a disposable database. Retain schema/ledger and exact
   journal/partial/proof/archive/hold/alert-review comparisons, including foreign keys and indexes.
   Local synthetic dump/restore is not proof that production credentials, encryption or backup work.
4. Apply the proposed migration transactionally with bounded locks to the disposable restore; verify
   no plain rows or migration history were changed. The committed migration test applies all current
   registered migrations, forces a final-table collision and checks rollback of all six earlier
   creates, successful installation, repeat refusal and preservation of plain recovery/events/ledger.
   It passed again with the published consumer0082 in the registered ledger. It does not establish
   a future final integration order or verify the schema/data of a shared target database.
5. Obtain separate exact shared-write approval before any target migration. Keep all HTTP mutations
   423 and trading disabled before/after rollout. Roll back service/read flags, **not journals**;
   never drop recovery tables or release holds as a rollback shortcut.

Remaining gates: review/acceptance of the local production-ID runtime evidence; accepted trading-policy/adapter
provenance and fresh deployment/governance/history verification; authenticated consumer wiring;
quote funding/custody; approved private delivery/restart/escalation drill; acceptance/integration of
candidate reservations; then separately approved exact deployment/creation/unpause/trade/re-pause stages.
Unpause is global, not trader-private. Re-pause also blocks LP withdrawal. Web disable does neither.
There is no defensible live-user ETA until these gates have owners, accepted evidence and approvals.

Local validation: `node --test tests/hooklab-curve.test.mjs tests/hooklab-curve-db.test.mjs tests/hooklab-curve-migration-db.test.mjs`.
The DB tests create and drop only random disposable databases on `127.0.0.1:55432`, using the
repository's existing test PostgreSQL configuration. The migration test applies the committed
registered migrations and then the unregistered curve schema, only in that disposable database.
Fixtures/signatures are synthetic and ephemeral; no production signing or RPC writes occur.
