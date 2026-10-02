# Optional builder earnings reminders

## Current status

Implemented and tested with fake delivery. Production delivery is **disabled** until an email provider and verified sender are configured and an opted-in delivery is checked. No mailing list is imported. This feature does not send promotional outreach.

## Setup

Use a Resend sending API key restricted to a verified sending domain. On **web and worker**, configure:

- `RESEND_API_KEY`: server-only sending credential.
- `BUILDER_REMINDER_FROM`: the verified sender, for example `repo.ing <earnings@your-verified-domain>`.
- `BUILDER_REMINDER_SECRET`: the same random secret of at least 32 characters on both services. Purpose-bound confirmation/unsubscribe links use this secret; no wallet key is involved.
- `APP_ORIGIN`: canonical HTTPS origin.
- `BUILDER_REMINDERS_ENABLED=true` only when the preceding settings and domain are ready.

Apply additive migration `0021_builder_reminders`. Without complete configuration, the optional signup control is hidden and the worker schedules no deliveries. Turning delivery off does not prevent an existing subscriber from removing their address; preserve the reminder secret so unsubscribe links continue to work.

## Consent and authority

A signed-in GitHub user must have a saved beneficiary binding and pass a fresh admin check to request confirmation. Entering an address creates a pending subscription only. The recipient must explicitly confirm the purpose-bound link within 24 hours. A changed address requires new confirmation. Links use URL fragments, are removed from the displayed URL after loading, and changes require a same-origin POST. A link does not confer GitHub authority, wallet control, or claim authorization.

The digest covers up to 100 current saved beneficiary bindings associated with that GitHub user. Ordinary claim authorization is checked again at claim time. Email is an informational snapshot, not proof that access or payout availability will still be valid later.

## Delivery rules

- At most one digest per subscriber per 24 hours.
- At least 0.05 SOL of verified available fees and 0.05 SOL additional earned since the prior digest.
- Only `MATCH` fee reconciliation; unresolved claims and unavailable/mismatching fees are excluded. An RPC error skips that pass.
- Snapshot time and exact SOL amounts in the email. Only a link to the standard Builders review flow.
- Check hourly when below the threshold; check the due queue every five minutes, separately from indexing/recovery.
- A durable frozen payload and provider idempotency key survive worker restart. Retry the identical message for at most one hour, safely inside Resend’s documented 24-hour key retention. An exhausted/ambiguous message is suppressed for the day and its baseline retained; operator logs show accepted/failed counts. Provider acceptance is not inbox delivery proof.
- Ten-minute confirmation-request limits bind both account and destination, including after cancellation. Destination rate keys are HMACs; they do not contain raw email addresses.

## Payout address change notice

When a payout address is pasted (see [CLAIM.md](CLAIM.md#2026-10-02-pasted-payout-addresses-with-a-48-hour-hold)), the web service sends "Payout address change requested" at once to confirmed subscribers among: the GitHub user who pasted it, the GitHub user whose current binding it would replace, and the author of a waiting address it replaced. It names the repository, the pasted address, when it becomes active, the current payout address, and the claim page where any admin can cancel it. One Resend idempotency key per request and recipient. Delivery is best effort and never blocks or undoes the request; with delivery unconfigured nothing is looked up or sent. It is not retried by the worker.

## Stored data and removal

The database stores the opted-in email, GitHub account ID, confirmation revision and dates, per-repository notified earnings baselines, and a pending delivery payload when needed. It stores no GitHub access token or wallet secret for reminders. Standard database backup retention applies.

Turning reminders off deletes the live subscription and queued payload. Unconfirmed addresses are purged after two days while delivery is enabled. Hashed rate-limit keys expire after two days. No email addresses, tokens, or provider errors are written to worker logs.

## Rehearsal

`CHART_TEST_DATABASE_URL=postgres://127.0.0.1:55441/postgres node --test tests/builder-reminders.test.mjs` uses a dedicated local database and a fake sender. It covers explicit confirmation, wrong-purpose links, rate limiting, `MATCH`/pending/mismatch filters, thresholds, frozen timeout retries, daily cap, unchanged balances, and deletion.

Before enabling production delivery: verify the sending domain, use an operator-owned address through the real opt-in UI, confirm the email, observe one genuine earnings digest, then unsubscribe and confirm removal. No fake fees, claims, or volume are required.

Provider reference: [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).
