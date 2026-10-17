# Candidate journal concurrency amendment

This amendment follows the separately retained wallet preparation foundation.
It does not enable or implement the production launch resolver.

- Re-resolve wallet identity after acquiring the journal advisory/row lock and
  replay-validating stored state, immediately before transactional work. A session
  revoked or expired while waiting for that lock cannot update the evidence row.
- Treat source/state/identity/economic/provider disagreement as sticky even when
  it is the first collection and no earlier finalized evidence exists. Preserve
  the original conflict; later matching observations cannot silently clear review.

Tests use PostgreSQL's observed advisory-lock wait state before revoking a synthetic
session, rather than assuming a sleep reached the race. A separate first-collection
provider-disagreement test proves that later matching evidence stays review-required.

## Remaining authorization boundary

Identity and evidence stores can be separate databases. Checking session validity
before an evidence write does not make revocation atomically synchronized with
that write's commit. Production launch authorization needs a co-located transactional
principal lock, or an equivalently reviewed authorization mechanism. This journal
stores candidate observations only and never grants production launch eligibility.

The transport permits only explicitly server-configured HTTPS endpoints and
requires distinct origins, but is not an SSRF/IP-network-policy validator. Approved
endpoint selection, DNS/network restrictions and operational provider independence
remain separate deployment controls. No request can choose endpoints in this code.
