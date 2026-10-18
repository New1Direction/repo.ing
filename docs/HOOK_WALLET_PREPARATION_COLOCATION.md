# Co-located identity and preparation authorization

This amendment supersedes the cross-database authorization limitation described
in the earlier candidate journal notes for the new co-located factory only.
It also supersedes the earlier HTTP configuration restriction against sharing the
application DB. Explicit configuration is still mandatory; there is no fallback
from a missing identity DB setting to an ambient app DB URL. No live value is set.

`coLocatedWalletPreparationJournal` creates the real wallet principal store from
the same PostgreSQL pool that owns preparation rows. Its strict configuration
accepts no arbitrary principal resolver or lock callback. Deploy identity and
preparation tables in the existing application PostgreSQL database for this path;
there is no distributed authorization protocol or separate identity service.

Each evidence transaction acquires the journal advisory/row lock first, then a
`FOR SHARE` lock on the actual wallet session row. It checks exact token hash,
wallet, HTTPS origin, audience, mainnet genesis, revocation and expiry using the DB
clock after lock acquisition. Revocation/expiry updates conflict with this lock
and therefore serialize with evidence commit. Validity is checked again after
transactional work. The session lock stays held through commit or rollback.

Logout/revoke updates only session rows. Other paths must preserve this locking
order; do not introduce a session-then-journal write path. An already-revoked
session cannot become eligible through a stale earlier nonlocking read. If the
evidence transaction owns the session lock first, revocation waits and is ordered
after that transaction; subsequent calls fail. No network reads run while holding
session or journal locks.

The old injected-principal candidate factory remains explicitly labeled
`candidate-injected-store`; its output is not production proof. New summaries
identify `co-located-transaction-lock`, but still deny production launch eligibility,
adoption, signing and submission. Atomic identity validation is one necessary
boundary, not release approval or a production launch resolver.

Tests use actual local PostgreSQL sessions/revocation updates, verify both orderings
of the lock race, and check expiry after waiting. They do not issue a live credential
or connect to production. Release/profile adoption, trusted provider configuration,
full launch revalidation, signer custody, browser and live acceptance remain open.
