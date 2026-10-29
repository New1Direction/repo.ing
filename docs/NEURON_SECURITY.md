# Character publishing security evidence — 2026-10-29

Local work in the isolated integration worktree only. No production deployment,
schema migration, real keys, infrastructure activation, paid model calls or
financial execution. Publishing is still off by default in `.env.example`.

## Dependency remediation

Pinned patched direct releases: Next.js 16.4.3 (was 16.3.6), MCP server 2.4.0
(2.1.0), sharp 0.35.5 (0.35.4), bn.js 5.2.5 (5.2.2), and Zod 4.6.7 (4.6.5).
Updated compatible source-map-js resolutions through npm. The lockfile records
the result; no `npm audit fix --force` or Solana API migration was used.

`npm audit --omit=dev --json` before: **28 findings, 1 critical, 13 high,
14 moderate**. The first direct-dependency pass left **26 findings, 0 critical,
9 high, 17 moderate**. The follow-up below resolves those remaining reports.
Counts include propagated dependency-tree findings, not independent exploits,
and may change with npm's advisory database.

### Legacy dependency follow-up

After a clean Node 22 / npm 10.9.9 `npm ci`, both **`npm audit --omit=dev` and
`npm audit` report zero vulnerabilities**. The full-tree baseline immediately
before this follow-up was 34 findings (13 high, 21 moderate). No advisory
suppression, severity filtering, forced audit fix or SDK downgrade was used.

`package.json` scopes overrides to the consumers that need them:

| Consumer | Replacement | Reason and compatibility boundary |
| --- | --- | --- |
| Both Anchor SDKs | `toml@5.0.1` | Patched recursion, prototype-pollution and CPU-DoS reports; retains synchronous `parse(string/Buffer)` used for workspace configuration. |
| web3.js | `jayson@5.0.0` | Upstream removed vulnerable stream-json and uuid dependencies. Retains the browser JSON-RPC client entry used by web3.js; requires Node 20+ and browser Web Crypto (the app requires HTTPS). |
| MetaMask utils | `uuid@11.1.1` | Patched bounds checks; retains the CJS/ESM `v4` API used by both installed utils versions. |
| SPL buffer-layout-utils | `bigint-buffer` → `bigint-buffer-browser@1.0.0` | Removes the vulnerable C++ implementation entirely, not just its warning or install script; preserves all four endian conversion functions. |
| e2e | Root `zod@4.6.7` | Removes the dev tool's independently pinned vulnerable Zod release. |
| esbuild-kit core-utils 3.3.2 | `esbuild@0.25.12` | Removes its vulnerable development server; uses the same pinned compiler already installed for Drizzle. |

The development MCP client is also updated from 2.1.0 to 2.4.0. Market SDK
versions, contract artifacts, fee terms and execution/configuration gates are
unchanged. Native bigint acceleration is deliberately sacrificed for memory
safety; fixed 8–32-byte token layouts do not require the native addon.

The bigint alias is a third-party Apache-2.0 package, not our own fork:
[source](https://github.com/mlshv/bigint-buffer-browser),
[exact registry tarball](https://registry.npmjs.org/bigint-buffer-browser/-/bigint-buffer-browser-1.0.0.tgz).
Its complete runtime implementation and manifest were inspected: four pure-JS
conversions, no native loader, dependencies or install hook. It matches the
original package's JavaScript conversion path; its upstream license is retained
in the installed package and the lockfile pins the tarball integrity. The
Truffle fork was rejected because it still ships native code and prebuilt addons.
This source review is not an independent audit of the replacement package.

npm retained an invalid stale nested esbuild resolution despite the override.
The lockfile was regenerated for **only the Drizzle subtree** in a scratch
directory, rather than refreshing unrelated dependencies. A subsequent clean
`npm ci` and targeted `npm ls` verified that the lockfile actually installs
the requested replacements without invalid dependency edges.

Zero known npm advisories is **not** a whole-site security sign-off, proof of
mainnet behavior or a guarantee against undisclosed vulnerabilities. Real-domain
Turnstile/wallet acceptance and production infrastructure review remain required.

## Bot protection

See [publishing setup](NEURON_PUBLISHING.md#public-bot-protection-implemented-not-enabled-in-production).
Server-side Siteverify, exact action/hostname checks, single-use token handling,
authenticated proxy checks on pages/APIs, and shared sign-in/request/submission
quotas are implemented. Free Nginx candidate configuration supplies IP/global
edge limits; operator deployment, real Turnstile keys, trusted networking and
real-domain end-to-end acceptance remain separate release gates.

## Verification

- Targeted Node 22 + disposable PostgreSQL suite: **66 passed, zero skipped or
  failed**, including dependency regressions, real wallet-message signatures,
  RPC failover, SPL Token-2022 layouts and MCP client/server interoperability.
  Invalid/replayed bot proofs and verifier outages create no character; forged
  forwarding headers cannot bypass the edge check. All Siteverify traffic in
  tests is mocked; no real provider requests are made.
- The publishing-only release gate also verifies actual restricted PostgreSQL
  roles: runtime sign-in, quotas and pending inserts succeed, but self-approval,
  pre-approved inserts and DDL fail. Operator approval/removal preserves history;
  ownership edits, session reads and history deletion are denied. The release
  command exits nonzero if the test database URL is missing. See the
  [release packet](NEURON_RELEASE.md); its GitHub CI job is prepared, not run.
- The published TOML prototype-pollution payload corrupted `Object.prototype`
  under the original 3.0.0 parser in an isolated process; both installed Anchor
  parsers now reject it. The regression test also parses normal Buffer-backed
  workspace configuration. Bigint tests cover empty and 1,025-byte unaligned
  inputs, both endiannesses, exact values and input immutability.
- Scratch checks verified Drizzle's patched compiler executes both CJS and ESM
  TypeScript transforms without losing bigint precision, and both MetaMask utils
  versions retain UUID v4 generation and reject undersized v5 output buffers.
  Drizzle and e2e CLI startup also passed without database or paid-service access.
- Node 22 quick suite: **2,476 passed, 544 skipped, zero failures**. Skipped
  service/network/chain tests are not counted as proof of production readiness.
- Next.js 16.4.3 production build passed. Financial execution stays disabled.
- After restarting only the supervised orb preview, the library, creation page,
  owner page and approved fixture profile each returned HTTP **200**.
- Nginx candidate syntax passed. Against the local app in public-protection mode,
  direct access with forged forwarding headers returned **403**; authenticated
  proxy access returned **200**. A 60-request parallel burst through the proxy,
  rotating forged forwarding IPs, returned **9 × 200 and 51 × 429**. The temporary
  edge service was then stopped and the Amp-only preview bypass restored.
- Browser-only Turnstile/identity fixtures verified that a failed check sends
  **zero** identity requests, shows one readable error and permits retry. Two
  subsequent retries sent distinct proof tokens with the challenge action.
  No real provider verification, wallet signature or transaction was requested.
  This checks client behavior, not acceptance with real Turnstile credentials.

Reproduce the focused checks with Node 22 and a dedicated disposable PostgreSQL
database whose name ends in `_test`:

```sh
NEURONS_TEST_DATABASE_URL=postgresql://user@127.0.0.1/repoing_neurons_publishing_test \
  npm exec --package=node@22 -- node --test \
    tests/dependency-security.test.mjs tests/neuron-bot-protection.test.mjs \
    tests/neurons-publishing.test.mjs tests/neurons-preview.test.mjs \
    tests/hooklab-wallet-identity-http.test.mjs tests/hooklab-wallet-identity-client.test.mjs \
    tests/rpc-failover.test.mjs tests/wallet-token-2022.test.mjs \
    tests/solana-wallet.test.mjs tests/mcp-readonly.test.mjs
npm exec --package=node@22 -- node scripts/ci/run-quick-tests.mjs
npm exec --package=node@22 -- npm run build
npm audit --omit=dev
npm audit
```

This document records bounded local evidence, not activation of bot protection
on the public site. Merge, infrastructure configuration and deployment remain
unperformed and require explicit authorization.
