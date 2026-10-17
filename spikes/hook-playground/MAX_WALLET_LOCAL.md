# Opt-in local max-wallet SBF runner

This is a disposable, single-session browser integration for the reviewed max-wallet candidate. It runs actual compiled SBF with synthetic accounts/liquidity and disabled signature and blockhash checks. It cannot sign, submit, call RPC, connect a wallet, create a production preparation receipt, or activate production. The normal `server.mjs` and original Playground assets remain unchanged and networkless.

## Run in the browser's own machine/namespace

From the repository root:

```sh
bash scripts/run-max-wallet-local.sh --port 4175
```

Open `http://127.0.0.1:4175` and select **Local max-wallet test**. The shell command strips inherited environment variables before starting Node. It does not source `.env`. The local server injects the entry button, session meta token, module, and stylesheet into the original HTML in memory; it never edits the educational Playground or its saved scenarios.

Enter every cap, label, launch metadata field, virtual reserve, trade amount and minimum output explicitly. One tested synthetic example is cap 100 bps; virtual quote 1000000000; buy input 1000000/minimum 1; then sell input 1000000000/minimum 1. These are raw-unit test values, not financial recommendations or production defaults.

Stop with Ctrl-C. A fresh process discards the entire disposable VM, reviews, and idempotency history. SIGINT/SIGTERM also close the driver, including signals received during startup. An unknown process outcome stays locked even after state refresh; explicitly restart and reload. There is no HTTP reset endpoint or automatic retry.

## Explicit local dependencies

Requires the repository's installed Node dependencies, Node 22+, and the separately retained public SBF verification workspace. The 132 MB host driver is not bundled. `defaultDriverConfiguration()` contains a fixed path map; no executable, argument, environment, or filesystem path comes from an HTTP request or manifest command.

Current layout:

- `../recovered-amp/host-target/debug/deps/maxwallet_browser-2a299d230415f1df`
- `../recovered-amp/audit/maxwallet-browser-driver-manifest.json`
- `../recovered-amp/audit/maxwallet-offline-builder-profile.json`
- `../recovered-amp/audit/maxwallet-builder-vector.json`
- `../recovered-amp/audit/maxwallet-browser-driver.patch`
- `../recovered-amp/rebuilt-maxwallet/{bordrless_launch,bordrless_swap,hook_max_wallet,bordrless_token}.so`
- `../recovered-amp/hook-custom-paused-a33957a/proposal.json`
- `../../hook-cost-audit/same-id-feasibility/old-state-fixture/accounts.json`

Startup verifies the complete manifest SHA-256 `b04caafe9694b624d7ab2ef83fd4870ab091a0f326d95372763e7324c9b24a0e`, then streams and verifies each fixed execution input, driver source patch, and executable against its size/hash. The host binary has 132216280 bytes and SHA-256 `3c9185bb6192719460ca5f54230866ba0f4fb206ca7ce1abe12898184702f547`. The manifest retains source-file hashes and a reproduction command as documentation; startup does not execute that command. A rebuilt binary requires independent review and an explicit pin update.

Only five public fixture environment variables are passed to the child. No parent credentials, wallet files, production configuration, or private keys are loaded. All required state rows, including observed absence, are rebound from actual VM snapshots. Static fixture helpers supply reviewed profiles and inventory identities, never replacement future account bytes.

## Boundaries and checks

- Binds only literal `127.0.0.1`; strict Host and Origin; per-process random CSRF/session header; no CORS
- Fixed asset allowlist, no filesystem route interpolation, 8 KiB request JSON, 64 KiB browser responses, 10 MB child lines/requests, 20-second child wait
- At most 12 connections, 32 pending reviews, 96 retained HTTP outcomes, 120 driver requests; restart explicitly when exhausted
- Exact 30-second review binds input, session, revision, message hash, signer order and packet size; execution consumes the stored plan without rebuilding
- Request digests bind all child responses; account hashes, actual holding balances, revisions, phases and history are checked
- Duplicate identical execution IDs return the same cached result; conflicting IDs refuse; stale reviews refuse
- Cap, excessive minimum output and paused cases refuse before execution through the normal SDK. They are **not** program-failure receipts. Separate protocol adversarial tests establish actual SBF rejection
- Program failures, if returned for an attempted exact message, consume a revision and preserve actual token balances; generic/unknown failures never claim that execution did not happen
- Local pause/unpause affects only disposable VM governance. There is no real wallet rejection here; canceling the browser review is cancellation before dispatch

## Verification

```sh
node --test spikes/hook-playground/max-wallet-local-session.test.mjs \
  spikes/hook-playground/max-wallet-local-server.test.mjs
```

The HTTP integration suite starts its own real driver and ephemeral loopback server. It verifies causal prepare → launch → buy → sell, exact message hashes and balances, nonexecuting quotes, pause/unpause, strict failures, replay handling, security boundaries, and unchanged original assets. Unit tests use an explicitly mocked transport only for malformed/unknown outcomes and resource bounds; they do not represent chain or browser proof.

The unit transport snapshot is the public file `../recovered-amp/audit/maxwallet-browser/initial.json`, generated by the retained driver. This is an explicit test dependency, not a production observation. Browser tests are separate and require an available browser in the same namespace; a passing HTTP suite alone is not a browser proof.
