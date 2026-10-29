# Neuron publishing-only release candidate

Prepared on 2026-10-29 for `feature/neuron-launch-integration` only.
**Not merged into main, deployed or activated.**
This packet does not authorize production changes. Keep publishing disabled in
deployed settings until the owner approves the separate activation below.

## Scope

- `/neurons`: six attributed source personas and approved community profiles.
- `/neurons/new`: customize a character, free wallet-message sign-in, consent,
  submit for manual review. `/neurons/mine`: private submission status.
- `/neurons/UUID`: stable approved profile and clearly labelled scripted chat.
- PostgreSQL ownership, immutable metadata hash, review history, shared quotas,
  Turnstile proofs and authenticated rate-limiting proxy enforcement.
- **No tokens, trading, earnings, fees, claims, buybacks, live AI or GPU calls.**
  Publishing is not a token launch or a neuron-steering evaluation. Do not
  advertise “launch and earn” or imply the source library endorses this product.

There is no Neuron financial execution path to activate in this candidate.
Preserve existing repo.ing market terms and settings; do not enable or modify
unrelated financial runtimes as part of publishing. No new worker is needed.

## Local release gate

Use Node 22 and a dedicated disposable PostgreSQL database ending in `_test`.
The test administrator needs schema/role creation privileges on that disposable
server only. Tests create uniquely named schemas and NOLOGIN roles and clean
them up; never point this command at production or the preview registry.

```sh copy Copy Release Checks
npm ci
NEURONS_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:5432/repoing_neurons_release_test npm run test:neurons:release
node scripts/ci/run-quick-tests.mjs
npm run build
npm audit --omit=dev
npm audit
git diff --check
```

`test:neurons:release` fails without its database URL, rather than counting
skipped database coverage as success. It covers real message signatures,
private/public moderation transitions, replay/concurrency limits, fresh bot
proofs, forged proxy headers, dependency regressions and wallet/RPC compatibility.
It also tests the actual SQL grants: the runtime cannot publish itself, insert
an already-approved row or create tables; reviewers cannot change ownership,
read wallet sessions or erase review history.

The proposed GitHub check **`neuron publishing release gate`** in
`.github/workflows/test.yml` uses an isolated PostgreSQL 17 service, Node 22,
no deployment step, no paid calls, no signing keys and no chain execution.
It has not been verified on GitHub. A feature-branch push alone does not trigger
this workflow; a future pull request will. After source review,
require it alongside `quick tests` and `next build` before merging; branch
protection changes are separate owner-approved actions, not performed here.

## Activation checklist — owner approval still required

1. **Source review:** approve the integration diff against then-current repo.ing
   main, pass the checks on the exact candidate, and record the resulting commit.
   Merge approval remains separate from authorization to push the feature branch.
2. **Rights and operations:** review source CSV/recipe reuse and attribution,
   approve the scripted-chat disclosure and public wallet visibility, nominate a
   moderator and an actual abuse-reporting channel. No rights clearance claimed.
3. **Database:** provision a dedicated publishing database, not the trading DB.
   Follow [schema setup](NEURON_PUBLISHING.md#explicit-setup-not-run-against-production).
   Apply the three SQL schemas once, outside shared Drizzle migrations, using a
   schema-owner credential which is never loaded by the web service.
4. **Least privilege:** create distinct new runtime/reviewer login roles with no
   superuser, role-creation, database-creation, replication or owner powers. They
   must not own objects, inherit extra grants or be able to assume each other or
   an administrator. Apply the candidate grants below as the schema owner, then
   verify effective privileges using the actual login credentials.
5. **Protection:** obtain a real free Turnstile widget restricted to the exact
   hostname, securely configure its secret and a random edge secret, deploy the
   reviewed authenticated proxy and restrict the app origin to that proxy.
   Validate trusted ingress IP handling, TLS and the proxy config; never expose
   the private app port. See [bot setup](NEURON_PUBLISHING.md#public-bot-protection-implemented-not-enabled-in-production).
6. **Recovery and monitoring:** encrypt an off-host backup and restore it into a
   disposable database; verify profile hashes, visibility, counts and review
   history. Assign backup/restore ownership and monitor 5xx, quota/429 rates,
   verification failures, pending review age and database growth. Do not log
   identity cookies, signatures, proof tokens, secrets or full connection URLs.
7. **Real-domain rehearsal:** run the acceptance table below on approved staging
   with real Turnstile and browser wallets, then obtain separate deployment and
   activation approval. Existing local mocks are not proof of this step.

After approval only, apply the grants to the dedicated database. The template
does not create roles/passwords and is **not** a shared-market migration:

```sh copy Copy Publishing Grants
psql "$NEURON_SCHEMA_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v schema=public -v runtime_role=neuron_web -v review_role=neuron_moderator \
  -f src/neuron-publishing-grants.sql
```

Set `NEURONS_DATABASE_URL` and `HOOK_WALLET_IDENTITY_DATABASE_URL` to the same
restricted runtime URL; neither may be the trading `DATABASE_URL`. Use the
reviewer URL **only** when running `scripts/moderate-neuron-character.mjs`.
Do not put schema-owner or reviewer access in the web process. See
[manual moderation](NEURON_PUBLISHING.md#free-human-moderation) for the review
criteria, queue query, approval and removal commands.

Public activation requires `NEURONS_PUBLISHING_ENABLED=true`,
`NEURONS_PREVIEW_ONLY=false`, identity enabled, the exact HTTPS identity origin,
both Turnstile keys and the server-only edge secret. Those are instructions for
a later authorized activation, not changes made here. Do not use Amp preview
origins, browser fixtures or published dummy keys on the public site.

## Real-domain acceptance record (not completed)

Record the candidate revision, domain, time, browser/wallet, outcome and receipt
IDs without recording private credentials. No on-chain transaction is involved.

| Case | Required result |
| --- | --- |
| Anonymous submission / private list | Sign-in required; private API 401. |
| Wallet sign-in | Exact-domain identity-only message; reject/cancel safely, retry, sign out, expire session; zero transaction requests. |
| Submit and retry | One pending row for identical retries, private to its owner; different wallet cannot view it. |
| Moderator approval / removal | Approved UUID appears publicly; rejection hides it and retains both review records. |
| Invalid/expired/replayed proof, wrong action/host | Rejected, no new challenge or character. |
| Direct origin and forged forwarding headers | Rejected; no origin/network bypass. |
| Burst, oversized body, quotas | Bounded 413/429 responses; no duplicate records or uncapped work. |
| Provider/DB outage and restart | Fail closed, no secret leakage; draft retained; existing records survive restart. |
| Desktop/narrow layout and real browser wallets | Readable disclosures, keyboard access, no overflow; consent and retry work. |
| Financial controls | Neuron buy/sell disabled, no mint, no earnings promise, no signer/RPC/payment requests. |

Local evidence is in [NEURON_SECURITY.md](NEURON_SECURITY.md). The CI gate uses
PostgreSQL 17; the current orb verification uses PostgreSQL 15, not a claim that
the proposed GitHub job or real-domain rehearsal has already run.

## Pause and rollback

- To stop new submissions while preserving public reads and existing identity
  protection, block POST `/api/neuron-characters` at the approved edge with a
  temporary 503 response. Keep GET, proxy authentication and rate limits intact.
  This is an operator infrastructure change requiring authorization.
- For complete Neuron registry shutdown, set `NEURONS_PUBLISHING_ENABLED=false`
  on the web service through the approved rollout process. Public registry
  profiles become unavailable; source previews may remain. Keep network/edge
  restrictions in place and assess the shared identity route separately.
- Revert to the reviewed prior application revision only after checking schema
  compatibility. Do not drop tables, erase review history, restore over current
  submissions or alter the shared market/financial ledgers as a rollback shortcut.
- Periodically remove expired/consumed authentication data and expired quota
  buckets in bounded operator batches, with an agreed retention policy. Preserve
  characters/review history; no cleanup job or recurring schedule is started.

## Delivery state

Release tooling and local verification are prepared. Source integration is
limited to `feature/neuron-launch-integration`. Production roles, database, secrets, proxy, backups,
real-domain acceptance, moderator/contact and rights sign-off are unconfigured
or unverified by this work and remain release gates. Deployment and financial
execution remain disabled; no production migration or paid call was performed.
