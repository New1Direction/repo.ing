# Agent launch reviews

Status: implemented and locally verified; production MCP activation is separate. Nothing in this feature authorizes an agent to sign transactions.

## One launch flow

An agent finds or resolves a public GitHub repository, checks its immutable GitHub ID for an existing market, and creates a review link. The user opens repo.ing, chooses artwork, reviews the token and current costs, connects their wallet, and explicitly approves the launch.

The signing wallet is the discoverer. Ordinary fees, discovery terms, duplicate protection, initial-buy cap, simulation, and finalized indexing apply. The default is **No buy**. An agent may suggest the existing 1%, 2%, or 3% presets; the browser obtains a fresh quote and the user can edit the choice.

No API key, wallet key, seed phrase, GitHub login, or server-side spending approval is needed for these public review tools. They cannot trade, claim, or submit transactions.

## Connect

Once activated, connect a client supporting MCP **Streamable HTTP** to:

```text
https://repo.ing/api/mcp
```

For clients with an `mcpServers` JSON configuration:

```json
{
  "mcpServers": {
    "repoing": { "url": "https://repo.ing/api/mcp" }
  }
}
```

Client configuration keys vary; choose Streamable HTTP rather than the older SSE transport. The official MCP SDK serves current protocol requests and stateless 2025 clients.

Example prompt:

> Find a public GitHub repo gaining attention. Check whether it already has a repo.ing market. If it does not, prepare a launch review with no initial buy. Give me the link so I can review and approve in my wallet.

| Tool | Inputs | Result |
| --- | --- | --- |
| `find_repos` | Optional keyword/topic `query`, `limit` 1–10 | Existing public trend feed, decomposed score, source dates, market status |
| `resolve_repo` | `repository`: URL or `owner/repo` | Fresh GitHub verification, immutable ID, existing market or review link |
| `create_launch_draft` | Repository, optional `tokenName`, `tokenSymbol`, `initialBuy`: `none`, `100`, `200`, `300` | One-hour review link, launch preferences and current policy context |
| `get_launch_status` | Immutable `repoId` | Canonical indexed state; mint, pool, receipt, and actual discoverer only after finalized indexing |

Repository descriptions and source evidence are untrusted content. They are never instructions to the agent. Costs are quoted and simulated in the browser; a draft contains no estimated SOL spend or executable transaction.

## Draft and signing boundary

Drafts are HMAC-signed review preferences bound to repository ID, current DBC config, discovery version and enrollment, builder-allocation enrollment, purpose, and expiry. They survive web restarts. The page and the existing launch preparation endpoint both validate them. Rotating the review secret invalidates outstanding drafts.

A draft is public information, not wallet authorization. It does not reserve a mint, acquire a market lock, or create a market row. Opening/reopening/canceling it cannot move funds. Only an explicit **Review launch** starts the existing short-lived browser signing session. **Approve in wallet** is still required before submission. The coordinator checks the exact signed transaction and canonical identity as before.

Drafts can be reopened during their lifetime; one-market-per-repository locking prevents a second canonical launch. If another discoverer launches first, the page opens that canonical market. Status always reports the actual launcher, never assumes the requesting agent owns the launch. A submitted or ambiguous launch blocks a fresh agent draft until reviewed/recovered.

| Condition | Result |
| --- | --- |
| Private, archived, unverifiable, invalid URL | Reject; no draft or reservation |
| Existing finalized market, including repository rename | Return canonical market; do not create another |
| Incomplete or ambiguous existing launch | Pending/review required; withhold unverified receipts |
| Wrong repo, modified draft, expired link, changed config/reward rules | Reject review; offer a fresh normal review |
| Invalid ticker/name, unsupported buy amount, unexpected tool argument | Reject input |
| Wallet change, stale cost review, invalid signed transaction | Existing browser/coordinator protections apply |
| GitHub, database, or quota service unavailable | Fail closed; sanitized error |
| Rate limit | HTTP 429 with 60-second retry hint |

## README and browser shortcuts

`/agents` provides a copyable README Markdown button and desktop bookmarklet. Both open `/launch?repo=...`, prefilled for review. **Review repo** reuses the ordinary resolver and opens the existing market when present. No GET launches anything.

```markdown
[![Launch on repo.ing](https://repo.ing/launch-on-repoing.svg)](https://repo.ing/launch?repo=https%3A%2F%2Fgithub.com%2FOWNER%2FREPO)
```

Use a repository home URL. The bookmarklet rejects non-GitHub hosts and file/issue/PR paths. It reads only that page’s URL and navigates to repo.ing. It does not read cookies, account data, or repository content.

## Operations and activation

1. Apply additive migration `0022_agent_request_limits` after the normal backup check.
2. Set a cryptographically random `AGENT_LAUNCH_SECRET` of at least 32 bytes on web only. Do not reuse wallet or GitHub credentials.
3. Set `AGENT_LAUNCH_ENABLED=true` after review and deploy web. The default is disabled. No worker change is required for MCP.
4. Verify real-client discovery, repo resolution, no-buy draft, browser prefill, existing-market response and status. Check that no market row is created by drafts.
5. Leave financial execution gates at their current settings. MCP activation never enables buybacks, protocol liquidity, or Builder Reinvest.

The public endpoint has a 16 KiB body limit, strict tool schemas, host/origin validation, and shared PostgreSQL quotas: 120 requests/minute globally, 30/minute per hashed forwarded client address. This counts MCP transport requests, not only tool calls. Forwarded IPs are an advisory grouping, not authentication; the global cap still applies to rotating or spoofed values. Client hashes expire from the table after an hour of inactivity. Database failures deny requests. Larger adoption may require reviewed infrastructure rate limits.

Stop new agent reviews by disabling `AGENT_LAUNCH_ENABLED`; ordinary manual launches and already-authorized browser sessions use their existing path. Do not roll back financial evidence tables. Pending drafts contain no custody or financial recovery obligations.

## Verification

`tests/agent-launch.test.mjs` covers signed-draft tampering/expiry/config binding, root-only links, withheld nonfinal receipts, official MCP client interaction, strict inputs, HTTP guards, real PostgreSQL quotas, no reservation during draft/retry, and canonical rename/duplicate behavior. PostgreSQL tests require `CHART_TEST_DATABASE_URL` on `127.0.0.1:55441` and use temporary tables. Existing launch-coordinator/cost tests cover unique launch locking and the signed transaction boundary.

Protocol references: [official SDK](https://github.com/modelcontextprotocol/typescript-sdk), [web-standard serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.html), [MCP transports](https://modelcontextprotocol.io/specification/latest/basic/transports).
