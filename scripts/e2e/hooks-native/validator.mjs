// A disposable native solana-test-validator with the CANDIDATE native-SOL launch and swap ELFs (hook-lab e357fdf,
// sha256-checked against src/hooklab-native-pins.mjs NATIVE_ELF) and the unchanged gate and token ELFs (checked against
// the owner driver's pins), all at their production program ids under a synthetic upgrade authority. The genesis
// accounts are the owner-driver integration test's synthetic ones (tests/fixtures/hooklab-owner-local.mjs): a synthetic
// quote mint at the production quote address, holdings and lamports for the disposable roles. Loopback only; the genesis
// is checked not to be mainnet.
import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync } from 'node:fs'
import path from 'node:path'
import { Connection } from '@solana/web3.js'
import { NATIVE_ELF } from '../../../src/hooklab-native-pins.mjs'
import { ELF } from '../../../src/hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS } from '../../../src/hooklab-owner-driver/pins.mjs'
import { writeGenesis } from '../../../tests/fixtures/hooklab-owner-local.mjs'
import { MAINNET_GENESIS, NATIVE_ELF_DIR, VALIDATOR, freePortRange, sha256, sleep } from './common.mjs'

const FILES = { launch: 'bordrless_launch.so', swap: 'bordrless_swap.so', gate: 'hook_max_wallet.so', token: 'bordrless_token.so' }
const PINS = { launch: NATIVE_ELF.launch.sha256, swap: NATIVE_ELF.swap.sha256, gate: ELF.gate.sha256, token: ELF.token.sha256 }

/** Refuses unless every ELF in the directory is the exact pinned build. Returns the per-role path and sha256. */
export function checkedElfs(dir = NATIVE_ELF_DIR) {
  return Object.fromEntries(Object.entries(FILES).map(([role, file]) => {
    const where = path.join(dir, file), digest = sha256(readFileSync(where))
    if (digest !== PINS[role]) throw Error(`${role} ELF ${where} has sha256 ${digest}, not the pinned ${PINS[role]}`)
    return [role, { path: where, sha256: digest }]
  }))
}

export async function startValidator({ root, roles, log }) {
  const elfs = checkedElfs()
  // rpc, rpc+1 (websocket), faucet, gossip, then the validator's dynamic ports, all loopback.
  const base = await freePortRange(48), rpcPort = base, faucetPort = base + 2, gossipPort = base + 3
  const ledger = path.join(root, 'ledger'), genesis = path.join(root, 'genesis'), upgrade = roles.upgrade.publicKey.toBase58()
  writeGenesis(genesis, roles)
  const args = ['--ledger', ledger, '--reset', '--quiet', '--bind-address', '127.0.0.1', '--rpc-port', String(rpcPort), '--faucet-port', String(faucetPort),
    '--gossip-port', String(gossipPort), '--dynamic-port-range', `${base + 8}-${base + 47}`, '--account-dir', genesis,
    // Keep every receipt of the run readable (the default retention pruned receipts within ~1,000 slots).
    '--limit-ledger-size', '200000000',
    ...Object.keys(FILES).flatMap(role => ['--upgradeable-program', PROGRAMS[role], elfs[role].path, upgrade])]
  const output = createWriteStream(path.join(root, 'logs', 'validator.log'))
  const child = spawn(VALIDATOR, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false })
  child.stdout.pipe(output); child.stderr.pipe(output)
  const url = `http://127.0.0.1:${rpcPort}`, connection = new Connection(url, { commitment: 'finalized' })
  async function stop() {
    if (child.exitCode !== null || child.signalCode) return
    child.kill('SIGTERM')
    for (let i = 0; i < 50 && child.exitCode === null && !child.signalCode; i++) await sleep(200)
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
  }
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode !== null) throw Error(`solana-test-validator exited ${child.exitCode}; see ${path.join(root, 'logs', 'validator.log')}`)
      try { if (await connection.getSlot('finalized') > 2) break } catch { /* still starting */ }
      if (i > 480) throw Error('The validator did not finalize a slot within 120 s')
      await sleep(250)
    }
    const genesisHash = await connection.getGenesisHash()
    if (genesisHash === MAINNET_GENESIS) throw Error('Refusing: the local validator reports the mainnet genesis')
    log?.(`validator ${url} genesis ${genesisHash} (pid ${child.pid}); programs: ${Object.entries(elfs).map(([role, e]) => `${role} ${e.sha256.slice(0, 12)}`).join(', ')}`)
    return { url, url2: `http://localhost:${rpcPort}`, rpcPort, faucetPort, connection, genesisHash, pid: child.pid, stop, elfs }
  } catch (error) { await stop(); throw error }
}
