# Hardened consumer preparation — execution disabled

This is an isolated, inert candidate, not adoption of a deployment. repo.ing is the product
surface; Hook Lab DEX supplies the native custom-token programs. No mainnet identity, economics,
vault, budget, funding route or activation is selected here. No Raydium/Meteora compatibility is
inferred. The frozen `f3c57ccc` vendor, manifests and finalized HLTEST history remain unchanged.

## Source and implemented boundary

Candidate source: [826b5a4](https://github.com/New1Direction/hook-lab/commit/826b5a480dfafbe9395f9e9b9c280d07fc7eb809),
supplied through Hook Lab PR #3, not assumed merged or deployed. Source handoff archive SHA256:
`ab38cb5b12d17008c3f2aeaa3c6e22fff0894bf3d68f4129056fa070d8bd410f`.
Profile SHA256: `4352214b2194a70e45f0b2cf16e10e2a62c29b947574b41a5caeff749c9d87f0`.
The proposed `hardened-devnet` build implies mainnet enforcement but runs on devnet; it is not
the default build or a mainnet deployment. Fresh launch/swap ELF hashes are exposed as **artifact**
hashes in readiness, never claimed as observed chain hashes or verified signing attestations.

`vendor/hooklab-hardened-candidate` is a separate, versioned official-source subset: account
decoders, profile-specific identities/commitments and pure swap arithmetic. No instruction
builder, signer, sender, connection, governance action, Kit or bridge operation is exported.
Raw IDLs retain upstream ABI entries for provenance, not executable permission. Rebuild with:

```sh
# In a separate clean Hook Lab checkout at the exact commit, install its frozen SDK lockfile first.
node scripts/vendor-hooklab-readonly.mjs /path/to/hook-lab hardened-candidate
node --test tests/hooklab-hardened.test.mjs tests/hooklab-recovery-journal-db.test.mjs
```

`hardenedLaunchIdentity` always passes the proposed launch/swap identities to SDK derivations
and program-bound control hashes. It does not authorize a creator or build a transaction.
`previewHardenedTrade` models plain buy/sell math from caller-supplied reserves and effective LP
fees. It separates custom quote-token input from native rent/network/priority costs; priority
uses requested CU and integer ceiling. It validates u64 input, slippage and requested caps, but
does not resolve live reserves, chain time/sniper fees, balances, governance or executable trust.
It is **not a live quote, RPC simulation or on-chain trade guard**. There is no new trading UI.

`GET /api/hook-lab/hardened` publishes proposed identities, artifact hashes and explicit missing
gates. `POST` always returns **423 HARDENED_EXECUTION_DISABLED**, without reading its payload or
calling a wallet, RPC or database. Launch/buy/sell/simulate/review/sign/submit are all false.
No request, environment variable or candidate manifest boolean enables them. A reviewed code
change and separate activation approval are required. Existing read-only HLTEST routes are not
redirected to this candidate. Wallet invocation and browser transaction review are not implemented.

## Durable journal, not a receipt verifier

Migration `0080` adds `hook_lab_recovery_journal` and its transactional event history. There is no
draft foreign key, expiration cleanup, worker or public journal-write endpoint. A future caller
must authenticate account ownership AND wallet possession before preparing anything. The store:

- Binds owner, devnet genesis, candidate manifest, operation, wallet/mint/pool, observed slot,
  blockheight expiry, policy/account digests, requested caps and exact unsigned message bytes.
- Makes identical prepares idempotent, rejects changed intent, prevents duplicate message/signature
  identity and a second launch intent for the same mint, including under concurrent callers.
- Verifies every Ed25519 signature against the stored message, then atomically stores the exact
  signed wire transaction, payer signature and audit event **before a future broadcast**.
- Moves only `prepared → unresolved`. It offers no time-based expiration, automatic retry,
  finalization assertion or unsafe new-mint replacement. A disconnected/reloaded client can
  recover the same entry by owner/id. `canRetry`, `canSubmit`, `chainVerified` remain false.

This verifies signature/byte identity, **not instruction semantics, safe economics, owner launch
approval or a chain receipt**. Do not expose these methods as an API yet. Signed bytes are
broadcastable while valid: protect them like payment records, with owner-scoped access,
encrypted backups and no request/body logging. No private key or seed phrase is stored.
Unknown future schema versions refuse without rewriting records. Retention is currently indefinite;
owner-approved retention/legal policy and terminal receipt-verifier states remain open.

## Exact remaining gate checklist

1. **Freeze reviewed artifacts and live identities.** Verify producer CI/provenance signatures and
   reproducible build feature/ELFs, exact source/SDK/IDL/schema/vectors/lockfiles and whole executable
   dependency graph. Obtain finalized deployment slots, ProgramData linkage/owner/capacity/authority,
   full ELF hashes, canonical config/governance/grant/hook/event PDAs, custom quote mint properties
   and active exact ALT. Compare two independent providers and RPC genesis. Never reuse old HLTEST
   evidence or treat proposed identities as deployment proof. No mainnet RPC is needed now.
2. **Approve authorities, policy and economics.** Verify 348-byte governance and 73-byte creator
   accounts, owner/seeds/discriminators, config projection, distinct roles and collector=treasury.
   Keep raw account hashes, V2 economics hashes, governed configDigest, governance commitment and
   expectedControlHash separate. Establish actual quorum/delay, pause-only guardian, membership and
   approved-queue cancellation, treasury policy and witnessed off-orb recovery. Name creator,
   lifetime cap and exclusive authorization expiry; review launch/pool fees, curve/supply, quote,
   sniper fees and recipients. Proposed devnet EOAs prove no production multisig governance.
3. **Approve exact operation budgets and messages.** Supply launch and separately buy/sell envelopes,
   token input/minimum received, per-account rent, network/priority fees, requested CU, retries and
   reserves. Setup, governance, loader and failed attempts have separate budgets. Quote-token
   acquisition/bridge execution requires separate scope/approval; native SOL is not custom quote
   balance. Creation guards exclude network fees/executable trust; trading has no equivalent guarded
   economics/deadline/native-debit ABI here. Owner/security review must resolve this protection gap
   before a trading builder is exposed; UI preflight cannot guarantee those bounds at execution.
4. **Implement and verify wallet/recovery boundary.** Bind wallet, genesis, message, deployment and
   reviewed policy; re-observe before unsigned simulation and review. Require slot < grant expiry,
   slot <= creation deadline, fresh blockhash and explicit network confirmation. Never silently
   extend deadlines or re-sign changed bytes. Review resolved ALTs, every instruction/recipient,
   signature count, simulation deltas and min output; reject extra buy/Kit/admin/bridge instructions.
   Journal before broadcast; reconcile unknown sends by signature/message and finalized account
   deltas before any retry. Need a hardened receipt verifier, terminal states, wallet UI and real
   browser-wallet acceptance; offline journal tests do not establish these.
5. **Run staged devnet acceptance with explicit approvals.** First observe while creation/trading
   are paused; then one named cap-one plain launch with fixed expiry and trading still paused.
   Verify receipt, exact debits/recipients, quota and supply/reserve/LP state, reload and recovery.
   Only after a separate trading approval, use specified funded wallets/input amounts for a buy
   followed by sell and reconcile exact input/output/fees/reserves. Test insufficient real quote,
   slippage, sniper timing, wallet rejection/switch, stale policy/hash/ALT/ELF, quota races, deadline
   equality vs grant expiry equality, cap+1, wrong control accounts and legacy/CPI refusal. Late
   failure must roll back quota/accounts, while network fees may remain charged. Rehearse pause and
   ambiguous-submission recovery without generating new mint identities. G4 rolling-day limits
   remain unimplemented; require implementation or explicit approved requirement change.
6. **Approve consumer delivery and operations separately.** Review candidate adoption, required CI,
   new migration, current encrypted backup/decrypt/list/disposable restore and restoration roster.
   Inspect the actual DB journal: `0079` forward-repairs recipe tables skipped by historical
   timestamp ordering; do not assume `0077` alone suffices. Confirm all pending migrations,
   including `0078` and proposed `0080`; only disposable local databases were migrated here.
   Approve the exact web revision and deployment separately, with execution still disabled until
   its own activation. Mainnet needs independently selected identities/economics/security/governance
   and exact approvals; no values or approval are inherited from devnet.

## Monitoring, pause and rollback

Current instrumentation is bounded disabled-attempt telemetry plus an internal unresolved-count
reader; neither is an alerting deployment or a chain monitor. Before activation name alert routes,
on-call owners and thresholds for unresolved/aging submissions, provider disagreement, slot lag,
program/config/control/quote/ALT drift and fee/debit/output mismatch. Never log secrets, signed
wire bytes, raw RPC URLs or arbitrary request text. A missing receipt remains unresolved.

Any mismatch blocks new execution. Actual guardian pause is a separately authorized on-chain
action, not a UI toggle. Creation pause and trading pause are separate; trading pause also blocks
liquidity withdrawal, while claims/transfers/graduation are not a global freeze. Explain those
limits during incident review. Delayed admin owns unpause, not the pause-only guardian.

Rollback first disables all new execution and reconciles pending journal signatures. Restore a
reviewed prior web revision without destructive down migrations; preserve new journals and their
read-only recovery tool, even if the older UI cannot display them. Do not restore a stale database
over accepted chain activity. Restoring frozen HLTEST display never permits old-program execution.
Binary rollback, authority changes and mainnet activation require separate security/owner approval.
