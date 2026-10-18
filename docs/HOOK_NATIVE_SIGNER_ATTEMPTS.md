# Durable signer attempts and exact recovery

Apply hooklab-native-signing-attempt-schema.sql after the signing schema. Each
server signer invocation has a unique (operation, signer) attempt bound to the
retained message hash. The claim and signing-claimed status commit BEFORE a signer
callback. Ambiguous claim commit never invokes the callback. A claimed/unknown
attempt cannot be invoked again. This supersedes patch24's retry/expiry limitation.

A valid returned signature is retained in the same custody/signing transaction,
including natural session expiry while the already-authorized callback was running.
The session was checked and share-locked before invocation; logout cannot interleave.
Skipping the post-callback expiry check permits only retention of that exact claimed
signature. It does not permit a new signer, new prompt or send. Those actions again
require a current authenticated session, fresh resolver evidence and an unexpired
review. An expired session cannot read the operation until reauthenticated.

Callback exceptions, invalid/zero signatures, lost replies and signature-save failures
leave a claimed/unknown signing outcome. They preserve prior partials and prohibit
another invocation. retainRecoveredServerSignature accepts only a nonzero valid
signature for the exact pending public key and retained message; no message/key/stage
selection is accepted. It is an observation-recovery endpoint, not signing authority.
On ambiguous completion, read the durable operation first. Never regenerate a mint
or ask the signer again merely because a response was lost.

Launch beginStage also canonicalizes the full resolver-supplied launch request and
requires its preparation subset to equal the immutable custody intent (creator,
fee payer, mint, selectedConfig, cap and label included). The exact launch intent
hash must equal the reviewed message's intent hash. It cannot substitute another
prepared configuration under the same wallet/profile.

Tests use deterministic synthetic signers only: callback throw/unknown status,
no reinvocation, invalid recovered signature refusal, exact recovery, and natural
session expiry during a callback with durable partial retention. No live signer,
provider, credential or execution flag was configured.
