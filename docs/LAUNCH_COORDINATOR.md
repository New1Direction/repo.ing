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

The live GitHub lookup and the local chain launch were verified separately; the chain test injects a GitHub fixture for repeatability. Devnet and production signer operations remain unverified. The fixed config created by the test exists only in that validator ledger; a future environment must provision its own fixed config and supply its address. If RPC submission is ambiguous, the row remains incomplete and blocks another launch until chain inspection proves success, or until its attempt is proven expired and released (see Signing window below). The Postgres lock of the one-call `launch()` spans wallet signing, so a wallet that never responds holds that repository's launch queue until the call is cancelled or the process exits. The site does not use that call: `prepareLaunch` releases the lock once the review is stored in `launch_sessions`, and `submitPrepared` takes it again only to co-sign, submit and record, so an unanswered wallet blocks a repository for at most the review's 120 seconds. Metadata hosting and token images were not part of this slice; the app now serves both (`/api/token-metadata/{mint}` and `/api/token-image/{mint}`, [Token artwork](TOKEN_IMAGES.md)).

## Signing window and expired attempts

A launch transaction is valid until its blockhash's `lastValidBlockHeight`, 150 blocks after the review is prepared. At mainnet's block rate on 2026-10-05 (3.67 blocks/s) that is about 40 s, and the wallet's own review counts against it.
- **The launch form** expires its review after 20 s (`REVIEW_VALID_MS`), so the wallet keeps about 20 s. An expired review must be refreshed before signing.
- **Submit (`src/meteora-launch.mjs`)** reads the confirmed block height before sending. A transaction whose blockhash has already expired is never sent; only the server holds the co-signed bytes, so it cannot land. The attempt fails definitively with "This launch review expired before it reached Solana", and the launcher can refresh and retry at once.
- **An RPC error answer** to the send (failed preflight simulation or validation) means the RPC refused the transaction and did not forward it, so it is definitive too. A transport failure, or an "already processed" answer, stays `ambiguous`.
- **Error names.** `DefinitiveLaunchError` and `IncompleteLaunchError` set `name` explicitly: the production build renames classes, and `launchFailure` (`src/launch-failure.mjs`) reads the name to decide whether the form offers "Refresh review" or "Check launch status".

An `ambiguous` or `submitted` attempt is released for retry by the worker (`createLaunchIndexer({ expiredLaunch })`, `src/launch-expiry.mjs`) once two independent providers prove it never landed. The primary RPC and the verification RPC, on another host, must each show:
- the finalized block height more than 150 blocks past the blockhash's `lastValidBlockHeight`;
- the blockhash invalid;
- no transaction and no signature status;
- neither the mint nor the pool.

That is about 90 s after the review. The release records a `LAUNCH_EXPIRED` operator alert carrying the evidence, and marks the market `failed` only while it is still the proven attempt. `scripts/recover-expired-launch.mjs --repo=<id> [--apply]` is the operator's manual path to the same proof and release.

