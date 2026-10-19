// Read-only preflight for the native-SOL upgrade (hook-lab reviews S-6 and L-1), the website's port of hook-lab
// scripts/verify_native_preflight.py at e357fdf. Before the reviewed native ELFs go live no account may already carry a
// native flag: no swap Pool with byte 351 set (319 without a hook), no Launch with byte 560 set (528 without), and launch
// Config bytes 186..249 (186 is the switch) all zero. Today's programs never write those bytes, so a hit means the
// accounts are not what the upgrade assumes. Reads only; no keys, signing or sending.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_FLAGS } from './hooklab-native-pins.mjs'
import { PROGRAMS, derivedAddresses } from './hooklab-owner-driver/pins.mjs'

const disc = name => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8)
const LAYOUTS = Object.freeze({
  pool: { name: 'Pool', length: 411, tagAt: 171, some: NATIVE_FLAGS.pool, none: NATIVE_FLAGS.poolWithoutHook },
  launch: { name: 'Launch', length: 565, tagAt: 498, some: NATIVE_FLAGS.launch, none: NATIVE_FLAGS.launchWithoutHook },
})
const CONFIG_BYTES = 250, SWITCH = NATIVE_FLAGS.configNativeLaunches
const owned = (account, program, layout) => account.owner === program && account.data.length === layout.length && account.data.subarray(0, 8).equals(disc(layout.name))

// accounts: [{ pubkey, owner, data: Buffer }]. The same report as the Python check, field for field.
export function checkNativePreflight(accounts, { programs = PROGRAMS } = {}) {
  const report = { schema: 'hook-lab/native-preflight/1', pools: 0, launches: 0, nativePools: [], nativeLaunches: [], malformed: [] }, configs = []
  for (const account of accounts) {
    if (account.owner === programs.launch && account.data.length === CONFIG_BYTES && account.data.subarray(0, 8).equals(disc('Config'))) { configs.push(account); continue }
    const kind = owned(account, programs.swap, LAYOUTS.pool) ? 'pool' : owned(account, programs.launch, LAYOUTS.launch) ? 'launch' : null
    if (!kind) continue
    const layout = LAYOUTS[kind], tag = account.data[layout.tagAt]
    report[kind === 'pool' ? 'pools' : 'launches'] += 1
    if (tag !== 0 && tag !== 1) report.malformed.push(account.pubkey)
    else if (account.data[tag === 1 ? layout.some : layout.none] !== 0) report[kind === 'pool' ? 'nativePools' : 'nativeLaunches'].push(account.pubkey)
  }
  const reasons = []
  if (configs.length !== 1) { report.launchConfig = null; reasons.push(`launch config: expected exactly one, found ${configs.length}`) }
  else {
    const [{ pubkey, data }] = configs, nonzero = [...data.subarray(SWITCH)].flatMap((b, i) => b ? [SWITCH + i] : [])
    report.launchConfig = { pubkey, reservedNonzero: nonzero }
    if (data[SWITCH]) reasons.push(`launch config byte ${SWITCH} (the native-launches switch) is set`)
    const others = nonzero.filter(o => o !== SWITCH)
    if (others.length) reasons.push(`launch config reserved bytes are not zero at [${others.join(', ')}]`)
  }
  reasons.push(...report.nativePools.map(k => `native pool ${k}`), ...report.nativeLaunches.map(k => `native launch ${k}`), ...report.malformed.map(k => `malformed option tag ${k}`))
  return { ...report, reasons, ok: reasons.length === 0 }
}

// Every Pool of the swap program, every Launch of the launch program and the launch Config, from two providers at
// finalized; they must reach the same report (a trade or launch between the two reads changes it: run again).
export async function scanNativePreflight(readers, { programs = PROGRAMS } = {}) {
  const read = async ({ connection }) => {
    const all = async (program, layout) => (await connection.getProgramAccounts(new PublicKey(program), { commitment: 'finalized',
      filters: [{ dataSize: layout.length }, { memcmp: { offset: 0, bytes: bs58.encode(disc(layout.name)) } }] }))
      .map(({ pubkey, account }) => ({ pubkey: pubkey.toBase58(), owner: account.owner.toBase58(), data: Buffer.from(account.data) }))
    const config = derivedAddresses(programs).launchConfig, info = await connection.getAccountInfo(new PublicKey(config), 'finalized')
    const accounts = [...await all(programs.swap, LAYOUTS.pool), ...await all(programs.launch, LAYOUTS.launch), ...(info ? [{ pubkey: config, owner: info.owner.toBase58(), data: Buffer.from(info.data) }] : [])]
    const report = checkNativePreflight(accounts, { programs })
    return { ...report, nativePools: [...report.nativePools].sort(), nativeLaunches: [...report.nativeLaunches].sort(), malformed: [...report.malformed].sort() }
  }
  const reports = await Promise.all(readers.map(read))
  if (!isDeepStrictEqual(reports[0], reports[1])) throw Error('The two providers disagree on the preflight accounts (a trade or launch may have landed between the reads); run it again')
  return { ...reports[0], providers: readers.map(r => r.provider), programs: { swap: programs.swap, launch: programs.launch } }
}
