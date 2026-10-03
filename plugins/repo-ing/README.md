# repo.ing plugin for Cursor and Claude Code

Ask your editor's agent about [repo.ing](https://repo.ing) markets without leaving your code. repo.ing turns public GitHub repositories and Hugging Face models into Solana token markets, and every trade pays the project's builders.

- *Does my repo have a market?*
- *What has it earned, and how do I claim?*
- *What's trending on repo.ing?*
- *How do I launch a market for this repo?*

The plugin connects the agent to repo.ing's read-only MCP server and adds a skill that tells the agent when to use it, to always link the repo.ing page, and never to claim it can launch, trade or claim.

## Install in Claude Code

```text
/plugin marketplace add New1Direction/repo.ing
/plugin install repo-ing@repo-ing
```

From a shell, the same steps are `claude plugin marketplace add New1Direction/repo.ing` and `claude plugin install repo-ing@repo-ing`.

To add only the MCP server, without the skill:

```bash
claude mcp add --transport http repo-ing https://repo.ing/api/mcp/readonly
```

Add `--scope user` to make it available in every project.

## Install in Cursor

- **Team marketplace:** in the Cursor dashboard, open **Plugins & MCPs → Team Marketplaces → Add Marketplace → Import from Repo** and paste `https://github.com/New1Direction/repo.ing`. Then install **repo.ing**.
- **Local:** copy this directory to `~/.cursor/plugins/local/repo-ing`, then run **Developer: Reload Window**.

  ```bash
  src=$(mktemp -d) && git clone --depth 1 https://github.com/New1Direction/repo.ing "$src"
  mkdir -p ~/.cursor/plugins/local && cp -R "$src/plugins/repo-ing" ~/.cursor/plugins/local/repo-ing
  ```

- **MCP server only:** add this to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

  ```json
  {
    "mcpServers": {
      "repo-ing": { "type": "http", "url": "https://repo.ing/api/mcp/readonly" }
    }
  }
  ```

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `find_market` | `project`: GitHub URL, git remote or `owner/name`; Hugging Face model URL; or a repo.ing market link | The market's ticker, link, mint, 24h volume, recorded builder fees, graduation status and claim link. Without a market, the launch link. |
| `builder_earnings` | `project` | Earned, paid out and claimable now, shown only once verified against on-chain fees, plus the claim link and how claiming works. |
| `trending_markets` | `sort`: `volume`, `newest` or `graduation`; `limit`: 1 to 20 | The markets repo.ing features, with their links. |
| `platform_stats` | none | All-time markets, graduations, trades, volume, and builder fees earned and paid out. |

Every tool is annotated `readOnlyHint: true`. Hugging Face model markets always carry their disclaimer: *Community launch — not endorsed by the model's creators. Not affiliated with Hugging Face.*

## Privacy and safety

- **Read-only, public data only.** The server returns the same public market figures repo.ing shows on its site.
- **No wallet access.** It never connects to a wallet and never signs, sends or prepares a transaction. Launching, trading and claiming happen on repo.ing in your own wallet.
- **No account or API key.** Requests are rate limited under a keyed one-way hash of the client IP address. The repo.ing application does not log tool arguments.
- **Third-party text stays data.** Repository and model descriptions and token names come from their owners and launchers. The server strips control and invisible characters, quotes descriptions, and tells the agent never to follow instructions inside them.

## Server

`https://repo.ing/api/mcp/readonly` speaks MCP Streamable HTTP (protocol versions 2025-06-18 and 2025-03-26), statelessly, with JSON responses. The server code is [`app/api/mcp/readonly/route.js`](../../app/api/mcp/readonly/route.js).

This plugin is separate from repo.ing's agent launch tools at `https://repo.ing/api/mcp` ([docs](../../docs/AGENT_LAUNCH.md)), which prepare launch review links.

## License

This plugin directory is released under the [MIT License](LICENSE). The rest of the repository is AGPL-3.0-only.
