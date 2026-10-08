# repoing CLI

Turn the GitHub repository you are already working in into a repo.ing launch review.

```bash
npm install --global @repoing/cli

cd your-project
repoing launch
```

`repoing launch` reads `origin`, resolves the canonical public GitHub repository through repo.ing, creates the same signed one-hour launch review used by the agent/MCP flow, and opens it in your browser.

You still review current costs and explicitly approve in your wallet. The CLI never asks for a seed phrase, private key, GitHub token, or spending permission.

## Examples

```bash
repoing launch
repoing launch owner/repository
repoing launch --name "My Project" --symbol MYPROJECT
repoing launch --buy 1
repoing launch --no-open
repoing launch --json
```

Supported GitHub remotes include HTTPS, `git@github.com:owner/repo.git`, and `ssh://git@github.com/owner/repo.git`.

An optional launch buy can be 0%, 1%, 2%, or the 3% maximum. The browser requotes and simulates it before wallet approval.

## What the command does

1. Detects and normalizes the current GitHub repository.
2. Asks repo.ing to resolve its immutable GitHub repository ID.
3. Refuses private, archived, opted-out, duplicate, or ambiguous launches through the existing server rules.
4. Creates an expiring signed review draft bound to current launch policy.
5. Opens the review page.
6. Your wallet is the only thing that can approve and submit the launch.

If a canonical market already exists, the command opens that market instead of creating another launch draft.

## Your fees: `repoing claim`

```bash
repoing claim                  # asks: claim to your wallet, or convert to AI credits
repoing claim --to-wallet      # opens the claim page on repo.ing (unchanged)
repoing claim --convert 0.5    # 0.5 SOL of your fees as AI credits
```

The command shows what the next claim of the repository pays. **Claim to wallet** opens repo.ing's claim page, where your
fees go to your bound wallet as before. **Convert to AI credits** signs you in through repo.ing: your browser opens, you
approve on repo.ing that you are an admin of the repository, and repo.ing sends a single-use code to a one-time listener on
this computer (PKCE; the credit service never gets your GitHub token). Then the credit service quotes the credits for the
SOL you chose, at the SOL/USD price of the moment, and the command prints a Solana Pay link. You pay it from your own
wallet; credits come only after the payment is finalized on chain, and a payment that does not match goes to a review.

The AI credits service is a devnet sandbox until repo.ing switches it on: by default the command uses one running on this
computer (`--credits-origin`, or `REPOING_CREDITS_ORIGIN`).

## A key for your coding tool: `repoing credits key`

```bash
repoing credits key                         # asks for a spending limit (default: all your credits)
repoing credits key --limit 20 --label cursor
repoing credits list                        # your keys: live, expired or revoked, with what each has spent
repoing credits revoke <key-id>             # stops a key at once
```

The command signs you in through repo.ing in the same way and makes one key that can only run inference, valid 30 days,
with a spending limit of at most your credits (at most 5 live keys). It prints `OPENAI_BASE_URL` and `OPENAI_API_KEY` for
an OpenAI-compatible tool, once, and the key's ID; the key cannot buy credits or make other keys. If a key leaks, revoke
it. The AI gateway is a sandbox on this computer for now (`--inference-origin`, or `REPOING_INFERENCE_ORIGIN`), and must
be running for the tool to work.

## A pack of credits: `repoing credits buy`

```bash
repoing credits buy        # shows the odds, asks for a pack and a yes
repoing credits buy 25     # a $25 pack
```

Pays SOL for a $10, $25, $50 or $100 pack of AI credits, at the SOL price of the moment, through a Solana Pay link like
`repoing claim --convert`. Each paid pack spins once, on the server, when the payment is final: you always get the pack
in paid credits, and a win adds bonus credits (current odds: 97.15% 1x, 2.50% 1.2x, 0.30% 2x, 0.05% 5x). Credits never
turn into cash. At most $250 of packs a day per account. Packs are not on sale yet: the command says so until repo.ing
turns them on.

## Development

From `cli/`:

```bash
npm test
npm link
repoing --help
```

For a local repo.ing web server:

```bash
REPOING_ORIGIN=http://localhost:3001 repoing launch --no-open
```
