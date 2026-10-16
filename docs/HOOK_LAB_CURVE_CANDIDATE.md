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
  transaction-slot history. An authenticated replay/archive adapter is still required.
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
  Invoke only after private destination approval. No scheduler, real destination or escalation
  acknowledgement is installed; local HTTP tests do not prove private production delivery.
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

## Alert drill and review runbook — no production destination configured

| Retained outcome | Required operator action before any further execution |
| --- | --- |
| `sent` with message ID | Confirm the approved private recipient actually received it; retain acknowledgement separately. A provider ID is not human acknowledgement. |
| `failed`, attempts below three | Only the sender's proved-nondelivery outcome may retry after its bounded delay. Verify the approved destination/configuration. |
| `failed`, attempts three | Escalate manually through an already approved channel; do not reset attempt counts. |
| `unknown`, including stale `sending` | Inspect provider delivery history using journal/event identity. Do not resend automatically; a lost response may already have delivered. |
| Conflicting/missing trade evidence | Preserve signed bytes, ordered events and held budgets; keep submission disabled. Never rebuild/re-sign or use later account reads as historical proof. |

The disposable PostgreSQL/loopback-HTTP drill checks successful delivery, lost responses,
concurrent workers, bounded retries, exhausted retries after reconnect, and crash-after-claim
quarantine. It sends no transaction bytes or credentials in alerts. Real private destination,
human acknowledgement, escalation owner, backup restoration and production restart evidence still
require separate acceptance. Web stop is not on-chain re-pause; neither action is authorized here.

## Adoption and delivery stops

Plain launch/auth/readiness/UI/monitor work remains owned by its existing consumer thread and is
not imported here. `src/hooklab-curve-schema.sql` is a **candidate**, not a registered migration:
the consumer owns 0082. Assign numbering during authorized integration, inspect all pending
migrations and approve encrypted backup/disposable restore before shared application. Preserve
journals on rollback. No database, web, on-chain or consumer activation has been performed.

Remaining gates: production-ID runtime round-trip acceptance; accepted trading-policy/adapter
provenance and fresh deployment/governance/history verification; authenticated consumer wiring;
quote funding/custody; approved private delivery/restart/escalation drill; acceptance/integration of
candidate reservations; then separately approved exact deployment/creation/unpause/trade/re-pause stages.
Unpause is global, not trader-private. Re-pause also blocks LP withdrawal. Web disable does neither.
There is no defensible live-user ETA until these gates have owners, accepted evidence and approvals.

Local validation: `node --test tests/hooklab-curve.test.mjs tests/hooklab-curve-db.test.mjs`.
The DB test creates and drops only a random disposable database on `127.0.0.1:55432`, using the
repository's existing test PostgreSQL configuration. It applies only the candidate schema there.
Fixtures/signatures are synthetic and ephemeral; no production signing or RPC writes occur.
