# Native signing lifecycle: default-off server source

This module supplies a durable lifecycle for an exact reviewed preparation or launch
message. It is not wired to HTTP, a real custody signer, a network sender or deployed
operator configuration. Tests use deterministic synthetic keys and fake transports.
No new live signature, key, credential or RPC send was produced by this work.

Construction requires explicit enabled=true and trusted server resolver/signer/sender
dependencies. Missing dependencies fail closed. A caller-supplied review is never
accepted: createReview obtains it from resolver.prepare and independently validates
message serialization, privileges, signer ordering and stage operation. The owner
is the verified wallet principal and must also be the fee payer. The durable
custody-operation/stage uniqueness constraint prevents replacing an existing message
or creating another signing operation for the same custody stage.

The resolver contract is INTERNAL, not an owner-signature wire format:
- prepare({owner,custodyOperationId,stage}) returns exact review plus owner/stage,
  profileSha256, messageSha256 and status operator-pins-and-state-verified.
- revalidate receives those identities and retained review; before wallet prompt,
  each server signer and submission it must freshly verify operator-approved exact
  deployment pins, stage state, creator grant, custody, fees, simulation and expiry.
- reconcile receives retained exact signed bytes and signature, and returns unresolved,
  finalized-success, finalized-failure or conflict with exact profile/message/signature.
  Its finalized evidence must contain immutable receipt identity, not changing read
  timestamps/current snapshots. First finality and first conflict are sticky.

A finalized-success receipt describes successful on-chain execution, not approval
of an exceeded review-only bound. If the first authenticated finalized receipt
sets `policyReviewRequired: true`, the operation is retained as `review-required`
even without conflicting evidence. The original finalized receipt and signed
wire remain immutable; this state never authorizes another submission.

Operator approval is an explicit deployment process/configuration gate, not inferred
from a supplied digest or fabricated cryptographic owner attestation. The actual
production resolver is a separate integration. An injected status string is trusted
server configuration only and must never be sourced from an HTTP request.

## Signature and submission rules

walletRequest returns the retained review and partial transaction after fresh checks.
retainWalletSignature verifies exact message bytes and all nonzero signatures; only
the authenticated owner's signature slot may change. Existing other signatures cannot
be removed or replaced. A valid wallet response may be retained after REVIEW expiry
for recovery, but a currently valid authenticated session is still required. Re-login
as the same wallet allows recovery; expired/revoked credentials are never accepted.

Each server signer is a separate callback, only after a durable wallet partial exists.
Its returned signature must verify against the exact required public key/message.
Each partial is committed before the next signer is called. Restart preserves all
committed partials. No sign-and-send wallet method or automatic blockhash refresh exists.

submitOnce first performs fresh validation and commits submission-claimed with the
exact signature, before calling the explicit sender. Only one concurrent request can
claim. Exceptions, timeouts, unexpected signature responses and process loss remain
unresolved. They NEVER release a retry. A post-send status write is permitted without
renewed session authority solely to record the exact prior claim, never to send again.
Reconciliation retains the original wire and first finalized/conflicting evidence.
There is no erasure timer, replacement mint, cancel-and-relaunch or automatic retry.

## Remaining integration requirements

The lifecycle owns the signing-operation row then wallet-session SHARE lock. A future
real custody signer/resolver MUST NOT acquire a separate custody transaction after
that session lock: shared cross-module lock ordering must be integrated first. This
patch's synthetic signer has no extra locks. Likewise actual signer stage advancement
must be atomically coordinated with retained partials before a production route is
connected. Full current deployment resolver, two-reader simulation, stage-specific
receipt semantics and safe sender transport are separate reviewed dependencies.

Errors are generic; do not log/serialize callback errors, signer material or transport
credentials. Partial transaction bytes are returned only by the intended authenticated
walletRequest boundary; public summaries do not contain them. Application-level flags
remain false and indicate no activated public authority. A passing synthetic lifecycle
test is not production activation or final live acceptance.

Test with disposable PostgreSQL and external generated fixtures:

    node --test tests/hooklab-native-signing-db.test.mjs
