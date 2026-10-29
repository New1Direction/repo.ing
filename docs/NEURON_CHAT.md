# Neuron chat connection — mock preview only

This connects approved imported character profiles to the **wire contract** of
the standalone Python steering server. It does not run a model, validate a
personality, or provide production moderation. Deployment, GPU spending and all
financial execution remain disabled. No new dependencies or paid keys are needed.

## Try it privately

Use Node 22, the isolated PostgreSQL publishing database and HTTPS preview origin
configured in [NEURON_PUBLISHING.md](NEURON_PUBLISHING.md). As its schema owner,
explicitly apply `src/neuron-chat-schema.sql` once, after the publishing schemas.
For a non-owner web role, apply `src/neuron-chat-grants.sql` with the same `schema`,
`runtime_role` and `review_role` psql variables as the existing publishing grants.
The web role cannot review profiles or rewrite chat ownership, IDs or timestamps.

Set **only in the private preview process**, alongside its existing settings:

```sh copy Copy Mock Settings
NEURONS_CHAT_MODE=mock
NEURONS_PREVIEW_ONLY=true
NEURONS_CHAT_MODEL_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The `a` revision is a **fake local fixture**, not a downloaded or verified model.
Import and manually approve a recipe with that exact revision and alpha ≤ 1.25.
Open `/neurons/UUID`, sign in with a free wallet message, and send text. The
deterministic reply confirms layer, neuron, direction, alpha and context length;
it explicitly says no model ran. Send `[mock-block]` to exercise moderation denial.
Preset profiles keep their existing fixed scripts; incompatible imported profiles
retain their unavailable state. Changing imported data requires a new publication.

Default `NEURONS_CHAT_MODE=disabled` returns 404. `live`, public-domain preview
bypasses, unpinned revisions and non-preview chat configurations are rejected.
No environment setting activates paid/live inference. Mock transport stays in
process: `.invalid` service addresses are contract labels, never network calls.

## HTTP and limits

`POST /api/neuron-chat` accepts exactly:

```json
{"characterId":"UUID","conversationId":"UUID","requestId":"UUID","message":"Hello"}
```

- Secure HttpOnly wallet session; same-origin POST and JSON only; 4 KiB body cap,
  500-character message cap; unrecognized keys rejected. The browser cannot
  supply recipe overrides, model URLs, assistant replies or history.
- Server reads the approved, integrity-checked recipe and the last two completed
  turns for this wallet + character + conversation. The Python payload contains
  only `layer`, `neuron`, `direction`, `alpha`, `messages`; revision response
  header must match. Imported alpha up to 10 is valid metadata, but the existing
  Python `/chat` accepts at most 1.25: larger values are rejected, never clamped.
- All history/new input and each output pass the moderation adapter. Missing,
  malformed or failed verdicts, transport failures, wrong revisions, oversized
  responses and publication removal withhold the reply. Mock moderation is only
  the `[mock-block]` fixture, **not a real safety classifier**.
- 3 reserved attempts per wallet per UTC day, 100 globally per UTC day, one
  active attempt globally, no queue, 10,000 stored attempts maximum. Failed and
  blocked attempts count. PostgreSQL transactional admission holds across replicas.
  Expired pending attempts become failed after 60 seconds at next admission.
  The service pipeline shares one 15-second abort deadline; no automatic retry.
- A completed request UUID can replay the same reply without another generation;
  changed details under that UUID return 409. Replays recheck publication and
  moderation. Pending/failed UUIDs return 409. The UI keeps IDs on ambiguous
  network failures and uses a new attempt after a definitive HTTP failure.
- HTTP guard: 60 requests globally / 20 per IP hint per ten minutes, plus the
  existing identity limits. Forwarded IP is not identity; wallets are Sybil-able.
  The candidate protected-edge route includes this endpoint but is not deployed.
- Responses are private/no-store. Safe replies and submitted input are saved in
  PostgreSQL, scoped to the signed-in wallet; blocked/failed replies are not saved.
  There is no public transcript API. Reload starts a new UI conversation; it does
  **not** reset server daily usage. Sign-out/account change clears visible history
  and ignores late results. No chat is written to browser local storage.
- No automatic retention cleanup. Storage ceiling stops admission. Before any
  public/live activation, approve retention/deletion, backups and privacy copy;
  clearing data to regain capacity must not silently reset current daily quotas.

## Verification and remaining approvals

```sh copy Copy Chat Checks
NEURONS_TEST_DATABASE_URL=postgresql://USER@127.0.0.1/repoing_neurons_release_test npm run test:neurons:release
npm run build
```

The release gate requires the disposable `*_test` database, creates/drops only
unique test schemas, and uses real disposable Ed25519 wallet-message signatures.
It checks payload pinning, server-owned history, wallet/character isolation,
moderation denial/outage, publication removal, idempotent replay, concurrent
admission, UTC rollover, global/storage caps, UI retries and sign-out races.

**Still required for real chat:** explicitly approved GPU budget/provider,
reviewed model revision and recipe evaluations, private authenticated Python
endpoint with bf16 single-GPU Qwen3-8B and thinking disabled, production moderation
adapter/policy, live transport implementation with credential handling, end-to-end
GPU acceptance, public bot/edge validation, retention/operations approval, and
separate merge/deployment authorization. This change does not implement or enable
any of those paid/public steps. Trading remains a separate disabled integration.

Verified locally on 2026-10-29 with Node 22: release gate **84 passed, zero failed
or skipped** (including isolated PostgreSQL), production build passed, quick suite
**2,486 passed, 545 explicitly skipped, zero failed**, and `git diff --check`
passed. Browser exercised the real Next.js route and preview database using a
disposable signed wallet identity: first reply had one context message, follow-up
had three, moderation denial returned no assistant reply, and the fourth attempt
hit the server daily cap. Desktop and 390px Chromium screenshots and a pointer/
keyboard recording were inspected. Narrow Chromium is not a real-device test.
Only the private orb preview was activated; no paid/live transport was called.
