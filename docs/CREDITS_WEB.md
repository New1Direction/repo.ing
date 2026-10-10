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
   (`npx @repoing/cli credits key`).

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

A builder buys a pack of repo.ing AI credits on **repo.ing/credits**: $10, $25, $50 or $100, paid in SOL from their
own wallet with one approval. Each paid pack spins once at the credit service (repo-inference `docs/PACKS.md`): at least
the pack in paid credits, sometimes a bonus. The code is `src/credits-packs.mjs`, the route
`app/api/credits/packs/route.js`, the page `app/(site)/credits/page.jsx` and its components in
`app/components/credit-packs/` (the WebGL packs, the tear and the holographic card, from repo-inference's pack page).

## What the builder does

1. **Sign in with GitHub** on /credits (an identity sign-in, `mode=credits`, that returns to /credits).
2. Choose a pack on the shelf. The page shows the odds, the terms and how much the account can still buy today.
3. **Open the pack**: the stage shows the pack while repo.ing gets the quote; the wallet asks to approve one SOL transfer.
4. The pack waits until the payment is final on Solana (about half a minute), then tears open and the card shows the
   spin: Common 1×, Rare 1.2×, Epic 2× or Legendary 5×.

If the builder declines in the wallet, nothing is sent; the quote stays open (pay it or cancel it) until it ends.

## How it works

The same steps and checks as "Claim as AI credits" above, with these differences:

- **Who.** The account must be an admin of a repository with a market on repo.ing, like every other way into the
  credit service. repo.ing lists the account's admin repositories (GitHub, live), picks one with a market and checks it
  live before each sign-in.
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

Only after pack sales are live on the credit ledger (`PACK_SALES=on`, `SURPLUS_RESALE_APPROVAL_REF` and
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
