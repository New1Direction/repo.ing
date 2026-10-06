# Bundle launch spike (2026-10-06)

Kept as the record behind [docs/BUNDLE_LAUNCH.md](../../docs/BUNDLE_LAUNCH.md). **Not production code**: the program here
has pass-through instructions (`vault_invoke`, `router_invoke`) that let its PDAs sign any DBC / DAMM v2 call, and
`router_invoke` has no caller check. The real program is [programs/bundle-vault](../../programs/bundle-vault).

It answered the Bundle launch mode's on-chain unknowns on a local validator running Meteora DBC, DAMM v2, Token-2022 and
Metaplex exactly as deployed on mainnet. [output.json](output.json) is the passing run (`ok: true`), [output.txt](output.txt)
its full output.

| Question | Result |
| --- | --- |
| Does a launch fit one transaction: escrow release → DBC pool → first swap with the vault as receiver → settle? | Yes: 1,193 bytes legacy, 1,043 bytes v0 with a lookup table, ~193k CU. The vault received exactly the minimum-fee quote, 41.59% of the supply for 19 SOL. |
| Can the vault buy at launch by CPI? | No: DBC gives the first swap its minimum fee only at top level (`validate_contain_initialize_pool_ix_and_no_cpi`). By CPI it was refused at the minimum-fee quote (`ExceededSlippage`) and, with no minimum, got exactly the 50.44% launch-fee quote. So the launch signer swaps at top level and the vault is the receiver. |
| Can a program-owned vault trade later by CPI? | Yes: DBC ~44k CU, DAMM v2 ~27k CU. |
| Can a PDA be a DBC config's fee claimer and claim by CPI? | Yes: the router PDA claimed exactly the pool's `partnerQuoteFee`. |
| Who owns the partner LP position after migration? | The config's fee claimer: the router PDA held it (`getPositionsByUser`) and claimed its DAMM v2 fees by CPI. |

Also found: every trade in the first 180 s pays the launch fee, the vault's too (a 120 SOL buy then left the curve at
83.99 of 85 SOL), so vault agents must wait for it to end.

## Running it again

```sh
cd spikes/bundle-launch/program
cargo +1.89.0-sbpf-solana-v1.53 build --release --target sbpf-solana-solana
~/.cache/solana/v1.53/platform-tools/llvm/bin/llvm-objcopy --strip-all \
  target/sbpf-solana-solana/release/bundle_vault_spike.so target/bundle_vault_spike.so
cd ../../.. && node spikes/bundle-launch/bundle-spike.mjs
```

It starts its own validator on port 8929 (reading the Meteora programs from mainnet once) and stops it at the end.
