# Hook Lab quote/debit contract — isolated model v1

Status: **offline specification and tested arithmetic only**. No live quote API, account reader,
transaction, instruction, serialized message, simulation, signing, sending, deployment or UI integration
is included. Every model result says `executable: false`, `liveReady: false`, `capEnforced: false`.
These flags must never be promoted by a caller. A number below a user cap is not enforcement of that cap.

Adoption: the model and regression fixtures are included as offline foundations.
The launch preflight exposes an explicit unavailable launch quote, not these swap
numbers. No trusted live snapshotter or launch arithmetic is supplied by this model.
The six-export `@repo-ing/hooklab-readonly` package and its pins remain unchanged.

## Source authority and reproducible verification

Producer: [New1Direction/hook-lab delivery](https://github.com/New1Direction/hook-lab/commit/9b3473e001a9abc73bf644d4206e47abc95a815b).
Manifest ABI/deployment baseline: [ee7234c](https://github.com/New1Direction/hook-lab/commit/ee7234cb7a32781fecba5470f24f43233cf94167),
not the delivery revision. `git diff <baseline> <delivery> -- programs crates` is empty.

Consumer manifest: `vendor/hooklab-readonly/integration/devnet.json`, SHA-256
`3e904e1030f581d8b79879aaf43a5f3c9d20f63979008c2e4b0799581e14e403`.
Devnet genesis: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
Quote mint: `9815kDrx6sNiXCnD2CvB8LKNJjbdKWmQYXzH5gYKABSq` (Bordrless bridged SOL, not SPL WSOL).
Manifest evidence slot 511147829 is historical deployment evidence, **not a fresh quote slot**.
Programs are upgradeable; matching local files does not prove today's deployed code matches them.

All following upstream paths refer to that exact delivery:

| Source | Contract verified |
| --- | --- |
| [core, lines 165–227, 340–465](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/crates/bordrless-core/src/lib.rs#L165-L465) | ceil fees, floor curve, real liquidity constraint, share model |
| [core, lines 672–823](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/crates/bordrless-core/src/lib.rs#L672-L823) | creator/holder rounding and dropping, burn, sniper schedule |
| [swap, lines 208–449](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/programs/bordrless_swap/src/instructions/swap.rs#L208-L449) | actual vault receipt, ordered cuts, protocol accrual, actual recipient min-out |
| [launch hooks, lines 98–173](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/programs/bordrless_launch/src/instructions/hooks.rs#L98-L173) | creator exception, fee routing, post-sell eligibility |
| [Kit rules, lines 41–235](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/programs/bordrless_kit/src/rules.rs#L41-L235) | restrictions, lock boundaries, max wallet, burn and transfer eligibility |
| [Half-Life, lines 74–134 and 275–354](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/programs/half_life/src/lib.rs#L74-L354) | ppm schedule, stamping/blending, source exemptions, furnace requirement |
| [bridge wrap, lines 280–345](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/programs/bordrless_bridge/src/instructions/wrap.rs#L280-L345) | native wrap mints 1 unit per lamport; unwrap has vault/rent checks |
| [launch validation, lines 218–267](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/programs/bordrless_launch/src/instructions/launch.rs#L218-L267) | live per-side aggregate rule bounds |

Rust is authoritative. Some SDK/state comments still say LP fees stay in the pool or a zero-cut
launch pays nothing; `swap_amounts_shared` and `swap.rs` actually accrue the LP/sniper fee to protocol
even when collected hook cuts are zero. Do not implement from those comments or a flat-fee DEX helper.

Run `node --test tests/hooklab-quote-model.test.mjs` (no installed dependencies or RPC required).
The test verifies manifest/provenance and all 11 IDL hashes, then 12 retained upstream Rust-generated
swap vectors plus wallet, Half-Life, fee, debit and freshness boundaries. The fixture preserves producer
values; it is not generated from this implementation. Original vector file SHA-256:
`b30c3f59bb83519fe7a655adc7034ec2edf309b8f6d3ce6b3af10d1fe473edfa`.
Retained indices: `0,1,2,12,42,47,122,127,162,167,177,187` of `programs/tests/vectors/launch-fees.json`.

Additional scratch validation ran **362 of 440** upstream swap vectors through the same public model:
all outputs/fee amounts or refusal categories matched. The other 78 describe holder-fee sells larger
than total eligible supply, outside this model's non-excluded wallet contract; they were not validated.
The upstream math saturates eligible supply for those hypothetical inputs; the on-chain Kit subtracts
with checked arithmetic. No Rust build, validator test, RPC snapshot or live simulation was run here.

## Supported model input and output

API: `modelHookLabQuote({snapshot, request, budget}, {nowMs, slot})` and
`revalidateHookLabQuote(previousQuote, sameInputWithFreshSnapshot, current)`.
Results contain numbers, amounts and a SHA-256 content binding only. No bytes executable by a wallet.
Amounts are **bigint raw units in [0, 2^64−1]**, not floats, decimal UI amounts or JSON numbers.
Rates are integer bps in [0, 10000]; slippage excludes 10000. Times/slots are nonnegative safe integers;
timestamps are chain seconds except `nowMs`/`observedAtMs`, which are local milliseconds.
RPC decoding, canonical decimal parsing, public-key validation and JSON serialization are not provided.

| Object | Required fields and meaning |
| --- | --- |
| `snapshot` | `manifestSha256`, `genesisHash`, `quoteMint`, `poolId`, `mint`, `accountsHash` (64 lowercase hex), `slot`, `observedAtMs`, `chainTime`, `paused`, `quoteHook: 'none'`, plus objects below |
| `pool` | `feeModel: 'launch-share'`, `baseReserve`, `quoteReserve`, `virtualBase`, `virtualQuote`, `protocolShareBps` from the **pool**, not current global creation defaults |
| `launch` | `creator`, `creatorBought`, `createdAt`, `sniperWindowSecs`, `sniperStartBps`, `lpFeeBps`, `creatorFeeBps`, `holderBuyBps`, `holderSellBps`, `burnBuyBps`, `burnSellBps` |
| `wallet` | `owner`, `recipient`, `baseBalance`, `recipientBaseBalance`, `quoteBalance`, `nativeLamports`, `ordinaryWallet`, `recipientAllowed`, `recipientOnCurve` |
| `hook` | Exactly one discriminant: `kind: 'none'`, `'kit'`, or `'half-life'`; never Kit plus Half-Life |
| Kit fields | `eligible`, `minEligible`, `maxWalletAmount`, `earlyLocked` (source holding); `creatorUnlockAt`, `earlyWindowEnd`, `earlyUnlockAt`; booleans `rewardsOn`, `graduated`, `maxWalletOn`, `creatorLockOn`, `earlyLockOn` |
| Half-Life fields | `sourceSince` (chain seconds, or explicit `null` for unstamped data), `furnaceLit`, `poolRecognized` |
| `request` | `side: 'buy'|'sell'`, positive `amountIn`, `maxInput`, `maxNativeDebitLamports`, `slippageBps`, `maxPriceImpactBps` |
| `budget` | `rentLamports`, `networkFeeLamports`, `priorityFeeLamports`, `reserveLamports`: explicit hypothetical allowances; unknown is not zero |

The normalized flags are **caller assumptions, not attestations**. `ordinaryWallet` means the source
and recipient are non-excluded ordinary owners; a creator wallet is ordinary, a companion creator PDA
is not. `recipientAllowed` includes the hook's refused-destination checks. `paused` is the relevant
operation/config pause assessment (including the bridge if a wrap is required). `poolRecognized`
means Half-Life can resolve this exact launch pool as exempt. Arbitrary hooks, quote hooks, flat-fee
pools, excluded-owner trades, rewards claims, companion execution, liquidity changes, multi-hop routes
and full account-state simulation are unsupported. Creation/initialization is specified below but
not modeled as a completed launch or an executable initial buy.

The model validates arithmetic, supported discriminants, required flags and numeric ranges. It does
not prove account ownership, PDA derivation, callback flags, reward-counter solvency, mint/holding
overflow beyond the balances it uses, account existence, binary identity or legal launch parameters.
Those are required live gates even if hypothetical arithmetic succeeds. Stable errors such as
`STALE_STATE`, `QUOTE_EXPIRED`, `ZERO_MIN_OUT`, `NATIVE_CAP_EXCEEDED`, `CREATOR_LOCKED`,
`EARLY_LOCKED`, `FURNACE_NOT_LIT` and `INSUFFICIENT_LIQUIDITY` fail closed. Malformed object shapes
may also throw a TypeError; there is no public HTTP error contract yet.

## Fresh account snapshot contract — required before any future live quote

1. Require explicit devnet selection; verify genesis, pinned manifest and all IDLs. Read Program and
   ProgramData accounts and compare loader, program data address, deploy slot, upgrade authority and
   manifest ELF hash algorithm. Unknown or upgraded binaries refuse, never silently use old math.
2. Resolve all addresses from mint/pool/launch and pinned program IDs; include source and recipient
   separately. Read the full dependency set plus Clock at one finalized bank context. Batch when possible;
   if multiple calls cannot establish coherence, retry/refuse. `minContextSlot` is a lower bound, not
   proof that separate reads observed the same bank. Reject RPC null/error/undecodable/owner mismatch.
3. Preserve missing-account facts. A new recipient holding has zero balance only after confirmed
   nonexistence at its correctly derived address. An unavailable RPC value is not zero. A missing launch
   or pool is not an empty pool. Confirm source authority, mint, hook registry, flags and extras.
4. Hash sorted `(address, owner, lamports, executable, data bytes OR absent marker)` for **all** dependencies
   into `accountsHash`; bind chain time, wallet, recipient, mint, side, input, slippage, caps and budget.
   No client-provided digest/flag is trusted. The standalone model accepts these as fixture inputs only.
5. Read balances, operation pause flags, reserve/protocol accrual coherence, burn supply, Kit full reward
   accounting and holder data, Half-Life state, fee destinations and account setup costs. Snapshot
   freshness is not evidence of correctness of an untrusted RPC; deployment verification also trusts RPC.
6. Refresh on wallet/network/recipient/amount/rule change, any dependency update, expiry, or retry. Never
   carry a first-buy exemption, unlock transition, fee rate or account-existence assumption across quotes.

## Fee and output arithmetic (exact input only)

Use checked integer operations, no decimal rounding until display. Let `ceilDiv(n,d)` round up,
`F(a,b)=ceilDiv(a*b,10000)` and `B(a,b)=floor(a*b/10000)` (burn becomes zero unless strictly below `a`).
Creator/holder fees are individually ceil-rounded. If their sum is not strictly below their quote-side
amount, **both drop to zero**; do not partially clamp one. Holder fee applies only at the callback's
eligible threshold. Burns are not collected fees and have no protocol share.

Let `L` be effective LP/sniper bps, `S` pool protocol-share bps, and `A` exact input.
`X=real_input_reserve+virtual_input`, `Y=real_output_reserve+virtual_output`.
Curve output `G=floor(N*Y/(X+N))` must be positive and at most the **real** output reserve.
Raw quote vault balance includes protocol accrual; it must not be substituted for `quoteReserve`.

**Buy (quote → base):**

1. `C,H = launchFees(A)` using Kit eligibility **before** the buy; `R=A−C−H`.
2. `LP=F(R,L)`, `P_in=F(C+H,S)`, `N=R−LP−P_in > 0`.
3. Curve yields `G`; base burn `D=B(G,burnBuyBps)`; net recipient base `O=G−D > 0`.
4. None/Kit take no base transfer fee; recognized Half-Life pool source is exempt. Thus output protocol
   share is zero for all supported buys. Quote reserve increases by `N`, base decreases by `G`.

**Sell (base → quote):**

1. Burn `D=B(A,burnSellBps)` first. Half-Life cut `T=floor((A−D)*ppm/1_000_000)` next; otherwise `T=0`.
   `R=N=A−D−T > 0`. Kit eligible supply falls by all `A` (burn plus transfer), not only `R`.
2. Curve yields `G`; `LP=F(G,L)`. Value collected base cuts at swap price:
   `V=ceilDiv(T*G,N)`; `P_in=F(V,S)`; `Q=G−LP−P_in > 0`.
3. Creator/holder fees `C,H=launchFees(Q)` use Kit eligibility **after** the input left the seller.
   `P_out=F(C+H,S)`; net quote `O=Q−C−H−P_out > 0`.
4. Base reserve increases by `N`, quote decreases by `G`. Protocol receives `LP+P_in+P_out`.

Creator fee goes to launch quote holding; holder fee to Kit reward vault; Half-Life cut to furnace;
burn destroys base. Fee amounts are already inside exact input or removed from output: **never add them
again to wallet debit**. Protocol share is an additional cost, not deducted from the creator's receipt.
Creator listed-config author splits occur on later claims and are not an additional trade fee.

`L=start−floor((start−base)*elapsed/window)` during the sniper window (elapsed clamped at zero), else base.
Creator's first buy pays base only when actor AND recipient are creator, `creatorBought=false`, and
chain time is strictly before window end. Only that exemption is consumed. Do not assume the buyer is
the creator merely because they connected the wallet used to draft a launch.

## Kit and Half-Life constraints

Kit has one token hook and independent pool-side burn/creator fees. Holder rewards activate when either
holder rate is nonzero. Reward eligibility excludes pool/launch and companion creator PDA, not an ordinary
creator wallet. `minEligible` is fixed from initial supply / 1000. The current burn-reduced supply must
not recompute this threshold or max-wallet cap.

For buys, `recipientBalance+O <= maxWalletAmount` before graduation, equality allowed. Rewards require a
non-excluded destination to be on curve. Refused protocol/config/program/default destinations still fail.
Creator cannot sell before `creatorUnlockAt`; early buyer can sell only if `balance−A >= earlyLocked`
before `earlyUnlockAt`. Burns also respect early locks. Creator burn alone is exempt from creator lock,
but a sell still transfers and remains locked. Unlock equality is allowed. Early-window buys are locked
until the common `earlyUnlockAt`, shown as `lockedUntil`; min-out does not imply immediate sellability.
The Kit sync/settle reward math and overflow checks must still be simulated; the model does not estimate
future rewards or subtract them from debit. Explicit reward shares stream over one hour.

Half-Life source fee starts at **200000 ppm (20%)**, halves each 21600 seconds with linear integer
interpolation, and is zero from 172800 seconds. At age 21599 rate is 100005 ppm; at 21600 it is 100000.
Fee itself rounds down. Unstamped or future-stamped sources use age zero. Launch/pool/furnace sources
are exempt. A fee-bearing transfer requires a lit furnace; an exempt buy does not. Wallet-to-wallet
transfers preserve source age and blend the destination timestamp by balances, truncating division;
they do not reset all tokens' age. Therefore quotes must read the actual source hook bytes, not a
UI purchase timestamp. The isolated model does not predict post-buy blended timestamps or W2W transfers;
a subsequent sell requires a new snapshot. Custom hooks other than this pinned Half-Life refuse.

For **new launch validation**, read live config: creator fee ≤ its ceiling, holder and burn each ≤
their respective per-side bounds, and `creator+holder_side+burn_side <= max_rules_fee_bps`. Defaults
200/100/300 bps (holder/burn/aggregate) are not live evidence; hard ceilings are 500/500/1000.
Aggregate is a configuration constraint, not a total-trade-fee cap: it excludes LP/sniper, protocol
share and a custom Half-Life fee. Max-wallet/lock bounds and custom-hook-versus-Kit exclusivity also
must pass. Do not retroactively apply today's creation defaults to an existing pool's stored rates.

## Total debit, reserves and net output

For a fresh buy wallet, existing quote balance is zero. Only the shortfall is hypothetically wrapped:
`wrap=max(A−existingQuoteBalance,0)`; bridged-SOL unit equals one lamport under the pinned native wrapper.
`nativeDebit=wrap+rentAllowance+baseNetworkFeeAllowance+priorityFeeAllowance`.
Require `A<=maxInput`, `nativeDebit<=maxNativeDebitLamports` and
`nativeBalance>=nativeDebit+retainedReserve`. All equality boundaries pass. Existing quote consumption
is `A−wrap` and must be displayed separately; do not add both `A` and `wrap` as native spend.

For a sell, exact base debit is `A`, native debit is rent plus network allowances, and output is bridged
SOL **not native SOL**. Do not use prospective proceeds to fund gas/rent or call output “net native SOL”
without a separately reviewed unwrap plan. Network/rent remain separate assets/cost lines. No USD sum
or base-token-to-lamport sum is implied. A failed submitted transaction can still cost network fees;
multi-transaction setup can leave recoverable rent/quote holdings even when a later swap fails.

Rent requires an itemized, fresh account plan: account address/role, owner, existence, actual data size,
rent-exemption minimum, creation payer and refundable/nonrefundable treatment. These are Bordrless
holdings, **not generic SPL ATA rent constants**. Include required hook/holding/registry allocations.
No credit for hypothetical close refunds. Network allowance must include every transaction/signature
and all selected compute-budget charges; priority fee is counted once, not duplicated if the RPC fee
estimate already includes it. Use a documented upper bound, not an average. Reserve is retained balance,
not spent fee. Zero is permitted only when positively known; the fixture's numbers are synthetic.

For launch + optional initial buy, add the live launch fee, any pool creation fee **actually charged**,
all mint/launch/pool/vault/registry/Kit/Half-Life account rent, initialization/metadata costs, bridge wrap,
and network bounds for all required steps. Determine fee waivers from the actual create path rather
than summing global defaults. A not-yet-created pool has no fresh reserves or identity, so the model
cannot issue a live launch quote. Counterfactual initialized state must remain hypothetical. Do not
reuse the swap-only debit as the full launch debit. Key custody, recovery and partial-setup handling
remain separate unresolved integration gates.

## Slippage, impact and stale-state rejection

`minOutput=floor(O*(10000−slippageBps)/10000)`; **refuse if zero**, do not silently raise to one or accept
100% slippage. The pinned swap measures actual recipient holding increase after hooks/burn/withholding
and atomically requires it ≥ `min_amount_out`. It does not enforce a UI quote TTL or a blanket total
wallet-debit cap. The model emits a proposed positive threshold only, never an instruction containing it.

Report curve-only average-execution deterioration from the pretrade marginal spot as
`priceImpactBps=ceil(10000*N/(X+N))`. Reject above caller `maxPriceImpactBps`. Separately report
`allInLossBps=ceil(10000*(A*Y−O*X)/(A*Y))`, including fees, burn and rounding. These use raw-unit ratios;
display prices must account for each mint's decimals. Neither metric is a guarantee about future markets.
Slippage tolerance covers movement after quoting, not quoted price impact, and does not bypass lock/cap rules.

Consumer policy proposed here: expiry at `observedAtMs+15000`, exclusive; slot age ≤32, inclusive.
Both must hold. A quote issued late in its snapshot's life gets only the remaining lifetime. Future
timestamps/slots refuse. These are proposed conservative defaults, not producer guarantees. Chain time
drives fees/locks, local time drives wall expiry. A newer Clock value conservatively requires a requote
even if the rate happened not to change. A new observation cannot extend the old quote's deadline.

Revalidation recomputes the binding over all normalized state (including chain time and account hash),
intent and budget, and reruns the model. Any difference rejects `STALE_STATE`. This hash is a local
consistency check, not a signature, authenticated API token, or authorization. Future server-issued
quotes must bind an immutable server record or authenticated token; never trust a client-edited quote.

No preflight read can eliminate changes between read and landing. Future execution would require
positive on-chain min-out, exact-input and fully audited instruction/debit bounds, fresh simulation of
the exact message, current blockhash/last-valid height, and re-approval after changes. Client TTL is
not an on-chain deadline: a transaction with an otherwise valid blockhash could land after it. Strong
state/TTL enforcement would require a reviewed program-level guard; it is not in the pinned SwapArgs.
**No such execution work is authorized or included here.**

## Exact remaining live inputs and gates

- **Deployment:** genesis; Program/ProgramData for token/swap/launch/bridge and selected Kit/Half-Life;
  loader, executable flag, deploy slot, authority, trimmed ELF hashes; live config PDAs and pause states.
- **Pool/launch:** target mint and decimals; launch/pool PDA relationships, owners/discriminators/versions;
  reserves/virtual offsets, fee model/share, hook program/flags, protocol accrual, vault balances,
  swap count/volume overflow headroom, creator and consumed-first-buy flag, creation time, sniper and
  creator/holder/burn rates; graduation status. Current config defaults do not substitute for these.
- **Wallet/accounts:** actual signer/recipient identity and authority, native balance, source/recipient
  base and quote holdings (including confirmed absent holdings), owners/mints/balances/64-byte hook data;
  on-curve/exclusion/refusal checks, mint supply/authority/freeze constraints, hook registry and all extras,
  launch quote holding and holder reward vault identity/balance.
- **Kit:** modules, eligible/min-eligible, initial supply/fixed cap, graduated flag, creator/companion
  identity, unlocks and early locked amounts; `acc_per_share`, remainder, held/seen/claimed amounts,
  current/next streams and timing, and source/destination settlement data for complete simulation.
- **Half-Life:** state mint/launch/resolved pool/furnace owner, furnace holding ownership and existence,
  source/destination stamps and balances; source exemption, hook flags and registry extras.
- **Funding:** native wrapper/native mint/quote mint/vault linkage, pause, total wrapped and vault/rent
  solvency if unwrapping; exact account allocation/rent list, launch/creation fees when applicable,
  base/priority fee bounds and retained native reserve. No fee amount is supplied by the manifest.
- **Freshness:** coherent finalized context slot, Clock timestamp, observation time, dependency hash,
  current slot/time, then (only if later separately authorized) exact-message simulation, recent
  blockhash and last-valid block height. No live snapshot or simulation was obtained for this deliverable.

Until those inputs and the separate producer-approved execution contract exist, the six-export
read-only package and repo.ing's preview/inspection-only boundary remain unchanged.
