# Signing/custody transaction integration

This amendment closes the cross-module lock-order gap described in patch23.
With nativeCustodySigningAdapter, the lifecycle locks signing operation, then custody
row, then wallet session SHARE. All resolver/network/journal calls run outside these
locks. After reads, the lifecycle reacquires locks and checks exact revision and
current authenticated owner. Database time rechecks review expiry after lock waits,
before wallet prompt, any server signature and submission claim.

The adapter opens the encrypted mint/config only inside that shared transaction.
Preparation intent is reconstructed through its canonical schema before hashing,
so PostgreSQL JSONB key ordering cannot change the binding. Exact owner/profile,
review bytes/hash/stage and required signer set are checked. Preparation permits
mint/config; launch permits mint and a separately configured admin callback. The
admin must match fresh observed governance and cannot alias owner/mint/config.
No platform key is inferred or reused. Errors remain generic, including resolver
reconciliation errors. Private keys are never returned to the coordinator/client.

Once all signatures are valid, custody moves to stage-signed in the same transaction
as the complete signed wire. Verified reconciliation advances finality or locks
custody into reconcile-required. Ciphertext, partial signatures and uncertain results
are retained. Default-off construction remains mandatory. Actual administrator/key
configuration and network sender remain absent. A trusted signer callback that performs
external I/O must use a bounded service; it runs while the signing transaction is held.

Natural session expiry after a server-sign callback currently rolls back that new
partial/stage update. No send occurs, and prior committed partials and original
review remain retained. The service must not silently retry the signer; an operator
must recover the exact operation. This edge requires further retention hardening
before production readiness. JavaScript zeroization remains best effort.

Tests use deterministic synthetic keys and disposable PostgreSQL. They cover real
AES-GCM custody opening, stage atomicity, no-lock network revalidation, exact wallet
partial validation, separate server signatures and sticky finality. No live signing
or deployment approval is implied.
