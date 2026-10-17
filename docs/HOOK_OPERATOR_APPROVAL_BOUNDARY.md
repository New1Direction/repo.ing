# Operational approval and deployment verification

This amendment corrects prior gate wording. The inspected protocol does not require
a cryptographically signed owner-adoption envelope. Owner approval is an operational
release process: exact reviewed program IDs, source/patch/IDL/ELF pins, custody,
provider trust domains and economic bounds must be explicitly accepted and configured
by the operator. The app independently verifies those exact pins against fresh
two-provider chain state. A supplied hash or a callback boolean is not standalone
proof of approval. No approval or production configuration is installed here.

Earlier immutable patch documentation mentioning mandatory signed adoption packets
is superseded on this point. Build-provenance attestations and the protocol's
unsigned public custody evidence have their own scopes and do not establish owner
approval. The new-mint form leaves cap empty; every launch requires an explicit
cap choice. No illustrative 100-bps value is an approved default.

Economics remain unapproved. The present swap adapter explicitly supports only
zero-fee fixture semantics and rejects nonzero configuration; this is a current
implementation limitation, not the intended public business model. Any selected
nonzero fee split requires reviewed quote/accounting tests and exact configuration
commitments before activation.
