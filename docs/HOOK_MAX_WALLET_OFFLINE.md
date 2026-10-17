# Max-wallet candidate: bounded offline adapters

The selected policy is one versioned max-wallet rule. The profile kind is
`immutable-initial-supply-owner-cap-until-authenticated-graduation`; the request requires
`policyKind: max-wallet`, `policyVersion: 1` and an explicit `capBps` from 1 through 9999.
There is no selected production cap, fee policy, deployment, custody or signer in this package.

The reviewed candidate profile is SHA-256
`f366d222e7257e86ac23d8350741b3c20c08ea084a4445c7b0d2d913593b5ea0`.
The executed public synthetic vector is SHA-256
`1c7b0bbd26faab7246f0e5c0ef3f58b0f56d93313c4dd368ed9861a1f23a2962`.
These identities select exact source/ELF/IDL bytes for offline review; they do not adopt a deployment.

## Two explicit stages

`planMaxWalletPreparation` derives initial supply, quote mint and LP fee from the canonical
observed Launch Config, binds the explicit cap, and builds prepare plus immutable selected-config
creation. It checks complete ordered state, program/ProgramData links, exact ELF lengths and
allocation padding, reviewed IDLs, signer curves and aliasing, economics, message privileges,
lookup-table state and the Solana wire bound. Preparation requires the future mint signer.
A nonzero raw cap is required. No alternate arbitrary rule or creator exemption is accepted.

`deriveMaxWalletPreparedAccounts` derives the exact 85-byte policy, 81-byte two-literal registry,
and immutable selected config. The registry names the policy and canonical Launch PDA, in order.
The Launch account remains absent immediately after preparation. The selected config's created_at
is supplied by runtime Clock: deriving its observed canonical bytes does not authenticate historical
Clock or equate it with RPC blockTime.

`buildMaxWalletLaunchReviewForFixture` builds the separate custom launch against exact synthetic
prepared state. It binds the immutable policy/registry, live config/governance/grant and economics
commitments, source pins, canonical accounts and readonly global policy privileges. Preparation and
launch cannot be combined: transaction-wide writable privileges violate the hook contract.
The ordinary `buildMaxWalletLaunchReview` export always refuses without a production resolver.

All outputs have signing, submission, execution, adoption and production preparation acceptance
disabled. A caller-provided hash, provider label, rent quote or fixture receipt is an assertion,
not an authenticated live reader or server-owned durable proof.

## Local evidence

The preparation and launch tests include strict schema/version/kind/profile checks, cap and
configuration changes, program/ELF/IDL mutations, governance commitments, account privileges,
lookup tables, unsafe amounts and message-size bounds. Independent review reran all 180 focused
checks and 16 additional mutation probes. Both exact app-generated messages were independently
replayed in the retained-state SBF canary, including subsequent hostile and graduation checks.
The public saved plans and vector are intentionally included even though their filenames match
the repository's broad wallet-file ignore pattern; they contain no private keys.

The SBF test environment uses synthetic roles, balances and lookup tables and disables signature
validation. Successful local replay does not prove wallet onboarding, native quote bridging,
independent RPC provenance, live preparation, profile adoption or owner approval. Production
integration still requires those separately reviewed boundaries.

The existing Playground's six modules remain simulation. A separately opt-in loopback runner can
exercise these exact staged adapters in the approved Playground shell; it is not a public route or
an activation flag. Browser preflight refusals must be reported separately from actual SBF rejected
transactions, and cancelling a local review is not a real wallet rejection.
