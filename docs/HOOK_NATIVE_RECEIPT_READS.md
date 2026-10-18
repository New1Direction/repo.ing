# Retained native receipt reads — disabled by default

`GET /api/hook-lab/production/receipts` is a bounded operator read of the existing isolated
native-index tables. It cannot observe RPC, migrate, prepare, simulate, sign, submit, collect,
unpause or approve a deployment. POST unconditionally returns 423 before consuming input.
The general production execution contract remains unchanged, with every capability false.

## Independent server configuration

The existing encrypted GitHub identity session and `PLATFORM_OPERATOR_GITHUB_IDS` immutable-ID
allowlist are required. Anonymous callers receive 401; other accounts receive 403. An authorized
operator receives `status: disabled` without any database/configuration access unless
`HOOK_NATIVE_RECEIPTS_READ_ENABLED` is exactly `true`.

An explicitly approved read rollout additionally needs:

- `HOOK_NATIVE_RECEIPTS_DATABASE_URL`: a dedicated database credential. There is no fallback to
  the app's `DATABASE_URL` or the observer writer's connection. Use a least-privilege role with
  SELECT on only `hook_native_index_streams`, `hook_native_index_blocks` and
  `hook_native_index_transactions`. This patch does not create roles or change permissions.
- `HOOK_NATIVE_RECEIPTS_MANIFEST_FILE`: the exact operator-reviewed `repoing/hook-index/1`
  manifest for one stream, maximum 16 KiB.
- `HOOK_NATIVE_RECEIPTS_MANIFEST_SHA256`: SHA-256 of those exact file bytes. Unknown manifest
  fields, changed bytes, stored-manifest mismatch or unavailable evidence fail closed.

Do not set these on a shared service merely to try the code. The SQL schema remains unregistered
with migrations; isolated observer/schema/backup/provider/retention rollout requires separate
approval. Enabling this read surface never enables execution or makes the stream adopted.

## Query and response contract

Only `limit` (canonical integer 1–50, default 25) and `cursor` are accepted. Duplicate/unknown
parameters and malformed cursors are rejected. Requests cannot select a chain, source, profile,
program, provider, database or RPC URL.

Each page runs a repeatable-read, read-only transaction and has a bounded row count. The connection
also defaults to read-only mode; statements and queries have short deadlines. Rows above 1 MiB are
refused, never silently skipped; the entire response is capped at 1 MiB. Smaller limits may be
needed for unusually large event sets.

Pagination is ascending `(slot, transactionIndex)`. Its canonical cursor binds the entire manifest
stream hash, the first page's inclusive checkpoint bound, and the last returned position. Subsequent
pages cannot switch streams or include newly indexed slots beyond that snapshot. The checkpoint is
retained index progress, not a freshly queried chain head or a claim that history is complete.

The response exposes chain/source/profile/ABI identity, block/transaction positions, signature,
invoked programs, receipt success/failure and decoded events when available. It excludes full RPC
payloads, signed wire bytes, accounts, database credentials and session material. A decoded row is
re-decoded under the exact pinned ABI and compared to retained events; an unsupported new source
must gain its own reviewed decoder profile before decoded reads can pass.

`retainedRawSha256` is the originally retained normalized-JSON hash, not a wire attestation or a
newly authenticated account-history hash. PostgreSQL JSONB can reorder keys; this read surface does
not pretend that re-stringifying JSONB reproduces original serialization bytes.

Every row/page explicitly keeps economic verification, deployment adoption, accepted-trade status
and execution false. A successful outer receipt cannot establish uncaught inner-call success,
economic postconditions, paid fees, accepted trades, volume or exit liquidity. Do not feed these
observations into market metrics or the Playground.

Responses are `Cache-Control: private, no-store` and `Vary: Cookie`. Infrastructure/configuration
errors return a fixed redacted 503; a receipt-read outage never authorizes a retry or replacement.

## Verification

Run the networkless unit/auth/configuration tests:

```
node --test tests/hooklab-native-reads.test.mjs tests/hooklab-native-events.test.mjs
```

On a verified disposable PostgreSQL instance at the existing fixture port 55432, run:

```
node --test tests/hooklab-native-index-db.test.mjs tests/hooklab-native-reads-db.test.mjs
```

The DB tests create/drop uniquely named fixture databases, never shared application databases.
They verify atomic observer checkpoints, restart/concurrency, keyset pages, actual read-only SQL,
JSONB-backed decoding with exact large integers and corruption rejection. Production-build HTTP
verification must exercise both pinned ABI profiles: static asset URLs are explicit to prevent
Turbopack from collapsing a dynamic ABI path to the wrong file.

No UI market feed or write service is enabled by this slice. The next write prerequisite remains a
separately bounded and reviewed custom-creation intent/builder using the chosen reviewed deployment
profile; it must not reuse a historical plain-only builder or infer adoption from this API.
