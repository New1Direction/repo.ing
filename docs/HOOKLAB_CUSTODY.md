# Hook Lab client custody and recovery foundations

**Client-only retention adopted; execution disabled.** The recipe planner can create/unlock/lock retained identities after a matching read-only inspection. It can also enumerate retained local journals and explicitly unlock for recovery without any wallet or RPC, permanently invalidating that attempt's reviews. A program upgrade or failed inspection must not hide retained identities. These modules make no RPC requests, generate no transactions, sign nothing, and submit nothing. They never import the existing mainnet-pinned wallet signer. No server route imports them. Tests use disposable keys, mocked storage/status evidence, and local browser IndexedDB only. See `DIRECT_COINS.md` for the adoption and remaining gates.

## Ownership and integration boundary

- `app/lib/hooklab-custody.mjs`: Web Crypto identity creation, encryption, binding checks, append-only step records, and explicit public projections.
- `app/lib/hooklab-custody-store.mjs`: browser IndexedDB persistence, with strict durability requested and atomic compare-and-swap (CAS).
- `app/lib/hooklab-reconciliation.mjs`: pure interpretation of externally supplied transaction-status evidence. No storage writes, retries, or hidden RPC.

The wallet-first planner and its v1 non-secret device drafts remain separate. Do not put custody envelopes, passphrases, secret keys, reviewed messages, or signatures in those drafts, server requests, analytics, logs, or React/server props. `publicIdentity()` is the only projection intended for future server requests: public wallet/mint/config addresses and versioned binding metadata, never signer material or signed bytes. `snapshot()` is for local recovery inspection, not a server payload; although it contains no private keys, it can contain signatures and message bytes.

## Versioned binding

`normalizeHookLabBinding()` validates and copies this allowlisted shape:

```js
{
  schemaVersion: 'hooklab-binding/1',
  wallet,           // Base58, 32-byte public key; not proof of wallet ownership
  genesisHash,      // Full 32-byte hash, not a display name or shortened wallet chain ID
  recipeDigest,     // Lowercase SHA-256 hex of the future canonical recipe representation
  manifestDigest,   // SHA-256 of the exact approved manifest bytes
  programs: [{ address, sha256 }], // Program executable hashes; at least one pin
  configs: [{ address, sha256 }],  // Existing account-data hashes; may be empty
}
```

Program/config lists are sorted by address and duplicate addresses are rejected. List ordering does not change the binding. The manifest digest must bind any additional ABI/IDL, owner, authority, and hashing-convention expectations. These are supplied pins, not a claim that the module has inspected chain state.

Future adoption must call `checkBinding(currentBinding)` on wallet, network, recipe, manifest, or pin changes and `checkBinding(null)` on disconnect. Unlock requires the current binding (or explicit `null`), rather than silently restoring consent. A changed/unknown binding permanently appends `binding-invalidated`; switching back does not revive that vault's review consent. Invalidation blocks queued/new reviews immediately, even when its durable write fails. It preserves identities and existing records. Verified signature and submission **observations** may still be appended for recovery after invalidation or expiry; this does not authorize signing or sending.

## Encrypted identity retention

```js
const store = await openHookLabCustodyStore()
const custody = await createHookLabCustody({ store, id, binding, passphrase })
// Only after this resolves have both generated identities been durably retained.
const publicRequest = custody.publicIdentity()
custody.lock()
const recovered = await unlockHookLabCustody({ store, id, binding, passphrase })
```

Creation generates independent Ed25519 mint/config key pairs using browser Web Crypto and stores their private keys as PKCS#8 **inside the encrypted record only**. Neither API exposes private keys or signing handles. An existing ID is never replaced; missing/corrupt storage or a wrong passphrase never triggers identity regeneration. This v1 reserves one mint and one config identity; recipe-specific config/PDA requirements must be settled before adoption.

Envelope v1 uses PBKDF2-HMAC-SHA-256 (600,000 iterations, fresh 16-byte salt per vault), a nonextractable in-memory AES-256-GCM key, a fresh 12-byte IV per write, and authenticated data `hooklab-custody/1:<id>`. The entire private state, binding, revision, and journal are encrypted/authenticated together. The passphrase is not stored or derived from a publicly observable wallet signature. Minimum length is 16 characters; that check is not an entropy guarantee. No key or recovery service exists on the server.

`lock()` drops session references; temporary byte buffers are zeroed where practical. JavaScript strings, garbage collection, and browser internals prevent guaranteed memory erasure. Encryption protects copied at-rest storage, **not** an unlocked origin compromised by XSS/extensions, a weak passphrase, or a compromised device. Ciphertext can be attacked offline. Whole-record rollback/deletion by an attacker or browser cannot be detected without an external trusted checkpoint. Browser eviction/cleared storage and a lost passphrase can destroy recovery; local retention is not a backup. No export/import, password reset/rotation, or cross-device recovery flow is provided.

## Journal contract

All journal writes resolve only after IndexedDB transaction completion. Each append increments `revision`/`sequence`; concurrent writes in one session serialize. CAS compares the exact previous ciphertext in a single read-write transaction, so another tab's committed state cannot be overwritten. A stale session locks and must be reopened. Quota/abort errors do not acknowledge a step and do not fall back to volatile storage. A lock during a write may leave that write durably committed; reload to inspect the outcome. Never infer failure from a rejected caller promise alone.

The journal has a 1 MB plaintext limit; reaching it rejects the next append and preserves the previous record. Each step has exactly one immutable review. This increment deliberately has no refresh/replacement/retry API; changed blockhashes require a separately reviewed future attempt model, not mutation of the existing review or regeneration of mint/config identities.

| Method | Stored contract |
| --- | --- |
| `recordReview({stepId, messageBytes, requiredSigners, expiry, reviewedAtBlockHeight})` | Copies exact opaque `Uint8Array` message bytes before any await, retains base64 + SHA-256, signer order, and `{blockhash, lastValidBlockHeight}`. First signer must be the bound wallet; other signers must be the retained mint/config. Expired-at-review input is rejected. |
| `recordSignature({stepId, signer, signatureBytes, observedBlockHeight})` | Verifies Ed25519 over the retained message bytes, then appends immutable Base58 signature evidence. No signing occurs. Rejects unknown signers, duplicates, and heights preceding review. Late observations remain recordable after expiry. |
| `recordSubmissionObservation({stepId, signature})` | Requires all reviewed signatures and the exact fee-payer signature. Appends `submission-unknown` once; it does not broadcast or claim chain acceptance. |
| `checkBinding(bindingOrNull)` | Appends permanent binding invalidation; keeps all recovery evidence and original identity pins. |

Snapshots and public projections are deeply frozen detached copies. The journal accepts opaque message bytes: it **does not** parse Solana transactions, resolve lookup tables, prove the blockhash/signer metadata matches those bytes, inspect instructions, verify economics, validate program-account postconditions, or establish user consent. Those are obligations of the future pinned builder/review layer. The tests intentionally use asymmetric opaque byte fixtures rather than executable transactions.

## Finality evidence is not permission to retry

`reconcileHookLabStep(snapshot, stepId, evidence)` is pure. The caller must provide evidence from a trusted read-only source on the pinned genesis and for the retained fee-payer signature:

```js
{
  genesisHash,
  signature,
  finalizedBlockHeight, // Block height, not slot; optional when status exists
  status: null,         // Or { slot, confirmationStatus, err }
}
```

It returns `unreviewed`, `reviewed`, `invalidated`, `expired-unproven`, `partially-signed`, `ambiguous`, `pending-finality`, `finalized-success`, or `finalized-failure`. Every result has `executionEnabled: false`, `canRetry: false`, and `launchReady: false`.

- Processed/confirmed successes **and errors** remain pending finality because forks may drop them.
- Wrong genesis/signature, missing status, and incomplete finality evidence remain ambiguous. A history search or blockhash expiry is not proof that a signed transaction never landed.
- A review expires only when finalized block height is **greater than**, not equal to, its recorded last-valid height. No locally recorded signatures still does not prove non-submission.
- Finalized transaction success is distinct from verified account postconditions and overall multi-step launch completion. Partial setup is never rolled back or resumed automatically.
- The evaluator does not authenticate RPC data or persist an observation history. A future read adapter must preserve source/slot evidence and independently verify account ownership, contents, expected identities, and pins at finalized commitment before any launch-readiness claim.

## Decisions required before separate adoption

1. Canonical recipe hashing and the pinned builder/review contract, including transaction decoding, exact economics, lookup tables, blockhash provenance, and signer matching.
2. Passphrase creation/confirmation UX, device KDF performance/security review, browser support, encrypted backup/export, loss warnings, and storage-persistence handling. Stronger/passwordless custody is not decided by this prototype.
3. Recipe-specific config/PDA inventory and a fresh-consent attempt model that retains original identities and immutable old attempts after a binding change or expiry.
4. Trusted read adapters, durable provenance for finality observations, account postcondition checks, crash windows around future wallet prompts, and an explicit manual recovery policy. No current method authorizes execution.

Run the isolated mocked tests with `node --test tests/hooklab-custody.test.mjs tests/hooklab-readonly.test.mjs`. No chain, faucet, funding, deployment, or real wallet is needed.
