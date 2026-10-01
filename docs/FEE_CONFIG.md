# Fixed DBC trading fee proof

> This report preserves the original DBC fee experiment. For the selected 85 SOL profile and current post-graduation behavior, read [Liquidity](LIQUIDITY.md) and [Graduated fees](GRADUATED_FEES.md). Later rollout evidence supersedes the integration-status limitations recorded below. The prepared anti-sniper config (a launch fee that falls to this same 1.75% within 3 minutes; not active) is in [Launch fee](LAUNCH_FEE.md).

**Network:** local Solana validator with Meteora DBC program fixtures. **SDK:** `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`. **Result:** the closest supported split to the product target is 175 basis points total, `creatorTradingFeePercentage = 71`, dynamic fee disabled, quote token SOL, and quote-token fee collection. The fixed launch guard and test fixture now require those values.

The DBC program allocates 20% of the total trading fee to the protocol, then splits the remaining 80% between creator and partner using an integer creator percentage ([official SDK fee math](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/a28b7239e71899eb52ff7aacac4dec90441885c4/packages/dynamic-bonding-curve/src/math/feeMath.ts)). Thus 175 bps gives 35 bps protocol and 140 bps for creator and partner. At 71%, the nominal split is **99.4 bps repository creator, 40.6 bps repo.ing partner, 35 bps protocol**. Exact 100/40 bps cannot be represented with this integer percentage: 72% would give 100.8/39.2 bps. Each trade rounds integer base units.

## Chain evidence

Reproduce with the Meteora program fixtures and `solana-test-validator` setup in [METEORA_SPIKE.md](METEORA_SPIKE.md), then run:

```bash
SPIKE_BASE_FEE_BPS=175 SPIKE_CREATOR_PERCENT=71 \
  SPIKE_OUTPUT=/tmp/repoing-fee-config-output.json npm run meteora:spike
```

The 2026-09-24 run created config `4iNvfWKsmthuzEGZyxjmex267jRzcjh8TAcKLfiveH6Q`, mint `Fk4YPCpCD9ot9K4WYvTSft1eJ6CuC4bsRhSkoaDHTXPS`, pool `GHzfJU6j8ZCs8tNjWUS4TzmeNUrvEsyyos2Rme9izRtL`, and a second pool `8cA1cn1ezQZuH93dixEBv66QRJcCYAfNTrLScCQQDJdH` from the **same** config.

| Transaction | Signature | Creator total | Partner total | Protocol total |
| --- | --- | ---: | ---: | ---: |
| Wallet A buys 0.1 SOL | `5C3T1kvsz23aWCePJX5qiYx3Xrha6SW2vdqXjkzQ1gCShUkBnXvSULUGHfQxyt1BqvJ4JXhzFbzZLwaqxcfqpgYn` | 994,000 | 406,000 | 350,000 |
| Wallet B buys 0.15 SOL | `5se72WpvJNjusLwHcXrdD6kL3cciojwmmqViv5cvD9K167Y43asVuirXiEAnL335k5g5tFfhKk1igyhDMKKhj3TL` | 2,485,000 | 1,015,000 | 875,000 |
| Wallet A sells half its tokens | `1Gn24jzLz4WS9njAVB5ubbYJxTsQt36LdA91JpEwLMRirGc2moYjrndh79Y5npSfLWC2dj6gd9xvyDQwv5HDmra` | 3,138,375 | 1,281,872 | 1,105,061 |

All amounts are cumulative lamports read from Meteora creator, partner, and pool protocol counters after each successful transaction. The first buy alone measures exactly 0.994%, 0.406%, and 0.35% of its 0.1 SOL input. The sell counters include whole-lamport rounding.

The creator claim transaction `4GkfRE2uHdZ91XYScmyviztj6bPfTcdSUPaNZptzJPCjuDTzJ8u4q7zyNjwdgsAoAUycW6FscBD2SBiRi66NF18F` moved 3,138,375 lamports of creator fees to receiver `CzyoB8PqCX1K1KGkhiMuWDE2DroxVABoAwy96qzmTSL3`. The receiver balance increased by 5,177,655 lamports in total, including a separate 2,039,280-lamport rent refund. The on-chain creator unclaimed counter then read zero; the partner's 1,281,872 lamports remained unclaimed.

## Graduation limit

The earlier [Meteora spike](METEORA_SPIKE.md) proved that DBC creator fees can still be claimed after migration and that a creator locked-liquidity position can earn DAMM v2 fees in its local test. **The 175/71 configuration was not migrated in this run.** The 0.994% repository rate and 0.406% platform rate are verified only for DBC trading. DAMM v2 has separate fee and liquidity rules; its post-migration split, entitlement accounting, and production claim path remain unverified. The UI must not promise these DBC rates after graduation.


**2026-09-25 update:** The exact 175/71 configuration now passed a local DAMM migration and builder-fee payout rehearsal. The production DAMM ledger/claim integration and a mainnet migration remain unverified. See [launch review and graduation evidence](LAUNCH_REVIEW.md).
