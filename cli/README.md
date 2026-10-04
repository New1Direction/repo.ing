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
