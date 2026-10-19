// launch-usd-bounds: the on-chain half of USD launch pricing (owner decision 2026-10-19). One governed_set_config sets
// the launch config's min/max virtual quote to [5.625, 112.5] SOL, so a ~$5,000 opening is valid while SOL trades
// between $50 and $1,000. The bounds come from the same constant the website refuses with; every other config field is
// carried over from the live config unchanged. plan compiles and previews only; execute needs --approved like a gate.
import BN from 'bn.js'
import * as ix from '../instructions.mjs'
import { fieldDiff, plain, sol } from '../preview.mjs'
import { VIRTUAL_QUOTE_BOUNDS, formatSolPrice } from '../../hooklab-launch-pricing.mjs'
import { check, hex, nextState, gsection, gview, simpleMessage } from './common.mjs'
import { governedSnapshot, payerRow, verifyGovernedConfig } from './admin.mjs'

const STAGE = 'launch-usd-bounds', MAX_U64 = new BN('18446744073709551615')
// The SOL price at which each bound is the ~$5,000 opening quote (Vq = 5,625 USD / price).
const solPriceAt = lamports => formatSolPrice(5_625n * 1_000_000_000n * 1_000_000n / BigInt(lamports)).replace(/\.00$/, '')
// Account byte offsets of the two bound fields, found by encoding the live Config with both extremes (layout-proof).
export function boundByteOffsets(coder, decoded) {
  const encode = value => coder.types.encode('Config', { ...decoded, min_virtual_quote: value, max_virtual_quote: value })
  const low = encode(new BN(0)), high = encode(MAX_U64)
  return [...low.keys()].filter(i => low[i] !== high[i]).map(i => i + 8)
}
function byteCheck(coder, raw, decoded, after) {
  const relay = value => Buffer.concat([raw.subarray(0, 8), coder.types.encode('Config', value)])
  check(relay(decoded).equals(raw), 'Live launch config bytes are not canonical; refusing to predict its post-state')
  const predicted = relay({ ...decoded, min_virtual_quote: after.min_virtual_quote, max_virtual_quote: after.max_virtual_quote })
  const bounds = boundByteOffsets(coder, decoded), changed = [...predicted.keys()].filter(i => predicted[i] !== raw[i])
  check(predicted.length === raw.length && bounds.length === 16 && changed.every(i => bounds.includes(i)), 'Predicted config bytes change outside the virtual quote bounds')
  return bounds
}

export const launchUsdBounds = {
  name: STAGE,
  async build(ctx, pinned) {
    const { snapshot, config, governance, addresses } = await governedSnapshot(ctx, 'launch')
    const current = ctx.ix.launchConfigArgs(config)
    const after = { ...current, min_virtual_quote: new BN(VIRTUAL_QUOTE_BOUNDS.min.toString()), max_virtual_quote: new BN(VIRTUAL_QUOTE_BOUNDS.max.toString()) }
    const diff = fieldDiff(plain(current), plain(after))
    if (!diff.length) return { blocked: `already applied: launch config virtual quote bounds already equal ${sol(VIRTUAL_QUOTE_BOUNDS.min)}–${sol(VIRTUAL_QUOTE_BOUNDS.max)}`, observedSlot: snapshot.slot }
    check(diff.every(x => ['min_virtual_quote', 'max_virtual_quote'].includes(x.field)), 'Only the virtual quote bounds may change')
    const bounds = byteCheck(ctx.abi.coders.launch, Buffer.from(snapshot.accounts.get(addresses.config).dataBase64, 'base64'), config, after)
    const expected = ctx.ix.governanceCommitment('launch', governance.state)
    const instruction = ctx.ix.governedSetConfig(ctx.programs, 'launch', ctx.roles.admin, expected, after)
    const afterState = nextState(governance.state, { config_digest: [...ix.economicsDigest('launch', ctx.programs.launch, after)], roles: { treasury: after.treasury } })
    const { review, blockhash } = await simpleMessage(ctx, { stage: STAGE, payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot })
    const before = gview(ctx, 'launch', governance.state).commitment, next = hex(ctx.ix.governanceCommitment('launch', afterState))
    const unchanged = Object.keys(plain(current)).filter(field => !diff.some(x => x.field === field))
    return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [
        { title: 'launch config field changes (before -> after)', rows: diff.map(x => `${x.field}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)} (${sol(x.before)} -> ${sol(x.after)}: the opening quote when SOL is ${solPriceAt(x.after)})`) },
        { title: 'everything else stays byte-identical', rows: [`unchanged: ${unchanged.join(', ')} (taken from the live config, including paused=${config.paused})`,
          `config account bytes change only at offsets ${bounds[0]}-${bounds.at(-1)} (the two bounds); the launches counter is not an argument`] },
        { title: 'what this allows', rows: ['website launches open at ≈$5,000: virtual quote = ceil(1.125 x $5,000 / SOL price), fixed when the owner invites',
          `the bounds accept SOL prices from ${solPriceAt(VIRTUAL_QUOTE_BOUNDS.max)} to ${solPriceAt(VIRTUAL_QUOTE_BOUNDS.min)}; outside them the website refuses to invite`,
          'the standard 1 SOL quote no longer passes on chain: land this with no launch in flight, together with a deploy that sets HOOK_LAUNCH_USD_PRICING=true'] },
        gsection(ctx, 'launch', governance.state, afterState),
        { title: 'refresh after it lands', rows: [
          `refresh: launch governance commitment ${before} -> ${next}; re-plan every launch-governance stage planned before (customer-grant, gates)`,
          'refresh: launch guard expected_launch_economics_hash covers min/max_virtual_quote; launch reviews built before this change fail on chain (the compiler recomputes it per review)',
          'refresh: production bundle launch-config pin (approvedDataBase64/dataSha256, config-counters-v1) and creation-control pin: re-collect with scripts/hooklab-production-bundle.mjs and redeploy the dossier'] },
        { title: 'funds', rows: [payerRow(ctx, snapshot), 'no SOL or token transfer besides the network fee'] }],
      expect: { role: 'launch', config: plain(after), commitment: next } }
  },
  verify: verifyGovernedConfig,
}
