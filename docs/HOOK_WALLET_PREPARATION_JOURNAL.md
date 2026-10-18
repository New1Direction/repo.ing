# Wallet-owned preparation collection foundation

This server-only, default-off journal is a new wallet-owned evidence boundary,
separate from the older GitHub-owner journal. No public route imports it, no SQL
migration runs automatically, and no execution flag is changed. It is not the
production launch resolver. `buildMaxWalletLaunchReview` remains closed.

## Implemented boundary

- A configured wallet principal store resolves the server session; caller JSON
  cannot select owner identity. The principal must be wallet-kind, mainnet and the
  general-launcher audience. The preparation creator must be that verified wallet.
- Exact max-wallet profile, provider names, immutable intent, reconstructed message
  and fully signed original wire are verified before the first durable insert.
- Original wire and identity are retained before collection. A timeout leaves an
  identity for evidence reconciliation, never permission to retry a chain action.
- The only evidence-ingestion methods call the existing two-provider collector
  themselves. There is no public `retain(observations)` or accepted-proof callback.
  It reconciles signed wire, block inclusion, finalized receipt, source program
  bytes, prepared account state/economics and current canonical Launch absence.
- Session validity is checked again after external reads and before persistence.
  Identity cannot change across retries; unique mint/signature/intent/message keys
  prevent a new operation from replacing the retained transaction.
- Earliest finalized evidence and first conflict are immutable. Conflicts stay
  sticky even if later observations match. DB reload re-derives plans/signatures
  and replays evidence validation rather than trusting stored status flags.
- Returned summaries omit raw wire, input snapshots, ELF bytes and observations.
  `lastCollectionPrelaunchEligible` describes only the last collection, not a fresh
  authorization. `eligibleForProductionLaunch` and all execution/adoption flags
  remain false. Summary evidence is not accepted launch proof.

## Bounded transport

`preparationReadConnections` constructs two explicitly configured HTTPS readers
without performing any I/O. Distinct provider names and origins are mandatory.
Only getGenesisHash, getTransaction, getBlock and getMultipleAccounts may cross
its transport. Redirects are forbidden, requests/responses are bounded, oversized
streams are cancelled, fetch/body reads have an abort signal, and failures are
redacted. No send, simulate, signer, key generation or wallet method exists.

The connection objects/URLs must remain server-only: URLs may contain credentials.
Distinct origins are not proof of operational provider independence. Approved
provider selection, network policy, trust provenance and real observation evidence
remain operator/reviewer responsibilities. Injection-tested adapters are not live
RPC proof, and `collectionAuthenticated` intentionally stays false.

## Still required

- Independently review this journal and transport, then explicitly choose/approve
  the release profile and provider configuration; do not infer adoption from IDLs.
- Integrate a bounded authenticated preparation HTTP boundary and durable request
  lifecycle with wallet ownership, challenge/transaction review, signer custody,
  admin cosignature and unknown-outcome recovery. There is no submission method here.
- Establish preparation transport provenance, release/dependency code acceptance,
  and fresh launch-state revalidation before implementing a production resolver.
- Verify real browser/wallet behavior and separately authorized live acceptance.

The tests use a fresh disposable PostgreSQL cluster and in-memory RPC-shaped
fixtures only. These are meaningful integration checks, not live deployment proof.
