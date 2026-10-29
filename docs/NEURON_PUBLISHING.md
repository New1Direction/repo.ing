# Off-chain character publishing

Implemented in the isolated `feature/neuron-launch-integration` worktree. This
adds real PostgreSQL records and public profiles, not token launches. Financial
execution remains disabled; no mint, curve, pool, balances, fees, claims, buybacks,
RPC calls, GPU or paid model calls are added. Preset chat is explicitly labelled
as reviewed fixed scripts, not live neuron steering. Custom names/stories change
presentation, not the base persona's replies. User-imported recipes have no chat
engine connected and never borrow preset replies.

The [publishing-only release packet](NEURON_RELEASE.md) contains the required CI
gate, least-privilege database grants, activation approvals, real-domain
acceptance record and pause/rollback procedure. It does not authorize deployment.

## What users can do

1. Browse `/neurons`, select a source persona, and customize name/ticker/story.
2. At the review step, connect a supported Solana wallet and sign a free identity
   message. This proves wallet control only; it is **not** transaction permission.
3. Consent to public review and submit. The server derives ownership from its
   authenticated session, not a JSON wallet address. The profile remains private.
4. Track pending/published/rejected submissions at `/neurons/mine` (Refresh status).
5. After operator review, appear in the searchable community section and share
   `/neurons/UUID`. Visitors need no wallet to read an approved profile or try chat.

Continuing from Identity saves a validated local recovery draft when browser
storage is available. Returning to Create offers an explicit Resume draft action;
it never silently replaces the selected persona. Browser storage is optional for
server publishing. Within the same wizard, returning to Identity and retrying an
unchanged submission keeps its request UUID. After successful submission the
matching recovery draft is cleared, focus moves to the receipt, and the wizard
cannot submit it again. Reloading the entire wizard starts a new request lifecycle.

Source previews remain separate. Public profiles never read identity overrides
from browser drafts. Names/tickers are not unique asset identifiers: UUIDs are.
The public profile includes the creator's wallet identity and a canonical metadata
SHA-256. A hash is an integrity receipt, not an on-chain attestation or a signature
of the profile. Moderation approval is not model/persona evaluation.

## Bring your own personality (configuration import)

Open `/neurons/import` from the library. Upload or paste an at-most-8-KiB JSON
file, validate it, inspect the exact recipe/attribution/examples, then sign in
and consent to review. This is data import, not uploaded model hosting. No URL
is fetched, code executed, weights loaded, or inference called. The downloadable
template deliberately has an invalid revision placeholder: replace it with the
actual lowercase 40-hex model commit. Its existence/compatibility is not verified.
Secrets and private conversations must never be included.

Format `repoing-personality`, version `1` is defined by
`app/lib/neuron-import.mjs`. It accepts only these fields:

- `name` (1–40 characters), `ticker` (2–10 uppercase letters/digits, letter first),
  `story` (10–280 characters).
- `model: {id: "Qwen/Qwen3-8B", revision: "<40 lowercase hex characters>"}`.
- `steering: {layer, neuron, direction, alpha}`: zero-based decoder layer 0–35,
  MLP neuron 0–12287, `up|down`, and finite 0 < alpha ≤ 10. These are import
  bounds, not evidence that any value is safe/effective. Qwen's published
  [config](https://huggingface.co/Qwen/Qwen3-8B/blob/main/config.json) specifies
  36 layers and intermediate size 12288; runtime compatibility still needs
  checking against the imported pinned revision before inference is supported.
- `attribution: {author, url}`: author 1–80 characters, HTTPS URL up to 1000
  characters, no embedded credentials. This is a creator claim, not verified
  ownership or permission. Review the destination before approving public links.
- `examples`: 0–3 `{prompt, reply}` objects, 1–500 characters per field. These
  are unverified creator-supplied samples, escaped as text and shown separately,
  never served as chat replies. Review every sample, not just name/story.
- Optional `associatedConcepts: {terms, method, sourceUrl}`: 1–12 distinct terms
  of 1–40 characters (multilingual text supported), a creator-declared method
  `j-lens|r-lens|logit-lens|creator`, and an HTTPS source URL with the same bounds
  as attribution URLs. Omit the object when unavailable; existing imports and
  their hashes remain unchanged. The template uses manual tags, not computed
  lens results. Import inspection and the public Source DNA panel label these
  as creator-supplied associations, **not verified personality traits**. Method
  names and source links are claims, not analysis performed by this app; no
  ranks, confidence scores, evaluation flags or inferred safety are accepted.
  Review all terms and the linked provenance before approval. Links are never
  fetched server-side. Terms and provenance survive JSON exports and are covered
  by the immutable submission hash. No GPU, paid calls or database migration.

Version 1 means single-neuron residual-norm steering: after decoder layer L,
add c * W_down[:, n], with c = ±alpha * r_L / ||W_down[:, n]|| and r_L the median
post-layer prompt residual norm excluding the first token; use the chat template
with thinking disabled. This defines the intended recipe semantics only; the
integration does not run it. Prompt personas, adapters, arbitrary architectures,
additional steering methods, executables and financial fields are rejected.

Unknown keys (including nested keys) are refused on client and server. Both
input and pretty-printed exported JSON must fit 8 KiB (UTF-8 bytes). The API
allows 9 KiB including request UUID/consent envelope. Browser recovery drafts
are separate from preset drafts and are optional for publishing.

Imports use immutable snapshot version 2 in the existing JSONB registry: no SQL
migration or new privileges are needed. Each submission gets a UUID and
canonical SHA-256 covering identity, model revision, steering, attribution,
examples, optional associated concepts and unavailable chat mode. Editing means another pending submission;
there is no mutable version history, lineage, or claim of exclusive ownership.
Preset version-1 hashes/records retain their previous behavior. **Older binaries
cannot read version-2 imports**: a rollback must retain the v2 reader or disable
registry publishing/reads; never rewrite or delete imported records to roll back.
Likewise, binaries without associated-concept support cannot read tagged imports;
retain the updated reader or disable registry reads during rollback.

After review, imports appear in Community and the Community recipes category.
Their public `/neurons/UUID` pages show pinned settings and unverified examples,
with no chat composer. Download via `GET /api/neuron-characters?export=UUID`:
only currently published imports export; pending, rejected, missing and preset
IDs return 404. Exports contain the portable personality, not creator wallet,
moderator notes, sessions or financial state. Removing approval also revokes
subsequent downloads; already downloaded copies cannot be recalled. Reimporting
an export preserves its configuration, not proof of authorship or exclusivity.
Existing authentication, Turnstile, edge checks, storage and submission quotas
apply unchanged. Import structure validation is not evaluation or rights clearance.

## Explicit setup (not run against production)

Use Node 22 and a **new dedicated PostgreSQL database**, not the market
`DATABASE_URL` or the companion Neuron Characters database. This follows the
existing isolated wallet-identity schema, outside shared trading migrations.
Apply each schema exactly once to an empty publishing database:

```sh copy Copy Schema Setup
psql "$NEURONS_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/hooklab-wallet-principal-schema.sql
psql "$NEURONS_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/hooklab-wallet-identity-quota-schema.sql
psql "$NEURONS_DATABASE_URL" -v ON_ERROR_STOP=1 -f src/neuron-characters-schema.sql
```

If reusing an already-configured isolated identity database, apply only missing
schemas. Never reset it. Configure the server, not NEXT_PUBLIC variables:

```dotenv copy Copy Publishing Settings
NEURONS_PUBLISHING_ENABLED=true
NEURONS_PREVIEW_ONLY=false
NEURONS_DATABASE_URL=postgresql://USER:PASSWORD@HOST/neuron_publishing
HOOK_WALLET_IDENTITY_ENABLED=true
HOOK_WALLET_IDENTITY_DATABASE_URL=postgresql://USER:PASSWORD@HOST/neuron_publishing
HOOK_WALLET_IDENTITY_ORIGIN=https://repo.ing
NEURONS_TURNSTILE_SITE_KEY=YOUR_PUBLIC_WIDGET_KEY
NEURONS_TURNSTILE_SECRET_KEY=YOUR_SERVER_ONLY_WIDGET_SECRET
NEURONS_EDGE_SECRET=YOUR_RANDOM_SERVER_ONLY_EDGE_SECRET
```

The two URLs must match exactly. Identity cookies are Secure, HttpOnly and
SameSite=Strict; the exact HTTPS site origin is required. Identity challenges
are browser-bound, single-use and expire after five minutes; sessions last thirty
minutes and can be revoked. The genesis string scopes identity only; no blockchain
endpoint or funded wallet is required. Do not enable local-chain acceptance or
any execution flags. Existing market data/configuration need not be touched.
Production database creation/migrations, secrets/settings and deployment still
require owner approval. Preview setup affects only the orb's dedicated database.

## Public bot protection (implemented, not enabled in production)

Public publishing fails closed unless Turnstile and a 32–256 character proxy
secret are configured. Missing configuration returns 503; direct-origin requests
without the proxy secret return 403 before page/database work. Forwarded Host,
Cloudflare-IP or Origin headers alone cannot authenticate the proxy. The browser
never receives the edge secret or Turnstile secret. Published dummy Turnstile
keys are rejected in public mode.

The shared wallet sign-in widget executes a fresh Turnstile check before issuing
a sign-in challenge. Character submission executes a separate `neuron-publish`
check. The server verifies every token through Siteverify, requires the exact
hostname and action (`neuron-signin` / `neuron-publish`), bounds verification to
five seconds, and rejects failures/outages/replayed tokens. Siteverify enforces
five-minute expiry and single use; success is not cached. Failed verification
does not create a challenge or a character. Retries acquire a new token while
retaining the submission's existing idempotency key.

Identity requests also have a shared 300-request/ten-minute ceiling before
expensive verification, alongside existing IP/wallet/nonce limits. The registry's
shared quotas and submission caps remain enforced in PostgreSQL across replicas.
These are cost/abuse bounds, not a guarantee against denial of service or Sybils.

`config/neuron-edge.nginx.conf.template` is a **candidate**, not a deployment.
It supplies free self-hosted per-IP/global request and connection limits, bounded
request bodies/timeouts, overwrites spoofable client IP headers, and injects the
edge secret. It requires an approved HTTPS ingress and private upstream network.
If another proxy is in front, trust only its exact verified networks; otherwise
clients share its IP bucket. Do not trust arbitrary incoming forwarded addresses.
The same authenticated-proxy policy must cover `/neurons/*`,
`/api/neuron-characters` and the shared `/api/hook-lab/wallet-identity` route.
Every other feature using that shared sign-in widget automatically gets its
Turnstile key from the identity endpoint when public publishing is enabled.

Before activation: create a real free Turnstile widget restricted to the exact
production hostname, store both secrets through secure configuration, install
and test the proxy/network restrictions, and rehearse real-wallet sign-in and
Turnstile success/failure on the intended HTTPS domain. No Cloudflare account
configuration, paid calls, production secrets, deployment or network changes
were performed here. Free Turnstile still requires an account and real keys.

For the isolated orb preview only, set `NEURONS_PREVIEW_ONLY=true` and the exact
Amp portal origin. This bypass is refused on public hostnames such as repo.ing;
it is not an alternative production configuration. Do not share a preview as a
bot-protected public launch. Leave `NEURONS_PUBLISHING_ENABLED=false` in deployed
configuration until the remaining release gates are approved.

## Free human moderation

There is no public approval API. An operator with access to the isolated database
reads pending records (including the exact `snapshot` name, story and source),
checks impersonation/rights, hate/abuse, sexual content involving minors, personal
data, spam, scams and misleading financial/steering claims, then records a reason:

```sh copy Copy Review Queue
psql "$NEURONS_DATABASE_URL" -c "select id, creator_wallet, snapshot, created_at from neuron_characters where status='pending' order by created_at limit 100"
```

```sh copy Copy Approval Command
node scripts/moderate-neuron-character.mjs UUID published "Reviewed name, story, rights and source attribution."
```

Use `rejected` instead of `published` to deny or remove a previously published
profile. Approval/removal and a new review-history row commit atomically. Public
pages read current state on every request (no static approval cache). Never
approve corrupted snapshots. Do not put private moderation notes in profile text;
review reasons are operator-only in this version. Use a restricted application
database role for runtime reads/inserts and a separate operator role for review
updates; never expose operator credentials to the browser. A moderation queue UI,
appeals and notification workflow are not implemented.

The explicit [grant template](../src/neuron-publishing-grants.sql) restricts the
runtime to pending inserts and authentication/quota operations. Only the review
role can change publication status; it cannot rewrite content or ownership.
Apply it only to the dedicated publishing database after creating distinct new
non-owner roles; see the [release packet](NEURON_RELEASE.md#activation-checklist--owner-approval-still-required).

## Limits and cost controls

- At most **3 new submissions per wallet per UTC day**, **2 pending per wallet**,
  **100 new submissions globally per UTC day**, **10,000 stored profiles total**.
  Transaction-level locking makes these limits hold across replicas/concurrent
  requests. Hitting the storage ceiling closes publishing until an operator acts.
- Identical retries with the same request UUID return the existing record;
  changing details under that UUID returns 409. The UI reuses its UUID for retries
  while the submission panel is mounted; a fresh wizard is a new submission.
- Shared HTTP quotas: 600 registry requests per ten minutes globally, 90 per IP
  hint. Forwarded IP is never identity. Existing wallet-identity quotas also apply.
- Strict whitelisted JSON, a 9 KiB request cap (8 KiB personality), field bounds,
  escaped text rendering, server-owned preset DNA / unverified imported DNA, fail-closed database errors,
  bounded query deadlines, and lists limited to the newest 100 records.
- Zero paid inference/moderation/chain execution. Hosting/storage still cost money
  outside this orb. Wallet identities are Sybil-able: limits bound work, not prove
  unique people. Before public release, put trusted edge rate limits in front of
  both identity and registry routes, block origin bypass, and set a moderation
  staffing/storage budget. Existing identity routes are shared infrastructure.

Expire old identity data/quotas as an operator maintenance task; do not delete
character or review records automatically. For example, remove consumed/expired
challenges, expired/revoked sessions and expired quota buckets using bounded
batches. Back up the publishing database and retain moderation history.
No automated maintenance job or recurring service is started by this change.

## Local verification

```sh copy Copy Publishing Tests
NEURONS_TEST_DATABASE_URL=postgresql://USER@HOST/repoing_neurons_publishing_test node --test tests/neurons-publishing.test.mjs tests/neurons-preview.test.mjs
node scripts/ci/run-quick-tests.mjs
npm run build
```

The DB suite insists on a `*_test` database, creates a unique temporary schema,
and drops only that schema. Without its test URL the database suite is explicitly
skipped; pure validation/rendering tests still run. Tests use disposable Ed25519
keys to prove real message signatures, never transaction signers or chain access.
They cover authenticated ownership, private queues, public approval/removal,
idempotent races, pending/daily/global caps, tampering and exhausted quotas.

Verified in the orb on 2026-10-28:

- Node 22 targeted run with PostgreSQL: **11 passed, zero failed/skipped**.
- Node 22 quick suite: **2,470 passed, 544 skipped, zero failures**. The DB-backed
  publishing suite is separately executed above rather than counted as a pass
  when the quick runner removes database configuration.
- Node 22 production build and `git diff --check` passed.
- Browser: complete wallet-message sign-in → server submission → private pending
  card → CLI approval → public profile/community card → share link. A disposable
  wallet provider produced one real Ed25519 sign-in signature and zero transaction
  calls. This does not substitute for testing every real browser wallet extension.
- Anonymous pending profile returned 404, private-list API returned 401, and an
  approved profile returned 200. The portal's configured HTTPS origin was checked
  against the real identity and registry endpoints after preview startup.
- 390px Chromium checks found no horizontal overflow; consent enables publishing,
  and trading remains disabled. Final screenshots and pointer/consent recordings
  were inspected. The initial 30fps recording exceeded its encoder budget; short
  replacement clips at 10fps/2× resolution were captured and inspected instead.

Dependency remediation, clean-install audits and compatibility checks are recorded in
[the security evidence](NEURON_SECURITY.md). Commercial reuse terms for upstream
recipes still need review. Source delivery is limited to
`feature/neuron-launch-integration`; merge and production deployment remain
separate approvals.

Publishing UX pass verified on 2026-10-29: release gate **67 passed, zero failed or
skipped**; quick suite **2,477 passed, 544 skipped, zero failures**; production
build passed. The interaction regression covers draft recovery, consent gating,
outage/retry after backward navigation, blocked browser storage, and receipt
focus. The live private preview accepted one disposable Ed25519 wallet-message
signature and saved a pending PostgreSQL character with zero transaction calls.
Desktop and 390px Chromium captures were inspected; no horizontal overflow was
found and identity inputs render at 16px. Narrow Chromium is not a real-phone or
touch test. Real installed wallets and the production bot challenge still need
the approved-domain acceptance checks in the release packet.
