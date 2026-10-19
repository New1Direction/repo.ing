// Read-only full state dump. Never builds or signs a message.
import { derivedAddresses, canaryAddresses, holdingAddress, authorizationAddress, LOADER, pk } from '../pins.mjs'
import { ELF } from '../artifacts.mjs'
import { readAccounts } from '../rpc.mjs'
import { plain, sol } from '../preview.mjs'
import { cdecode, gview } from './common.mjs'
import { programDataState } from './admin.mjs'
import { altRecord } from './canary-common.mjs'

const amount = account => account ? Buffer.from(account.dataBase64, 'base64').readBigUInt64LE(74).toString() : null
function programRow(accounts, role, address, programData, elf) {
  const program = accounts.get(address), data = accounts.get(programData)
  if (!program) return `${role.padEnd(7)} ${address}: NOT DEPLOYED`
  const link = Buffer.from(program.dataBase64, 'base64'), linked = program.owner === LOADER && program.executable && link.length === 36 && pk(link.subarray(4)).toBase58() === programData
  if (!data) return `${role.padEnd(7)} ${address}: program present, ProgramData ${programData} missing`
  const state = elf ? programDataState(data, elf) : programDataState(data, { length: Buffer.from(data.dataBase64, 'base64').length - 45, sha256: '' })
  return `${role.padEnd(7)} ${address}: linked=${linked} deploySlot=${state.deploySlot} upgradeAuthority=${state.authority ?? 'NONE (immutable)'} elf=${elf ? (state.elfMatches ? 'matches reviewed ' + elf.sha256.slice(0, 12) : 'DIFFERS from reviewed ' + elf.sha256.slice(0, 12)) : `${state.length} bytes (not pinned)`}`
}
export const status = {
  name: 'status',
  async build(ctx) {
    // Our own stack: its programs and pins, its quote marker, no bridge, no canary or invites.
    const stack = !!ctx.stack, d = derivedAddresses(ctx.programs, ctx.quoteMint), r = ctx.roles, c = r.mint && !stack ? canaryAddresses(ctx.programs, ctx.quoteMint, r.mint) : null
    const table = stack ? null : altRecord(ctx)?.address, elf = ctx.elf ?? ELF
    const programRows = [['launch', ctx.programs.launch, d.launchProgramData, elf.launch], ['swap', ctx.programs.swap, d.swapProgramData, elf.swap], ['gate', ctx.programs.gate, d.gateProgramData, elf.gate],
      ['token', ctx.programs.token, d.tokenProgramData, elf.token], ...(stack ? [] : [['bridge', ctx.programs.bridge, d.bridgeProgramData, null]])]
    const roleList = Object.entries(r).filter(([, a]) => a)
    const extra = [d.launchConfig, d.launchGovernance, d.swapConfig, d.swapGovernance, ctx.quoteMint, ...(stack ? [] : [authorizationAddress(r.creator, ctx.programs.launch),
      holdingAddress(ctx.quoteMint, r.creator, ctx.programs.token), holdingAddress(ctx.quoteMint, r.treasury, ctx.programs.token)]), ...(table ? [table] : []),
      ...(c ? [c.launch, c.pool, c.policy, c.registry, c.inclusiveFeePolicy, holdingAddress(r.mint, r.creator, ctx.programs.token)] : [])]
    const addresses = [...new Set([...programRows.flatMap(([, a, p]) => [a, p]), ...roleList.map(([, a]) => a), ...extra])]
    const snap = await readAccounts(ctx.readers, ctx.genesis, addresses), A = snap.accounts
    const sections = [{ title: 'programs', rows: programRows.map(([role, a, p, elf]) => programRow(A, role, a, p, elf)) }]
    const govRows = []
    for (const [role, config, governance] of [['launch', d.launchConfig, d.launchGovernance], ['swap', d.swapConfig, d.swapGovernance]]) {
      if (!A.get(config) || !A.get(governance)) { govRows.push(`${role}: config or governance missing`); continue }
      const cfg = plain(cdecode(ctx, role, 'Config', A.get(config))), g = gview(ctx, role, cdecode(ctx, role, 'Governance', A.get(governance)).state)
      delete cfg.reserved
      govRows.push(`${role} config ${config}: ${JSON.stringify(cfg)}`, `${role} governance ${governance}: revision ${g.revision} gates creation=${g.gates.creation} trading=${g.gates.trading} (true=closed) commitment ${g.commitment} admin ${g.admin} treasury ${g.treasury} pendingAdmin ${JSON.stringify(g.pendingAdmin)}`)
    }
    sections.push({ title: 'configs and governance', rows: govRows })
    if (stack) {
      sections.push({ title: `our stack ${ctx.stack.id} (${ctx.stack.status})`, rows: [`quote marker ${ctx.quoteMint} ${A.get(ctx.quoteMint) ? 'present' : 'MISSING'} (internal)`, `upgrade authority ${ctx.stack.upgradeAuthority}`] })
      sections.push({ title: 'roles (lamports)', rows: roleList.map(([role, a]) => `${role.padEnd(14)} ${a} ${A.get(a) ? sol(A.get(a).lamports) : 'no account'}`) })
      sections.push({ title: 'journal', rows: ctx.journal.summary() })
      return { observedSlot: snap.slot, sections, statusOnly: true }
    }
    const auth = A.get(authorizationAddress(r.creator, ctx.programs.launch))
    sections.push({ title: 'creator authorization', rows: [auth ? JSON.stringify(plain(cdecode(ctx, 'launch', 'CreatorAuthorization', auth))) : `none for ${r.creator}`] })
    sections.push({ title: 'roles (lamports)', rows: roleList.map(([role, a]) => `${role.padEnd(14)} ${a} ${A.get(a) ? `${sol(A.get(a).lamports)} owner ${A.get(a).owner}${A.get(a).dataBase64 ? ` data ${Buffer.from(A.get(a).dataBase64, 'base64').length}B` : ''}` : 'no account'}`) })
    sections.push({ title: 'quote holdings', rows: [`creator ${amount(A.get(holdingAddress(ctx.quoteMint, r.creator, ctx.programs.token))) ?? 'no holding'}`, `treasury ${amount(A.get(holdingAddress(ctx.quoteMint, r.treasury, ctx.programs.token))) ?? 'no holding'}`] })
    sections.push({ title: 'canary', rows: [`lookup table ${table ?? 'not recorded'} ${table ? (A.get(table) ? 'present' : 'MISSING') : ''}`,
      ...(c ? [`mint ${r.mint} ${A.get(r.mint) ? 'created' : 'absent'}; policy ${A.get(c.policy) ? 'prepared' : 'absent'}; launch ${A.get(c.launch) ? 'created' : 'absent'}; pool ${A.get(c.pool) ? 'created' : 'absent'}`,
        ...(A.get(c.launch) ? (() => { const l = cdecode(ctx, 'launch', 'Launch', A.get(c.launch)); return [`creator fees accrued ${l.creator_fees_accrued} claimed ${l.creator_fees_claimed}`] })() : []),
        ...(A.get(c.pool) ? (() => { const p = cdecode(ctx, 'swap', 'Pool', A.get(c.pool)); return [`pool swaps ${p.swap_count} protocol_fees_quote ${p.protocol_fees_quote} quote_reserve ${p.quote_reserve}`] })() : [])] : []),
      `selected config ${r.selectedConfig ?? 'not chosen'}`] })
    sections.push({ title: 'journal', rows: ctx.journal.summary() })
    return { observedSlot: snap.slot, sections, statusOnly: true }
  },
}
