# Hook Lab template drafts

These are authoring templates, **not executable launches**. `/coins/new` adopts
them through the lossless `repo-ing/hook-lab-recipe/1` envelope and separate recipe
storage, never through the narrow legacy plan. All six templates can be drafted,
saved and inspected; no template implies V2 execution capability. No query import
or handoff URL is approved. See `DIRECT_COINS.md` for the current adoption boundary.

## Interface for later adoption

`src/hook-lab-templates.mjs` is client-safe and imports only the existing `zod`
dependency. It does not import the Node-only Hook Lab SDK or perform I/O.

- `HOOK_LAB_TEMPLATES`: six cards with titles, subtitles, descriptions, warnings,
  and required/optional block types. IDs are `plain`, `creator-rewards`, `burns`,
  `locks`, `max-wallet`, and `half-life`.
- `HOOK_LAB_BLOCKS`: field labels, units, explanatory copy, source anchors, and
  fixed values where the program requires them. Optional blocks use these same
  fields; adding one requires every field, initially `null` while editing.
- `HOOK_LAB_TEMPLATE_COPY`: shared disclosure, fee/unit explanation, adoption
  notice, and the action label **Export recipe draft**. Show these with the cards
  and fields, not only in documentation.
- `createHookLabTemplateDraft(templateId, coin?)`: returns a fresh
  `{ templateId, coin: { name, ticker }, blocks }`. Editable numbers are `null`,
  never suggested financial defaults. The only populated numbers are the fixed
  Half-Life constants. Coin metadata defaults to empty strings.
- `hookLabTemplateDraftSchema`: strict editing schema, accepting explicit `null`
  numeric fields but not missing fields, duplicate blocks, unknown properties,
  unsupported blocks, or blocks outside the selected template.
- `exportHookLabTemplate(draft)`: throws `ZodError` with field paths when incomplete
  or malformed; otherwise returns only `{ format: 'hook-lab/1', coin, blocks }`.
  It does not emit a validity flag, intent, transaction, or readiness claim.
- `HOOK_LAB_TEMPLATE_PIN`: provenance for this authoring contract, not a substitute
  for the server's manifest/IDL verification.

```js
import { createHookLabTemplateDraft, exportHookLabTemplate } from '../src/hook-lab-templates.mjs'

const draft = createHookLabTemplateDraft('creator-rewards', { name: 'Example', ticker: 'EX' })
// draft.blocks = [{ type: 'creator_fee', fee_bps: null }]
// Example explicit user choice; this is NOT a suggested/default rate.
draft.blocks[0].fee_bps = 125
const rawRecipe = exportHookLabTemplate(draft)
// { format: 'hook-lab/1', coin: { name: 'Example', ticker: 'EX' },
//   blocks: [{ type: 'creator_fee', fee_bps: 125 }] }
```

After a separately reviewed consumer change, the server must pass `rawRecipe` to
the pinned `previewHookLabIntegration(rawRecipe, inspection)`, preserving all
refusals and warnings. Require the existing explicit devnet confirmation and
trusted RPC inspection; never accept client-supplied inspection results as proof.
Do not silently translate these richer drafts into today's narrower persisted
plan: that would drop selected rules. This module does not implement that handoff.

## Six templates, three upstream recipe paths

| Template | Required block | Optional blocks | Upstream path |
| --- | --- | --- | --- |
| Plain | None | Creator fee, burn | `plain` |
| Creator rewards | `creator_fee` | Holder rewards, burn, max wallet, creator lock, early lock | `plain`, or `kit` when a Kit rule is active |
| Trade burns | `burn` | Creator fee | `plain` |
| Wallet locks | `creator_lock` | Early lock, creator fee, holder rewards, burn, max wallet | `kit` when active |
| Max wallet | `max_wallet` | Creator fee, holder rewards, burn, creator lock, early lock | `kit` when valid |
| Fixed Half-Life | `exit_halflife` | Creator fee, burn | `halfLife` |

Template names are navigation/copy, not new SDK recipe enums. The SDK derives the
actual path from selected rules. Explicit zero may disable a rule; selecting a
template alone does not activate it. Use Plain to omit every optional rule. The
locks template starts with a creator lock; an explicit zero plus an early-lock
block can express early-buyer locking alone.

One mint has one token hook. The Half-Life template excludes **all** Kit blocks,
even zero-valued ones, so an optional field cannot later activate a second hook.
This authoring restriction is intentionally narrower than the parser, which
detects active Kit rules. Creator fees and burns are pool rules and can coexist
with either hook. Other templates are curated subsets, not an arbitrary recipe
importer. No companion, dev buy, vesting, fee split, lottery, custom hook, Snowball,
Lossback, sniper-fee override, or recipient configuration is exposed.

## Field grounding and units

Authoritative delivery: [Hook Lab delivery commit](https://github.com/New1Direction/hook-lab/commit/9b3473e001a9abc73bf644d4206e47abc95a815b).
The [raw manifest](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/sdk/packages/sdk/integration/devnet.json)
has SHA-256 `3e904e1030f581d8b79879aaf43a5f3c9d20f63979008c2e4b0799581e14e403`;
its [ABI baseline](https://github.com/New1Direction/hook-lab/commit/ee7234cb7a32781fecba5470f24f43233cf94167)
is distinct from the delivery commit. All 11 raw SDK IDLs must match the manifest.
IDL presence and deployed program status do not grant recipe/execution support.
Do not substitute a public npm package.

The pinned [recipe parser](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/sdk/packages/launcher/src/plan.ts)
owns the JSON-to-program mapping. The template sources below refer to types in
[`bordrless_launch.json`](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/sdk/packages/sdk/idl/bordrless_launch.json).

| Wire field | Pinned source | Meaning |
| --- | --- | --- |
| `format` | Recipe parser | Literal `hook-lab/1` |
| `coin.name`, `coin.ticker` | Recipe parser | Trimmed nonempty name ≤32 UTF-8 bytes; ticker 1–10 ASCII alphanumerics, uppercased. Invalid text is rejected, not truncated or stripped. |
| `creator_fee.fee_bps` | `LaunchConfig.creator_fee_bps` | One quote-denominated creator fee on buys and sells. Not holder rewards. |
| `holder_rewards.buy_bps`, `sell_bps` | `LaunchRules.holder_fee_buy_bps`, `holder_fee_sell_bps` | Holder-vault fees from buy quote input / sell quote output after protocol fee. |
| `burn.buy_bps`, `sell_bps` | `LaunchRules.burn_buy_bps`, `burn_sell_bps` | Burn this token from buy output / sell input; not a buyback. |
| `creator_lock.days_secs` | `LaunchRules.creator_lock_secs` | Seconds from launch, despite the name `days_secs`. Zero disables the creator lock. |
| `early_lock.window_secs`, `lock_secs` | `LaunchRules.early_window_secs`, `early_lock_secs` | Window and unlock offsets both measured from launch, not from each purchase. |
| `max_wallet.pct_bps` | `LaunchRules.max_wallet_bps` | Share of initial supply, not a token count or per-person limit. |
| `exit_halflife.start_bps`, `half_secs`, `zero_secs` | Recipe parser `HALF_LIFE_CURVE`; Half-Life program constants | Exactly `2000`, `21600`, `172800`; no curve customization. |

All rates use integer basis points: 100 bps = 1%. Durations use integer seconds.
Local validation checks only the parser's primitive ranges (0–10,000 bps and
0–4,294,967,295 seconds), complete fields, template composition, and fixed values.
**These are wire ranges, not permitted live economic limits.** Do not use them as
sliders implying launchable rates or durations. The SDK owns inspected ceilings,
per-side creator + holder + burn totals, max-wallet limits, lock timing, and all
inspection compatibility/refusals. A successful export may still be refused.
No numeric strings are coerced; blank, omitted, and zero are distinct.

Important interpretation details:

- [`KitConfig`](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/sdk/packages/sdk/idl/bordrless_kit.json)
  defines bridged-SOL holder rewards and eligibility, and a fixed initial-supply
  wallet cap that burns do not tighten. The cap lifts at graduation.
- The [Half-Life program](https://github.com/New1Direction/hook-lab/blob/9b3473e001a9abc73bf644d4206e47abc95a815b/programs/half_life/src/lib.rs)
  uses 200,000 PPM internally, halves over 21,600 seconds with linear interpolation,
  and reaches zero after eight intervals. The clock is balance-weighted token
  age, not launch age. Wallet transfers carry age; incoming tokens blend it.
  Outgoing wallet transfers/sells pay the exit burn in addition to pool rules;
  launch/pool/furnace-owned source holdings are exempt.
- Locks can block transfers and sells. They are not LP liquidity locks or vesting.
  Omit `early_lock` to disable it: this pinned parser refuses `window_secs: 0,
  lock_secs: 0` because its unlock must be later than its window. Do not replace
  that refusal with on-chain zero/off semantics.
- Plain still incurs protocol fees, including the protocol-wide sniper fee.
  Neither template output nor SDK intent is a quote, all-in cost, or earnings
  projection. The pinned integration refuses every transaction build with
  `UNSIGNED_BUILD_DEFERRED`; these templates never call a build method.

## Offline verification

Run local authoring checks from repo.ing:

```sh
node --test tests/hook-lab-templates.test.mjs
```

This runs six local tests and explicitly skips the optional upstream conformance
test. To run all seven against the actual approved contract, prepare an isolated
checkout (do not copy or modify the integration owner's vendor directory):

```sh
git clone https://github.com/New1Direction/hook-lab.git /tmp/hooklab-template-reference
git -C /tmp/hooklab-template-reference checkout --detach 9b3473e001a9abc73bf644d4206e47abc95a815b
pnpm --dir /tmp/hooklab-template-reference/sdk install --frozen-lockfile --ignore-scripts
HOOK_LAB_SOURCE=/tmp/hooklab-template-reference \
  pnpm --dir /tmp/hooklab-template-reference/sdk/packages/launcher exec tsx --test \
  "$PWD/tests/hook-lab-templates.test.mjs"
```

The conformance test verifies the checkout commit, manifest hash, all 11 raw IDL
hashes and addresses, and each editable field's IDL anchor. It sends all six
templates plus combined Kit and Half-Life/pool-rule examples through the actual
pinned preview, then checks synthetic inspection limits on both sides of a fee
boundary and SDK refusals for fee sums, wallet caps, and lock timing. It makes no
RPC calls, constructs no transactions, and never signs, deploys, or spends.

No rendered UI is added by this work. Before UI adoption, test the actual empty,
incomplete, SDK-refused, and fixed-curve states; retain the template-specific
warnings and display “recipe draft,” never “ready to launch.”
