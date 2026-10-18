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
  minimum output is binding. Slot and impact ceilings remain review-only bounds:
  a proven finalized execution exceeding either is retained as `review-required`,
  not an approved successful operation. The UI preserves the actual execution
  receipt and never treats policy review as permission to resend.
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

## Isolated local browser setup and acceptance

The local adapter is development-only, not a production adoption path. Use
`scripts/hooks-local-server.mjs`; do not enable a production signer or point
the local database at production. The launcher and trade pages are:

- `https://localhost:3443/hooks/launch-review`
- `https://localhost:3443/hooks/trade`

On this Mac the accepted state directory is
`/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/acceptance-2`.
Its `local-chain.public.json` identifies the non-mainnet genesis, disposable
database, synthetic public roles and setup receipts. TLS material and the
local signer-encryption key stay outside source in that private directory.
Never copy wallet/keypair files into the repository.

With the existing local PostgreSQL, private validator and fixed TCP bridge
running, restart only the app from the app clone:

```sh
env NODE_ENV=development \
  NODE_EXTRA_CA_CERTS=/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/acceptance-2/local-cert.pem \
  HOOK_LOCAL_ACCEPTANCE_STATE=/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/acceptance-2 \
  /usr/bin/sandbox-exec -f scripts/hooks-local-macos.sb \
  node scripts/hooks-local-server.mjs
```

Select **Local hooks test wallet (synthetic only)** and sign in. No production
wallet, extension permission or seed import is needed. Local quote assets are
unbacked synthetic native assets with nine decimals, not wallet SOL or SPL
tokens. The tested creator rate is 100 bps and wallet cap is 200 bps; neither is
production approval.

### Isolation and reproducibility

- The app rejects production mode, a mainnet genesis, non-loopback endpoints
  and non-disposable database scope. Its two HTTPS proxies reach the same
  validator; they are not independent production-provider evidence.
- The macOS app sandbox denies external outbound networking and access to
  the production custody directory. The validator runs on the private
  `hooks-local-only` network; the TCP bridge has fixed RPC/WS destinations.
- `hooks-local-genesis.mjs` and `hooks-local-initialize.mjs` are only for a
  **new** empty local environment. Initialization refuses an existing config.
  Never reset the current ledger or rerun setup to recover an uncertain
  signing operation.
- A new state directory must be visible through the existing narrow Colima
  state share. Do not expand VM mounts to the home or production custody
  directories. Use a new ledger volume and database for a separately approved
  disposable run; retain the previous environment.
- Rebuild instructions are in the supplied reproducibility supplement and
  `scripts/hooks-local-linux-build.sh`. The accepted rebuilt launch/swap/gate
  ELFs are 759,976 / 554,808 / 188,960 bytes. The external token ELF is a pinned
  recovered dependency, not proof of reproducible token-source provenance.
- The required public gate ABI is
  `vendor/hooklab-event-abi/inclusive-max-wallet-candidate/hook_max_wallet.json`.
  Its exact ignore exception must remain; it is not permission to unignore
  wallet/keypair material generally.

### Local runtime image and disk safety

Use `scripts/hooks-local-runtime.Dockerfile` for the validator and TCP bridge,
not the much larger Rust compiler image. The existing Agave 4.3.0 binaries
stay in `hooks-local-tool-cache`; this does not rebuild or replace programs.
The validator script still verifies all four ELF hashes before startup.
Use a **Dockerfile-only context** inside the existing narrow VM share, never
the private state root or custody directory. The Mac's legacy builder stalled;
the private VM already provides Buildx, so run the build there:

```sh
runtime_context="$(mktemp -d /Users/clubpenguin/Documents/ChatGPT/hooks-local-state/runtime-build.XXXXXX)"
install -m 644 scripts/hooks-local-runtime.Dockerfile "$runtime_context/Dockerfile"
colima --profile hooks-local ssh -- docker buildx build --load \
  --platform linux/amd64 --tag hooks-local-runtime:agave4.3.0 \
  --file "$runtime_context/Dockerfile" "$runtime_context"
rm "$runtime_context/Dockerfile"
rmdir "$runtime_context"
```

Keep the same narrow state/tool-cache/ledger mounts and private networks when
switching images. Do not reset a ledger, rerun initialization, create a new
genesis or change program/ALT pins merely to restart the runtime. The bridge
mounts its fixed Python file read-only and has no custody mount.

The 2,400,000-shred retention setting is not a total VM disk quota: accounts,
snapshots and compaction also use space. Keep disk headroom before extended
testing. Only task-owned unused build/runtime artifacts may be reclaimed
automatically; preserved ledgers and databases are not cleanup targets.

The dedicated VM's ext4 data mount was live-remounted with `discard`, then
trimmed, so freed VM blocks return to the Mac's sparse disk instead of
accumulating after compaction. This did not delete a ledger or database.
The live mount option must be rechecked after a VM restart. Only apply this
to this dedicated profile's confirmed ext4 data mount, not the host disk:

```sh
colima --profile hooks-local ssh -- findmnt --noheadings --output FSTYPE,OPTIONS /mnt/lima-colima-hooks-local
colima --profile hooks-local ssh -- sudo mount -o remount,discard /mnt/lima-colima-hooks-local
colima --profile hooks-local ssh -- sudo fstrim -av
```

After the runtime-image switch, the same genesis, program ELF bytes, active
38-address ALT and all post-collection balances were verified without a reset,
reinitialization or transaction replay. Bounded history had already pruned
the original acceptance transaction slots from RPC; their immutable
first-finalized receipts and signed bytes remain in PostgreSQL and the saved
acceptance report. Preserving a ledger volume is not a promise of unbounded
historical RPC availability. Pending operations still fail closed when their
required receipt cannot be read; never relax that check or replace a
wallet-issued message to compensate. `runtime-resumed.public.json` records
the exact current-history boundary and preserved state.

### Why the launch-stage ALT is separate

The preparation's original config and evidence stay immutable. Once the
confirmed preparation resolves the per-launch accounts, the local provider
creates and extends a real 38-address table for that root operation. It checks
the table owner, authority, exact inventory and activation before compiling
the launch. Table provisioning completes **before** the fresh review lease
starts; otherwise finality waits consume the wallet's signing window.

Each provisioning step retains its original signed bytes and submission claim
before sending. Unknown outcomes reconcile that signature only. Revalidation
uses `allowCreate: false`; a refresh/get must not silently create another ALT.
The transaction compiler, wallet checks and sender retain the 1,232-byte
limit. No account-validation or fee-model exception is used to make it fit.

### Verified local result, 2026-10-18

One fresh genesis/database completed the real browser flow. Every row below
finalized within its reviewed slot ceiling, with all Ed25519 signatures
verified and one RPC submission per browser transaction.

| Browser transaction | Fully signed serialized bytes | Signatures |
| --- | ---: | ---: |
| Preparation | 809 | 3 |
| Launch | 821 | 3 |
| Native trading holding | 338 | 1 |
| Buy | 705 | 1 |
| Sell | 705 | 1 |
| Fee collection | 655 | 2 |

The launch consists of a 628-byte message, 192 signature bytes and one count
byte. The packet has 411 bytes of headroom, without changing contract semantics.

| Execution | Gross creator fee | Platform floor(gross / 4) | Creator remainder |
| --- | ---: | ---: | ---: |
| Buy | 10,002 | 2,500 | 7,502 |
| Sell | 4,954 | 1,238 | 3,716 |
| Collected, raw quote units | 14,956 | 3,738 | 11,218 |

Rounding occurs per swap, not after summing gross fees. Collection cleared
creator/protocol accruals and left the pool's pricing reserve unchanged.
There was no additional platform surcharge.

The actual collection receipt is
`3uSCin13UNNPbeA8J11Sc1TK5j1ukCGu8Kz2SdP35KfoEq7oFFuYhXe3Jn9MTRg624xWEy4sqHEJahEyq8dwtkQu`
at finalized local slot 1,834. Recipient balance deltas independently match
the accrued split:

| Raw native-quote account | Before collection | After collection | Change |
| --- | ---: | ---: | ---: |
| Creator `7bbS…msf` | 9,999,999,490,190 | 9,999,999,501,408 | +11,218 |
| Platform `9Wo1…Wo7` | 0 | 3,738 | +3,738 |
| Creator accrual | 11,218 | 0 | -11,218 |
| Protocol accrual | 3,738 | 0 | -3,738 |
| Pool pricing reserve | 494,854 | 494,854 | 0 |

These are nine-decimal native-quote token units on the isolated validator,
not mainnet SOL receipts. The synthetic quote is unbacked.

The same run verified:

- Above-cap server review returned 409 without a signing row. A genuinely
  signed, signature-verified simulation against the rebuilt gate failed with
  `CapExceeded` / custom error 6001; it was never broadcast.
- Wallet rejection retained no signature. Recovery used the original signing
  ID and exact message, not a replacement quote.
- A deliberately lost real RPC send response reconciled the original
  signature. A second submit returned 409; the audit retained one send.
- Natural unsigned expiry hid signing and returned 409 from wallet-request,
  with no issuance marker or signature. Explicit unsigned refresh preserved
  the financial intent and ID. The already-signed expired-message guard made
  zero simulation and dispatch calls.
- The prior expired partial collection remained in the old database with its
  original wallet signature, no admin signature and no submission claim.
  Owner-selected fresh isolation did not erase or recover that operation.

Actual IDs, public balance deltas, receipts, RPC send audit and screenshots
remain outside source under the state directory, principally
`consolidated-acceptance.public.json`, `browser-launch-success.png` and
`browser-trading-acceptance.png`. The throwaway balance reader was corrected
after sell; no financial transaction was replayed.

For repository-wide regression checks use the existing grouped
`scripts/ci/run-tests.mjs` runner on **separate disposable CI services**.
Blanket root `node --test` mixes incompatible database environments and also
discovers SDK/spike suites outside that runner. Do not let CI reset the
preserved acceptance databases or ledgers. Historical Rust vectors omitted
from the source-only archives require authentic independently generated
artifacts; do not fabricate expectations to obtain a green check.

Production approvals, public custody references, the retained-E73/B2 upgrade
budget and the single owner approval checklist are in
`HOOK_FRESH_DEPLOYMENT_REVIEW.md`.

### Frozen owner handoff

The accepted environment stays running at
`https://localhost:3443/hooks/launch-review` and
`https://localhost:3443/hooks/trade`. No feature or runtime code changed
after the owner requested the freeze; no service restart or financial
replay was performed for the handoff.

The accepted genesis is `EZQnEdWBjWRvJnbF9M32QeLaoxYjA5LcJKNtqYcvo7Re`,
root `6d89e035-0245-4625-a33f-26a48ea78691`, and mint
`3nemupoa5P2dhtj5nbZHrvgJqqQTMXLmzEdW5aWgKjng`.
The warmed per-launch table is
`CHChD6gN9sVz7x4ANq4MSrwLX8yXh8XGCGiVSFEPb1Zs`, with 38 addresses.
Launch receipt
`5LtMRHXMNvomgUb3ydPaYvDEpRqT74xyJMXsKTxUgeTXTEgMaJ1faDudbB11q81H2KVb9ZnFLbKzoNyh3KdC4249`
finalized at slot 1,061 with the measured 821-byte fully signed wire.

Original first-finalized evidence, canonical signed wires and the complete
consolidated report remain in the preserved local database/state directory.
Later ledger retention pruned those early slots from current RPC history;
`getTransaction` is not claimed to remain archival. Post-storage runtime
read-back retained the same genesis/program bytes/ALT/balances. Missing
historical RPC evidence still fails closed; it never grants permission to
resend. The final report separates the blocked 17 fixture-dependent legacy
regression entries from the passing browser acceptance and 8/8 guard smoke.

## Release check

Generated ELF-derived fixtures and the pinned ELFs stay private and untracked. Without them, the
required quick CI lane skips each dependent test with a reason that starts
`missing private hook artifact:` and names the variable to set. Those skips are not release
evidence. Before a hooks release, run the complete hooks suite with the artifacts supplied:

```sh
scripts/hooks-release-check.sh            # or pass specific test files
```

It runs `tests/hooklab-*`, `tests/hooks-*`, `tests/hook-*` and
`tests/programmable-coins-page` serially with `HOOKLAB_CANARY_REQUIRED=true`. It stops at once
if PostgreSQL is unreachable on `127.0.0.1:55432` (user `postgres`, password `launchtest`). The
`*-db` tests create and drop their own scratch databases there. The final summary lists
tests, pass, fail and skip counts with every skip reason. The check exits non-zero on any
failure and on any missing-artifact skip.

| Variable | Supplies |
| --- | --- |
| `HOOKLAB_GENERATED_FIXTURE_DIR` | max-wallet, buy/sell and custom-hook Rust vectors; buy/sell app plans |
| `HOOKLAB_INCLUSIVE_GENERATED_FIXTURE_DIR` | `inclusive-builder-vector.json`, `inclusive-post-launch-snapshot.json` |
| `HOOKLAB_INCLUSIVE_TOKEN_ELF` | rebuilt inclusive `bordrless_token.so` |
| `HOOKLAB_CANARY_ELF_DIR`, `HOOKLAB_CANARY_PYTHONPATH` | the four pinned inclusive ELFs; solders 0.29.0 |
| `SBF_OUT_DIR`, `HOOKLAB_CURVE_RUNTIME_BINARY`, `HOOKLAB_CURVE_PARITY_BINARY` | frozen production curve ELFs and the two Rust harnesses in `HOOK_LAB_CURVE_CANDIDATE.md` |

The script header documents the defaults for the maintainer Mac's `hooks-local-state`. The two
curve harness binaries have no default. They must be built from the frozen Hook Lab checkout.
Until both variables point at them, the check reports two missing-artifact skips and fails.
