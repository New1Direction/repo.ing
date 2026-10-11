# Claim as AI credits

A builder turns SOL into repo.ing AI credits on the claim page, with one wallet approval. The code is
`src/credits-web.mjs`, the route `app/api/credits/convert/[repo]/route.js` and the card
`app/components/credits-convert.jsx`. The credit service and its ledger are in the repo-inference project
(`docs/FEE-CONVERSION.md` there).

## What the builder does

1. On the claim page, **Claim as AI credits** runs the normal claim first. The server pays the bound wallet, as today.
   A builder can also open the card without a claim ("Convert SOL from your wallet to AI credits").
2. The card shows the amount (all of the payout by default). **Get quote** signs the builder in to the credit service
   and shows the SOL, the credits in dollars, the SOL price and the time left.
3. **Approve in wallet** asks the wallet to approve one plain SOL transfer to the credit treasury.
4. The credit ledger checks the payment on chain and credits it. The card shows the credits and how to make a key
   (the credits page, `/credits#keys`; the CLI `npx @repoing/cli credits key` works too).

If the builder declines in the wallet, nothing is sent and the SOL stays in the wallet.

## How it works

- **Sign-in.** The click is the consent. After a live check that the GitHub account is an admin of the repository,
  repo.ing makes a PKCE pair, approves its own handoff (`src/repo-inference-handoff.mjs`) and the credit service
  redeems the code server to server (no Origin header). The credit service's session token is kept only in an
  encrypted HttpOnly cookie (`__Host-repoing_credits`, AES-256-GCM, bound to the GitHub account, at most 55 minutes).
- **Quote.** Each quote checks admin authority live. repo.ing refuses a quote that does not pay exactly
  `CREDITS_TREASURY_ADDRESS` the quoted lamports, that has more or less than one reference key, a token, a memo, or
  another network. 0.01 to 100 SOL. One open conversion per GitHub account (table `credit_conversions`, migration
  0065).
- **Payment.** One `SystemProgram.transfer` from the builder's wallet to the treasury, with the quote's reference key
  read-only and not a signer. repo.ing stores the message it prepared and accepts only those bytes, signed by the
  payer. The signature is stored before the broadcast. A failed preflight sends nothing, and the builder can approve
  again. A signed payment that never lands is replaced only after its blockhash has expired.
- **Outcome.** The card asks the credit service for the quote's status: credited, in review (wrong amount, late or
  paid twice: the ledger refunds or credits after a review), or expired.

## Switch on (owner)

Only after mainnet fee conversion is live on the credit ledger (`SURPLUS_RESALE_APPROVAL_REF` set there). On the
`web` service:

- `CREDITS_WEB_CONVERT_ENABLED=true`
- `REPO_INFERENCE_CREDITS_ORIGIN=https://credits.repo.ing`
- `CREDITS_TREASURY_ADDRESS=` the mainnet credit treasury
- the handoff (`REPO_INFERENCE_HANDOFF_ENABLED=true` and its two secrets) must already be on.

Off: set `CREDITS_WEB_CONVERT_ENABLED=false`. The button goes away and the route answers 404. Open conversions keep
their status at the credit service.

## Tests

- `tests/credits-web.test.mjs` (quick): settings, the quote and payment checks, the session cookie, the sign-in and the
  route's refusals.
- `tests/credits-web-chain.test.mjs` (PostgreSQL + validator): a quote, one approved transfer, the credit, and the
  refusals around it, with a stand-in credit service that redeems the real handoff.

# Credit packs

Anyone with a GitHub account buys a pack of repo.ing AI credits on **repo.ing/credits**: $10, $25, $50 or $100, paid in
SOL from their own wallet with one approval. Each paid pack spins once at the credit service (repo-inference `docs/PACKS.md`): at least
the pack in paid credits, sometimes a bonus. The code is `src/credits-packs.mjs`, the route
`app/api/credits/packs/route.js`, the page `app/(site)/credits/page.jsx` and its components in
`app/components/credit-packs/` (the WebGL packs, the tear and the holographic card, from repo-inference's pack page).

## What the buyer does

1. **Sign in with GitHub** on /credits (an identity sign-in, `mode=credits`, that returns to /credits).
2. Choose a pack on the shelf. The page shows the odds, the terms and how much the account can still buy today.
3. **Open the pack**: the stage shows the pack while repo.ing gets the quote; the wallet asks to approve one SOL transfer.
4. The pack waits until the payment is final on Solana (about half a minute), then tears open and the card shows the
   spin: Common 1×, Rare 1.2×, Epic 2× or Legendary 5×.

If the buyer declines in the wallet, nothing is sent; the quote stays open (pay it or cancel it) until it ends.

## How it works

The same steps and checks as "Claim as AI credits" above, with these differences:

- **Who.** Anyone with a GitHub account (owner decision 2026-10-10). Before each sign-in repo.ing checks the account live
  (its GitHub token still works, for the same user) and makes an **identity handoff**: permission `identity`, no
  repository (migration 0067; the assertion's `repo_id` is empty). The credit ledger accepts identity handoffs for packs
  only; fee conversion still needs an admin handoff. Credits belong to the GitHub account.
- **Quote.** The credit service prices the pack. repo.ing refuses a quote that is not for this pack, that does not pay
  `CREDITS_TREASURY_ADDRESS`, or that asks for more or fewer lamports than the fewest worth the pack at the quoted price
  (the credit ledger's own rule).
- **Retry key.** The purchase row is stored with its Idempotency-Key before the quote is asked for (`requested`). If the
  answer is lost, the next click asks again under the same key and gets the same quote, not a second one. A refusal
  from the credit service, or a quote that fails the checks, ends the request (`failed`).
- **Outcome.** The spin is checked against the pack (multiplier, paid amount, bonus). A credited pack without a matching
  spin goes to review, like a payment that does not match its quote. One open pack per GitHub account (table
  `credit_pack_purchases`, migration 0066).

## Switch on (owner)

The credit ledger and service must accept identity handoffs first (repo-inference: identity sign-ins for packs). Only
after pack sales are live on the credit ledger (`PACK_SALES=on`, `SURPLUS_RESALE_APPROVAL_REF` and
`PACK_PROMOTION_APPROVAL_REF` set there). On the `web` service:

- `CREDITS_WEB_PACKS_ENABLED=true`
- `REPO_INFERENCE_CREDITS_ORIGIN` and `CREDITS_TREASURY_ADDRESS`, as for the conversion (the conversion itself may stay off)
- the handoff (`REPO_INFERENCE_HANDOFF_ENABLED=true` and its two secrets) must already be on.

Off: set `CREDITS_WEB_PACKS_ENABLED=false`. /credits, its route and its sign-in answer 404 (or do not finish). Open
packs keep their status at the credit service.

## Tests

- `tests/credits-packs.test.mjs` (quick): settings, the pack quote and spin checks, the offer, the route's refusals, the
  sign-in mode and migration 0066.
- `tests/credits-packs-chain.test.mjs` (PostgreSQL + validator): a $25 pack, one approved transfer, credited with its
  spin; a lost answer asked again under the same key; failed, lost and late payments; review; a refusal.

# Keys for your coding tool

Anyone signed in with GitHub on **repo.ing/credits** sees their repo.ing AI credits, makes an inference-only key for a coding
tool, sees their keys and revokes one, without the CLI (`repoing credits key|list|revoke`, which stays). The code is
`src/credits-keys.mjs`, the route `app/api/credits/keys/route.js` and the section `app/components/credit-keys.jsx` (its
browser-side rules are in `app/components/credit-keys-model.mjs`), under the packs on the page, with the anchor `#keys`. The
"Claim as AI credits" card links to `/credits#keys` after a conversion.

## What the visitor does

1. Under the packs, **Your AI credits** shows the credits and the keys (name, spending limit, how much is spent, valid until, live,
   expired or revoked). If this browser has no credit service session, **Show my AI credits** signs in again with a click.
2. **Make a key**: a name (default `coding-tool`) and a spending limit in USD (default: all the credits, at least $0.01).
3. The new key shows once, as two lines with **Copy** buttons: `OPENAI_BASE_URL=<AI gateway>/v1` and `OPENAI_API_KEY=<token>`.
   **I saved it. Hide the key.** drops it from the page.
4. **Revoke** (then **Yes, revoke**) stops a key at once. Requests already running finish and are charged.

## How it works

- **The credit service.** The steps call its endpoints `GET /account`, `GET /keys`, `POST /keys` (an Idempotency-Key, a
  fresh one each time, and the body `{ label, budget_micro }`) and `POST /keys/<id>/revoke`, all through `creditsCall` with the
  visitor's credit session from the encrypted cookie. With no session (or one the service no longer knows: a 401, retried
  once), a click signs in again as the packs do: a live GitHub check, then an identity handoff. A page load (`GET`) never
  signs in; it says `needsSignIn`.
- **Checks.** Every answer is checked before it is shown, with the CLI's rules: a key token is `rik_` and 64 lowercase hex
  digits, a key id is a UUID, a name is the service's own rule (1 to 64 letters, digits, spaces, dots, dashes or
  underscores, starting with a letter or digit), a limit is whole micro-USD from 10 000 ($0.01) up to the credits (read again
  just before the key is made). The credits are `credits_available`, else `paid_available`. A key list shows only
  well-formed ids and fields, at most 50, never a token. A key answer that is not well-formed shows nothing from it and
  says "If a key was made, revoke it below."
- **The token.** It is in the one answer to the click that made the key, with `Cache-Control: private, no-store`. repo.ing
  does not store, log or cache it: nothing runs after the key is made, so nothing can fail the answer. The page keeps it only
  in component state (no `localStorage`, no address). A list never carries a token.
- **The route.** `GET` gives the overview (404 while dark; `{ "signedIn": false }` without a GitHub session). `POST` takes
  `{ action: "check" }`, `{ action: "make", label?, limitMicro? }` or `{ action: "revoke", keyId }` (exact fields for each,
  at most 8000 bytes, the same origin, a GitHub session). `make` and `revoke` count 20 a user in 10 minutes and 300 a minute in
  all (`credits:keys:<user>`, `credits:keys`); `check` counts only when it signs in. Other errors are not echoed.

## Switch on (owner)

On with the credit packs (`CREDITS_WEB_PACKS_ENABLED=true`): there is no switch of its own. Optional on the `web` service:
`CREDITS_INFERENCE_ORIGIN` (default `https://inference.repo.ing`; https, or http on this computer outside production). An odd
value turns the keys off rather than pointing a key anywhere else.

## Tests

- `tests/credits-keys.test.mjs` (quick): the settings, every check above, the steps against a scripted credit service (with
  and without a session, the identity sign-in, a dropped session, a malformed key answer, the quota, revoke) and the route
  end to end (refusals, no token in a list, the token in one answer, the cookie).

# Builder shares

Every pack can pay a builder. A buyer opens a pack for a GitHub repository, and 10% of the pack's price (the spin's
bonus does not count) goes to that repository's builders as AI credits. The buyer's pack does not change. The code is
`src/builder-pack-shares.mjs` (settings, eligibility, totals, the claim), `src/credits-tickets.mjs` (the signed tickets),
the route `app/api/credits/shares/[repo]/route.js`, and the pages: `app/lib/backed-repo.mjs` and
`app/components/backed-repo-capture.jsx` (the pick), the chip in `app/components/credit-packs/credit-packs.jsx`, the token
page card `app/components/pack-shares.jsx` and the claim page section `app/components/pack-shares-claim.jsx`. The ledger
side is in the repo-inference project (migration 0016, `src/builder_shares.rs`).

## What the buyer does

1. On a token page, the card **AI credit packs back this repo** has **Open a pack for owner/name**. It opens
   `/credits?repo=<id>`. This browser keeps the pick for 30 days; the last pick wins.
2. On /credits, a line above the buy button says "Backing owner/name · $2.50 of this pack goes to its builders as AI
   credits." with **Remove**. If the repository cannot be backed, a note gives the reason and says the pack backs no
   repository. If the check does not answer (switched off, rate limited, unreachable), a note says so ("We could not
   check the repository you picked. This pack backs no repository. Reload to try again.") with **Remove**, and the pack
   backs no repository. There is no "Change" control: to pick another repository, use another token page's link.
3. The quote shows a row **Backs** with the repository and the share. The buyer pays as for any pack. When the pack
   opens, the page adds "You backed owner/name: $2.50 in AI credits to its builders."

## What the builder does

On the claim page of the repository, a section **Pack shares: $X in AI credits** shows for the person who set the
repository's payout wallet. **Claim as AI credits** adds the amount to their repo.ing AI credits (bonus credits). The
section shows nothing for anyone else, when nothing is waiting, or when the totals cannot be read. The token page card
also shows **Paid so far: $X from N packs** (amounts only, never buyers), and shows without that line when the totals
cannot be read.

## How it works

- **Which repositories.** A GitHub repository with a confirmed, finalized, indexed market in SOL, no active maintainer
  opt-out, and a buyer who is not the holder of its payout wallet (no self rebate). Not eligible: stock pairs (their
  builder share already goes to liquidity), Hugging Face models, repositories with no market, and repositories on the
  operator's do-not-promote list (`PROMOTION_EXCLUDED_REPO_IDS`: "repo.ing does not promote this repository."; no token
  card either). No repository chosen: no
  share. After an opt-out, new packs cannot pick the repository; shares that exist stay claimable. repo.ing checks
  eligibility at each quote (after the quote rate limit) and stores the repository with the pack request.
- **Tickets.** The credit ledger refuses a builder repository without repo.ing's signed word, so a command line user
  cannot point shares at any repository. Two tickets, HMAC-SHA256 (hex) with `HANDOFF_ASSERTION_SECRET` (the ledger holds
  it too; the credit service never does), each text starting with its own version line so none can pass for a handoff
  assertion: the **pack ticket** (`repoing-pack-builder-v1`: the quote's Idempotency-Key, buyer GitHub id, repository id,
  rate) and the **claim ticket** (`repoing-builder-claim-v1`: Idempotency-Key, claimer GitHub id, repository id). Valid
  300 seconds, at most 30 seconds in the future. Both repositories pin the same test vectors.
- **Ledger record.** The rate is frozen on the quote (`builder_share_bps`), like the odds. The ledger writes a
  `builder_shares` row in the same transaction as the spin. A share exists only when the pack is credited with its spin: a
  payment in review, an operator credit or a refund gives none. repo.ing refuses a quote whose repository or rate is not
  the one it asked for.
- **Claim checks.** Only a click claims. repo.ing needs the repository's GitHub admin session, checks live that GitHub
  still lists the person as an admin, checks that they are the person who set the current payout wallet, and allows 5
  claims per 10 minutes. It then signs in to the credit service with an admin handoff and sends the claim ticket. The
  ledger leaves out shares whose buyer account is the claimer's own, grants the sum as bonus credits, and links each share
  to one claim, in one transaction.
- **A claim that answers 0.** The page says "Nothing new to claim." It never says the repository was never paid: a retry
  after a lost answer, or after a new sign-in, answers 0 too.
- **Totals.** `GET /api/credits/shares/<repo>` gives the repository's full name, whether packs may back it (for the
  signed-in buyer, with the reason if not), and amounts from the credit service only for a confirmed SOL market, otherwise
  null amounts. It is public, so it is counted first: 60 a minute for each visitor and 240 a minute in all, 429 beyond. The
  credit service allows repo.ing's one address 300 calls a minute, shared with pack quotes and claims, and token pages
  are rendered on demand, so a crawl would use it up. The credit service's answer is kept 60 seconds for each repository
  (at most 500, in memory on `globalThis`), and only a cache miss may read, within one budget for all repositories of 120
  a minute (`credits:shares:upstream` in `agent_request_limits`, shared by every replica). Past the budget, or when it
  cannot be counted, the answer is null; a refusal or a failed read is kept 30 seconds, so it is not asked again by every
  render. The server logs `builder_share_totals_unavailable` for that at most once a minute, and
  `builder_share_quota_unavailable` when the GET's own count cannot be taken. A claim drops the repository's entry. The
  claim section treats any answer but a good one (404, 429, 503) as "unavailable" and shows nothing.
- **Migration.** `drizzle/0069_pack_builder_shares.sql` adds the pack's repository and rate to `credit_pack_purchases`.

## Switch on (owner)

Deploy the credit ledger and service first (repo-inference migration 0016, switches off), then repo.ing web (migration
0069). Packs must be on in both places. On the credit ledger: `BUILDER_SHARES=on`, and optionally `BUILDER_SHARE_BPS`
(default 1000, allowed 1 to 2000; repo.ing signs 1000, so change `BUILDER_SHARE_BPS` in `src/builder-pack-shares.mjs` in
the same release), plus its kill switch `builder_shares`. On the `web` service:

- `CREDITS_WEB_BUILDER_SHARES_ENABLED=true`
- `CREDITS_WEB_PACKS_ENABLED=true`, the handoff and the credit service settings, as for packs.

Off: set `CREDITS_WEB_BUILDER_SHARES_ENABLED=false`. The chip, the token card and the claim section go away and the
route answers 404; open packs keep their repository. Shares already recorded stay at the ledger and can be claimed again
when the switch is back on.

## Tests

- `tests/builder-pack-shares.test.mjs` (quick): settings, the 10% rule, eligibility, totals with their cache and upstream budget, the claim
  checks, the route's refusals, the do-not-promote list, migration 0069 and the browser's pick (`app/lib/backed-repo.mjs`).
- `tests/pack-shares-ui.test.mjs` (quick): the token card (dark, market kinds, totals, no totals) and the claim section's
  first render.
- `tests/credits-tickets.test.mjs` (quick): the ticket texts and the shared test vectors.
- `tests/credits-packs.test.mjs` (quick): the pack quote with a repository.
- `tests/builder-pack-shares-db.test.mjs` (PostgreSQL): the quote with a repository, the claim and the route against a
  stand-in credit service. Set `BUILDER_PACK_SHARES_TEST_DATABASE_URL` to a throwaway database.
