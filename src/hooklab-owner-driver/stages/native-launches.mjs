// native-launches --to on|off: the governed switch of native-SOL launches, launch Config byte 186 (hook-lab
// docs/native-sol-port-design.md §5.2). On, create_launch_custom_v4 is the only launch route and v3 and plain launches are
// refused on chain; off, the reverse. Review I-2: the byte is read before anything is compiled, and a flip to the value it
// already has is refused, because every flip bumps the launch governance revision and so stales every signed launch even
// when nothing else changes. It also refuses unless the deployed launch program is the reviewed native build. plan
// compiles and previews only; execute needs --approved like a gate.
import { derivedAddresses } from '../pins.mjs'
import * as ix from '../instructions.mjs'
import { NATIVE_ELF, NATIVE_FLAGS, NATIVE_SOURCE } from '../../hooklab-native-pins.mjs'
import { governedSetNativeLaunches, nativeLaunchesDigest, nativeLaunchesSwitch, nativeProgramDataMatches } from '../../hooklab-native-launch.mjs'
import { check, hex, nextState, governanceSection, governanceView, simpleMessage } from './common.mjs'
import { governedSnapshot, payerRow } from './admin.mjs'

const STAGE = 'native-launches', BYTE = NATIVE_FLAGS.configNativeLaunches
const wanted = ctx => { const to = ctx.options?.to; check(to === 'on' || to === 'off', 'native-launches requires --to on or --to off'); return to === 'on' }
const word = on => on ? 'ON' : 'OFF'

function effects(on) {
  return on ? ['create_launch_custom_v4 (native SOL: the pool holds lamports, creator fees go to the launch account) becomes the only launch route',
    'v3 and plain launches are refused on chain (BridgedCustomLaunchClosed, PlainLaunchClosed); a stale website cannot create a bridged launch',
    'coins already launched are unchanged: bridged coins keep trading on swap, native ones on swap_v2']
    : ['create_launch_custom_v4 is refused on chain (NativeLaunchesOff) and bridged v3 launches reopen',
      'native coins already launched keep trading on swap_v2, and their creators can still claim their fees (keep HOOK_NATIVE_LAUNCHES_ENABLED=true on the website: it also serves claims)']
}

export const nativeLaunches = {
  name: STAGE,
  async build(ctx, pinned) {
    const on = wanted(ctx), d = derivedAddresses(ctx.programs)
    const { snapshot, config, governance, addresses } = await governedSnapshot(ctx, 'launch', [d.launchProgramData, d.swapProgramData])
    // I-2: the switch as both providers read it, before any message exists.
    const raw = Buffer.from(snapshot.accounts.get(addresses.config).dataBase64, 'base64'), current = nativeLaunchesSwitch(raw)
    if (current === on) return { blocked: `native launches are already ${word(on)} (launch Config byte ${BYTE} = ${Number(on)}). Refusing a flip to the same value: it would still bump the launch governance revision and make every signed launch stale`, observedSlot: snapshot.slot }
    // Both programs: a native launch creates its pool through the swap's create_pool_v4.
    for (const [role, address] of [['launch', d.launchProgramData], ['swap', d.swapProgramData]]) {
      const programData = snapshot.accounts.get(address)
      if (!programData || !nativeProgramDataMatches(role, Buffer.from(programData.dataBase64, 'base64')))
        return { blocked: `the deployed ${role} program is not the reviewed native-SOL build (hook-lab ${NATIVE_SOURCE.commit}, ELF ${NATIVE_ELF[role].trimmedSha256.slice(0, 12)}…); upgrade it first`, observedSlot: snapshot.slot }
    }
    const expected = ix.governanceCommitment('launch', governance.state)
    const instruction = governedSetNativeLaunches({ launchProgram: ctx.programs.launch, admin: ctx.roles.admin, expected, on })
    // A recorded policy change: only the revision moves, so the commitment changes and nothing else in the state does.
    const afterState = nextState(governance.state, {})
    const { review, blockhash } = await simpleMessage(ctx, { stage: STAGE, payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, units: 60000 })
    const before = governanceView('launch', governance.state).commitment, next = hex(ix.governanceCommitment('launch', afterState))
    return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [
        { title: `native launches (launch Config byte ${BYTE})`, rows: [`byte ${BYTE}: ${Number(current)} -> ${Number(on)} (native launches ${word(current)} -> ${word(on)})`, ...effects(on)] },
        { title: 'everything else stays byte-identical', rows: [`config account bytes change only at offset ${BYTE}; the switch is outside the governed economics (ConfigArgs), so the config digest is unchanged`,
          `recorded policy change digest ${hex(nativeLaunchesDigest(ctx.programs.launch, addresses.config, on))} = sha256("hook-lab:native-launches:v1" || launch program || config || ${Number(on)})`,
          `launch config paused=${config.paused} and every other field are taken from the live account and not changed`] },
        governanceSection('launch', governance.state, afterState),
        { title: 'in-flight launches go stale', rows: [`the revision bump changes every launch's control hash: any launch reviewed or co-signed before this lands fails on chain (CreationPolicyChanged, or ${on ? 'BridgedCustomLaunchClosed' : 'NativeLaunchesOff'}) and is reviewed again`,
          `refresh: launch governance commitment ${before} -> ${next}; re-plan customer-grant and every launch-governance stage planned before`,
          'refresh: production bundle launch-config pin (approvedDataBase64/dataSha256) and creation-control pin: re-collect with scripts/hooklab-production-bundle.mjs and redeploy the dossier',
          ...(on ? ['before this: the website release that keeps working with this byte on must be live: launch preparation, native launches and trading (swap_v2) with HOOK_NATIVE_LAUNCHES_ENABLED=true and the native-SOL profile. An older release refuses every new launch and every trade once this lands',
            'before this: the owner agent is the native-aware build (an older one refuses every v4 launch)'] : [])] },
        { title: 'funds', rows: [payerRow(ctx, snapshot), 'no SOL or token transfer besides the network fee'] }],
      expect: { on, commitment: next } }
  },
  async verify(ctx, expect) {
    const { snapshot, governance, addresses } = await governedSnapshot(ctx, 'launch')
    check(nativeLaunchesSwitch(Buffer.from(snapshot.accounts.get(addresses.config).dataBase64, 'base64')) === expect.on, `launch Config byte ${BYTE} differs from the reviewed post-state`)
    check(governanceView('launch', governance.state).commitment === expect.commitment, 'Launch governance commitment differs from the predicted post-state')
    return [`native launches ${word(expect.on)} (launch Config byte ${BYTE} = ${Number(expect.on)})`, `launch governance commitment ${expect.commitment}`]
  },
}
