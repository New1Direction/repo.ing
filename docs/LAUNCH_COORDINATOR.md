# Repository launch coordinator

Run date: 2026-09-24. Scope: `RESOLVE_REPO → CHECK_EXISTING → PREPARE_LAUNCH → LAUNCH`. This is a library and local integration test, with no HTTP service or UI.

## Result

A public GitHub URL resolves to numeric `repository.id`; that ID is the sole database identity. A PostgreSQL advisory lock serializes launches for that ID across coordinator instances, and a unique index on `markets.github_repo_id` is the final database guard. The coordinator reserves a row before exposing a transaction for wallet signature. It stores the signed transaction signature before broadcast, then records `confirmed` only after Solana reports the signature confirmed and the expected DBC pool and SPL mint exist with the configured creator, config, and mint. A later request returns that row. `reserved`/`prepared` rows can be retried because no transaction was broadcast; `submitted`/`ambiguous` rows require successful chain inspection before promotion and never trigger another mint.

## Schema and identity

Migration: `drizzle/0000_flowery_phalanx.sql`, generated from `src/db/schema.mjs` with Drizzle ORM `0.45.3` and Drizzle Kit `0.31.11`, PostgreSQL `17`. `repositories.github_repo_id` is the primary key; owner/name/full name and public metadata are refreshed on lookup. `markets.github_repo_id`, `mint`, `pool`, and `launch_signature` each have unique indexes. Workflow status is `reserved`, `prepared`, `submitted`, `ambiguous`, `failed`, or `confirmed`; a check constraint requires mint, pool, and signature for `confirmed`.

The resolver accepts HTTPS `github.com/owner/repo` with an optional `.git` suffix or trailing slash. It rejects extra paths, query strings, other hosts, missing/private repositories, and archived repositories. A rename updates the existing repository row because both URLs resolve to the same immutable ID. A live GitHub REST lookup of `https://github.com/octocat/Hello-World` returned public, non-archived repository ID `1296269`; the chain test used a fixture with that same ID so it remains reproducible without GitHub availability.

## Fixed Meteora launch

SDK: `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`; Solana libraries `@solana/web3.js@1.98.4`, `@solana/spl-token@0.4.13`. Network: isolated local validator, `http://127.0.0.1:8899`, with the DBC and Metaplex program fixtures from [Meteora's SDK at commit `a28b7239`](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/commit/a28b7239e71899eb52ff7aacac4dec90441885c4). DBC program: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`.

The test creates one fixed config using the same curve as `docs/METEORA_SPIKE.md`: ordinary SPL base token with six decimals, SOL quote, 1% fixed fee, quote-token fee collection, 50% DBC creator trading share, no dynamic/pool creation fee, DAMM v2 migration, and 50% permanently locked creator liquidity. The coordinator receives only its config address; it checks the main on-chain settings and never accepts fee or curve parameters from the request. Token name and symbol are launch inputs. Token image is rejected in this slice because Metaplex expects a hosted JSON metadata URI, which is not provided by this coordinator; the tested transaction uses an empty URI. Initial buy is omitted.

The local platform creator keypair signed `createPool` as `poolCreator`; the separate launcher keypair signed as payer; a fresh mint keypair also signed. The creator secret was generated only in memory. The launcher never becomes creator-fee authority.

## Successful local run

| Evidence | Value |
| --- | --- |
| GitHub repository ID | `1296269` (`octocat/Hello-World`) |
| Fixed DBC config | `6PeLbpNsuvA3BohsBdt6AuogsjPCxConBB24UGw7CrsL` |
| Config creation signature | `5KjccvBkVQ5hZX5H51id8cTwmPv4dcyaw4Vxrzumm2rzFVxhpQdSNGgYjfLiy93XcVF8fCURQ8eNrz6T2i7UqERG` |
| Platform creator | `5eZaavcNyu2Kef2fmF2poMx4A44qh5svrx2hGZnmNCXn` |
| Launcher/payer | `Du6Pp2232rCJRfW446XRWbU3obNs4krXmyyHviXKQzAL` |
| SPL mint | `8HWqGFesSSo4aC8CPJ4TRHFq92RC9mvtofiQX7Dfanh` |
| DBC pool | `DUELf76Yq9eWbKuGKgeHbNsJz1DvAo3iLtTEvh9AmbRz` |
| Launch signature | `Doq6PxEUZ8ykEe3zE9uqUJ7DXVQpYn25AthJGtyGWc9PiMm7mr19uPTosA3SyEeAhFYQivfKd1q4o9nx6eq5GiZ` |

`solana confirm SIGNATURE --url http://127.0.0.1:8899` returned `Confirmed`. The SDK fetched the pool and checked its config, creator, and base mint; Solana returned an SPL-token-owned mint account. PostgreSQL then held one `confirmed` row with the same repo ID, mint, pool, signature, launcher, and creator. Repeating the request returned market ID `1` with no second launch.

## Tests and reproduction

`npm run test:launch` passed 7 PostgreSQL tests: valid/missing/invalid/private/archived resolution, renamed identity, repeated launch, unique-index enforcement, definitive preparation and transaction failures with retry, concurrent requests from two coordinator instances, ambiguous submission blocking, and promotion only after positive chain inspection. The concurrency test observed one preparation and one row. `npm run test:launch:chain` passed one real DBC launch and duplicate check. Both commands exited 0.

Start PostgreSQL and apply the migration:

```bash
docker run --rm -d --name gitfun-launch-pg -e POSTGRES_PASSWORD=launchtest -e POSTGRES_DB=gitfun_launch -p 127.0.0.1:55432:5432 postgres:17-alpine
export DATABASE_URL=postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch
npm ci --ignore-scripts
npm run db:migrate
npm run test:launch
```

Start the local validator in another terminal after checking out the Meteora SDK fixture commit cited above:

```bash
cd /tmp/meteora-dbc-sdk-spike
F=packages/dynamic-bonding-curve/tests/fixtures
solana-test-validator --reset --ledger /tmp/gitfun-launch-ledger \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$F/dynamic_bonding_curve.so" \
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$F/metaplex.so" --quiet
```

Then run `npm run test:launch:chain` from this repository. Tests truncate the local test database and create disposable, in-memory Solana keypairs; use a dedicated database. Fresh runs have different addresses and signatures. No private keys are written to files.

## Limits

The live GitHub lookup and the local chain launch were verified separately; the chain test injects a GitHub fixture for repeatability. Devnet and production signer operations remain unverified. The fixed config created by the test exists only in that validator ledger; a future environment must provision its own fixed config and supply its address. If RPC submission is ambiguous, the row remains incomplete and blocks another launch until chain inspection proves success; this slice has no operator tool for deciding a permanently unresolved submission. The Postgres lock spans wallet signing, so a wallet that never responds holds that repository's launch queue until the call is cancelled or the process exits. Metadata hosting and token images are not implemented.
