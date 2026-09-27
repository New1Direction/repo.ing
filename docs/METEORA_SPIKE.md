# Meteora launch, trade, and repository fee spike

Run date: 2026-09-24. This document covers the Solana/Meteora path only. No GitHub verification, repository uniqueness control, application ledger, or frontend was built.

## Result

A single DBC config launched two ordinary SPL token pools. On the first pool, wallet A bought, wallet B bought, and wallet A sold. Its creator share accrued while no repository owner was known. The creator authority later signed a claim that sent the share to a distinct receiver. After graduation, remaining DBC creator fees were still claimable, and new DAMM v2 trading fees accrued to a creator-owned locked LP position and were claimable to that receiver. All transactions and balance checks ran on an isolated local validator using Meteora's SDK fixtures, not on devnet or mainnet.

## Versions and environment

| Item | Tested value |
| --- | --- |
| DBC SDK | `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13` |
| DAMM v2 SDK | `@meteora-ag/cp-amm-sdk@1.4.10` |
| Solana client libraries | `@solana/web3.js@1.98.4`, `@solana/spl-token@0.4.13` |
| Node / Solana CLI | Node `22.22.3`; Solana CLI and local validator `4.0.1` |
| Network | Local validator at `http://127.0.0.1:8899`, commitment `confirmed`; no real funds |
| Program fixtures | [Meteora DBC SDK source commit `a28b7239`](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/commit/a28b7239e71899eb52ff7aacac4dec90441885c4), `packages/dynamic-bonding-curve/tests/fixtures` |
| DBC program | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| DAMM v2 program | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| DAMM v2 fixed 100 bp config | `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp`, cloned from devnet into local genesis |

The local DBC fixture SHA-256 was `71e06857b67882bff19d9c57134b150530a168973eea30c75edc7ceec4eaf401`; the DAMM v2 fixture SHA-256 was `af48ce6be0f2c589b389751596e8b5303b5ca444e6d46708fff008e7689ab6e9`. The public devnet faucet rejected both funding requests, so no devnet launch was attempted. The DBC and Dynamic Fee Sharing program IDs were separately confirmed executable on devnet, but their deployed binaries were not used for the experiment.

## Configuration and addresses from the successful run

| Role or account | Address |
| --- | --- |
| DBC config | `8jN79BuF2jTwGErbqRVerKKhmZmbrmB2DXqrx5xsXeY5` |
| Main SPL mint | `AEtaxLvW2Fz37EAZrtQRALXwnBSTzFrgkkUMisWCtxJW` |
| Main DBC pool | `CqU94zHLJhALUD4kAXkUistEZeeZ2U4kToonqEXJEtSP` |
| Second SPL mint, same config | `A7YrYmwDkCvhu9NRHDFxTGss68G8rQ87PaNHSsLuo65w` |
| Second DBC pool | `Hi7xSE4HzVDRi4CcuA1pcDXcEfkS6b8R6RN12xQ7DLNP` |
| Partner / config fee claimer | `8PsgnhX1ivbB6hwx9aZNJAqbG743weSgMAMuyxm3t36U` |
| Community launcher / pool rent payer | `7gjr1tKZVSkSw3u3vRqjXwdz5z1kT6FesX4KEB5vaLKo` |
| Pool creator / fee authority | `DoqehUpvsHrxyFpgZW85kHm7FFCNE5KVZ89bbmmFpta9` |
| Trader A | `DE2a1zsemdggcLcoKUHPE17bFL56bGy5Qwu3PVbrD1kb` |
| Trader B | `C68SKcLcyXPzHMtDV4yChpVjpq2n1Be6mf4T8ZA19NnF` |
| Later claim receiver | `2Kn3zVoBKXx2n71gaN2BZRUv3CkXHsG4qMQ6DghV7i7f` |
| Graduated DAMM v2 pool | `DrR7veXDsTiRFe7QQASZniEt6cp6m22WDu2AbbVq3nuE` |
| Creator's DAMM v2 position | `6HRMjM65ZPnLgV6rcQp57KNcBejoQHW29SKf3vjtmA8f` |

The fixed config used an SPL base token, SOL quote, 1% fixed fee, quote-token fee collection, 50% creator share of DBC trading fees, no dynamic fee, no pool creation fee, no migration fee, and a DAMM v2 migration target. It assigned 50% of graduated liquidity to a permanently locked creator position and 50% to a permanently locked partner position. The quote reserve threshold was `29,954,748,784` lamports. These values are experiment settings, not a proposed product fee schedule.

## Transactions and observed fees

Local validator signatures identify the run in its ledger; a fresh run creates new keys and signatures.

| Action | Signature |
| --- | --- |
| Create fixed config | `EMvbMJReS6nzgL1mbSYxNBg1rFxhkFQhX3CGWDLCnNr3acVYk32t76ALyjZ2DFutG7rrV8ckKnLRSUZSXrPDvpB` |
| Launch main SPL pool | `4qkogDzmrrFHPBc7brZHrkrEjUcqn1pEX2BBQNEvWjCgUkh9DPSF6cpVXS5qYjpUFGuqNFBYfzugZwdCHh5FGeAE` |
| Launch second SPL pool with same config | `4zjbsvLmWc6fzNYLDphPGLef5x82js8EruJa9suQ8gJkVQYvVCXZKGT2AS3sMsnefvWYA3DhGPntFLM4xiNd4qS7` |
| Wallet A buy, 0.1 SOL input | `5g1FRUDZixgGqjNgfMrM61njrurnNnHJkjtmhas32A2siWT638rEy8ktdpp2T1234cbksDKr3k7rTACPAyuRbj6m` |
| Wallet B buy, 0.15 SOL input | `4LavL2QjwxhEnJD5kdyQeqLzswiTDXkoRzwQVYMyMdmAsdTcSHRY9wHAGBJCdL1AVMhHNjdTaoRfrQbXpEKRMmra` |
| Wallet A sell, half its acquired base tokens | `38vTZaWuFXtaa4kTqwsyjYfSGEZsGmdeTndK8E95WdscFPvD3JhmNJjzPksdXk5RNezh78BiXoZPjePTvccasYas` |
| Creator claim to later receiver | `3SBe3KV5h6tzqXBAtoUMvWFj679iTsoiCHxTJ1yhVzkFLuuF9A5mLuJ9sQhp1whepC6bnm9EMPWKWTd3TE8oFhpP` |
| Migration threshold buys | `5Tm7Rjjy6QqThuo2ebqwYA8HBQq1umibFjroUsXUkaZCpEpv5LjQ1KPUJfZiyc2Z1ULJXuX7xK76vF58KAmbNTKY`, `4rNZUyeg1T3UnKLKbp1Wn5GiRQSm2qk6G7gJuC2ivoqGn9hbTjd4xbnQ2Wz4LJnW5bzPfxZQGzXVf14bb8otxK1q` |
| Migrate to DAMM v2 | `5mmHK69LaRRFAtGp9gcYqWNHXAVKHYvDR9idLG8KdLZ3Xnk7ypReD5Trn85fo6yytLKfoTv6MxJvao8wuooVaiTx` |
| Claim remaining DBC creator fees after migration | `32PSEXunS6HGKvdXKtU4t63qpnwofzcps33s9YpzPbjHedLxEKJCQmc7BFNV7454XmARBpm1AxWmTvfcP784CTVz` |
| DAMM v2 buy, 0.1 SOL input | `2jNV1dC2x2X1Rp9LVZcFarLHey2hoQtDTNa3a4Pq5Z6DDutW7ZpiiEkEZRfsEpRW61UbteCodKRbM46c2LJsTCBZ` |
| Claim creator LP fees to later receiver | `33HAxZhHhq9iUCoRWhbm1G6th1C59oyYLZwvemSp4m4q9BTHzJmCN1kKS2xJ2b9BReQ6YA3ybRMfj1oqagkDRFwr` |

Amounts below are lamports and are differences between fetched on-chain pool states. `Trading` is the amount available for the creator/partner split; `Protocol` is separate. There was no referral account, dynamic fee, pool creation fee, or migration fee in this run.

| DBC swap | Protocol fee | Creator fee | Partner fee | Total fee |
| --- | ---: | ---: | ---: | ---: |
| Wallet A buy | 200,000 | 400,000 | 400,000 | 1,000,000 |
| Wallet B buy | 300,000 | 600,000 | 600,000 | 1,500,000 |
| Wallet A sell | 132,736 | 265,473 | 265,474 | 663,683 |
| **Total before claim** | **632,736** | **1,265,473** | **1,265,474** | **3,163,683** |

The DBC pool's `creatorQuoteFee` rose from zero to `1,265,473` before any owner verification. `claimCreatorTradingFeeToReceiver` reduced it to zero, left the partner's `1,265,474` untouched, and sent `1,265,473` lamports of fees to the receiver. The receiver's native SOL balance increased by `3,304,753` lamports because this SDK route also closed a temporary wrapped-SOL account and refunded its `2,039,280` lamport rent to the receiver. The script asserts `receiver delta = creator fee + rent refund`.

The two large buys made the quote reserve exactly `29,954,748,784` lamports. Migration set `isMigrated` to `1`. Another `120,297,443` lamports of DBC creator fees remained claimable after migration; a later DBC claim reduced that counter to zero and routed those fees to the same receiver. The DAMM v2 position NFT account was owned by the same creator authority, and its position had permanently locked liquidity. After the DAMM v2 buy, pool metrics showed `800,000` lamports of LP fees and `200,000` lamports of protocol fees. `claimPositionFee2` credited `400,000` lamports to the creator position's `totalClaimedBFee` and routed them to the receiver. Its native SOL delta was `2,439,280` lamports, again including a `2,039,280` lamport temporary wrapped-SOL rent refund. The script asserts both amounts.

## Answers to the spike questions

1. **Reusable config:** Yes. Two distinct SPL mints and DBC pools were created from one config, with separate successful creation transactions.
2. **Normal SPL token:** Yes. The config's token type was `SPLToken`; the mint and pool were created by the supported SDK/program path.
3. **Two wallets buy and sell:** Yes. A and B bought independently, then A sold half its acquired tokens. All three transactions confirmed.
4. **Fee categories:** DBC swaps generated protocol and trading fees. The trading share split into creator and partner fees. No referral fee was requested. Dynamic, pool creation, and migration fees were set to zero. After graduation, DAMM v2 swaps generated protocol and LP position fees.
5. **Repository role:** Use the DBC **creator** share for the per-repository entitlement. Its authority is stored per pool, while the partner fee claimer is shared by the reusable config. Set creator LP ownership at config creation so the same per-pool creator authority receives post-graduation LP fees.
6. **Accrual before verification:** Yes. The creator fee counter accrued before any receiver was bound; the receiver address was used only at claim time. GitHub verification itself was outside this spike.
7. **Different receiver:** Yes. The launcher, traders, creator signer, and receiver were distinct. Both DBC and DAMM v2 creator fees were routed to the receiver. The creator/position owner still had to sign each claim.
8. **Existing primitives:** Yes for a platform-mediated flow: DBC creator fees, DBC receiver claim, DAMM v2 creator position, and DAMM v2 receiver claim were exercised without a custom program.
9. **Dynamic Fee Sharing:** Not required for this flow. The [current DFS SDK](https://github.com/MeteoraAg/dynamic-fee-sharing-sdk/tree/ff303b65530281b354e2ce7ceadc6e68bba4cfa8) supports DBC/DAMM fee-vault funding, but its vault sets recipient shares on initialization and its published IDL has no recipient-update instruction. It does not by itself bind an unknown future verified GitHub owner. DFS was reviewed, not executed here.
10. **Missing primitive:** None for platform-authorized routing. A trustless claim that checks GitHub authority on chain is a different requirement and was not established by this experiment.
11. **Graduation entitlement:** The DBC creator's unclaimed fees remained on the DBC pool and were claimable after migration. Creator liquidity became a creator-owned, permanently locked DAMM v2 position.
12. **After-graduation model:** Yes. A DAMM v2 trade generated LP fees, and the creator position's owner signed a claim to the receiver. This is a different on-chain fee source and claim instruction from DBC; the application will have to identify both phases per repository.

## Reproduce

The test generates disposable keypairs in memory and records only public keys, signatures, counters, and balances at `/tmp/gitfun-meteora-spike-output.json`. It rejects non-local RPC URLs. No private key is stored in the repository or evidence file.

```bash
git clone https://github.com/MeteoraAg/dynamic-bonding-curve-sdk.git /tmp/meteora-dbc-sdk-spike
git -C /tmp/meteora-dbc-sdk-spike checkout a28b7239e71899eb52ff7aacac4dec90441885c4
```

Start the local validator from `/tmp/meteora-dbc-sdk-spike` in one terminal. The cloned devnet config is needed for DAMM v2 migration; the `--bpf-program` files are Meteora's SDK test fixtures.

```bash
cd /tmp/meteora-dbc-sdk-spike
F=packages/dynamic-bonding-curve/tests/fixtures
solana-test-validator --reset --ledger /tmp/gitfun-meteora-ledger --url devnet \
  --clone Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$F/dynamic_bonding_curve.so" \
  --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG "$F/cp_amm.so" \
  --bpf-program Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB "$F/amm.so" \
  --bpf-program LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn "$F/locker.so" \
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$F/metaplex.so" \
  --bpf-program 24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi "$F/mercurial_vault.so" \
  --quiet
```

From this repository in another terminal:

```bash
npm ci --ignore-scripts
SPIKE_MIGRATE=1 npm run meteora:spike
cat /tmp/gitfun-meteora-spike-output.json
```

To inspect a signature while the local ledger is running, use `solana confirm -v SIGNATURE --url http://127.0.0.1:8899`. The full run above completed with exit code 0 and assertions on pool existence, fee accrual, creator position ownership, and receiver balance changes. Without `SPIKE_MIGRATE=1`, the script stops after the DBC claim.

## Limits and implementation consequences

- These are local fixture transactions. Live devnet deployment compatibility, RPC reliability, and mainnet behavior remain unverified. The public devnet airdrop returned a rate-limit error for both 2 SOL and 1 SOL requests.
- The DBC `poolCreator` must sign pool creation. For a community-paid launch that reserves creator fees for an unverified repository owner, a platform-controlled creator authority must co-sign and later authorize payout. The receiver cannot claim from DBC or the DAMM v2 position merely because they control the receiver wallet.
- Meteora does not know GitHub repository IDs, owner authority, wallet challenges, or the one-token-per-repo invariant. Those checks and the mapping of a repo to its pool and graduated position belong in later application work.
- SDK 1.5.13's migration method returns a transaction **and two NFT mint keypairs**, despite older documentation describing a transaction alone. The local validator also needed the DBC pool-authority PDA pre-funded with 1 SOL for its migration flash-rent path; the test script does that only for local migration.
- With quote-token fee collection, the observed creator fees were in SOL. A different collect-fee mode or quote mint would need its own balance and token-account test.
- The selected 50% DBC creator trading split and 50% graduated creator LP allocation are distinct config knobs. Keeping the repo's percentage consistent across phases requires choosing both deliberately; this spike does not choose production economics.

## Architecture decision

A — Existing Meteora primitives are sufficient.

For the tested platform-mediated model, reuse one DBC config; make a platform-controlled signer the pool creator for each repository while the community launcher pays; store the resulting pool and later DAMM v2 creator-position addresses against the repository. After the future application verifies current GitHub authority and wallet control, that creator signer authorizes a DBC fee claim or DAMM v2 position-fee claim with the verified wallet as receiver. No Dynamic Fee Sharing vault or custom Solana program is needed for the tested fee route. This decision covers the local launch/trade/fee path, not the unbuilt verification and canonical-repo controls.
