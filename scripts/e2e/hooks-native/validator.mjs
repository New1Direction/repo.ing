// A disposable native solana-test-validator loading one program set (scripts/e2e/hooks-native/program-sets.mjs): every
// ELF sha256-checked against its pin and loaded at its set's program ID under a synthetic upgrade authority, plus, for the
// legacy set, the production bridge and bridged-SOL mint from the public mainnet snapshot. The other genesis accounts are
// the owner-driver integration test's synthetic ones (tests/fixtures/hooklab-owner-local.mjs): a synthetic quote marker
// at the quote address (replaced by the real mint for the legacy set), holdings and lamports for the disposable roles.
// Loopback only; the genesis is checked not to be mainnet.
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Connection, PublicKey } from '@solana/web3.js'
import { markerMintRow, writeGenesis } from '../../../tests/fixtures/hooklab-owner-local.mjs'
import { MAINNET_GENESIS, VALIDATOR, freePortRange, sleep } from './common.mjs'

// own: our own stack (program-sets.mjs ownStackSet), loaded beside the set at its own IDs with its quote marker in
// genesis as hook-lab's deploy creates it (a Mint of our token program that nobody controls; tests/fixtures markerMintRow).
export async function startValidator({ root, roles, set, own = null, log }) {
  const elfs = set.elfs
  // rpc, rpc+1 (websocket), faucet, gossip, then the validator's dynamic ports, all loopback.
  const base = await freePortRange(48), rpcPort = base, faucetPort = base + 2, gossipPort = base + 3
  const ledger = path.join(root, 'ledger'), genesis = path.join(root, 'genesis'), upgrade = roles.upgrade.publicKey.toBase58()
  const extra = own ? [markerMintRow(own.stack, roles)] : []
  if (own?.selected) {
    // Agave 4.0.1 --upgradeable-program ... none creates Some(SystemProgram),
    // not Borsh None. The selected adapter correctly requires actual None.
    // Seed genuine loader-owned immutable program accounts at local genesis.
    const loader = 'BPFLoaderUpgradeab1e11111111111111111111111', id = own.selected.pin.program
    const dataAddress = PublicKey.findProgramAddressSync([new PublicKey(id).toBuffer()], new PublicKey(loader))[0]
    const program = Buffer.alloc(36); program.writeUInt32LE(2); dataAddress.toBuffer().copy(program, 4)
    const data = Buffer.alloc(45 + own.selected.bytes.length); data.writeUInt32LE(3); own.selected.bytes.copy(data, 45)
    const row = (pubkey, bytes, executable) => ({ pubkey, account: { lamports: 2_000_000_000, data: [bytes.toString('base64'), 'base64'], owner: loader, executable, rentEpoch: 0 } })
    extra.push(row(id, program, true), row(dataAddress.toBase58(), data, false))
  }
  writeGenesis(genesis, roles, { bridge: set.bridge, extra })
  const ownArgs = []
  if (own) {
    if (own.stack.upgradeAuthority !== upgrade) throw Error('our own stack must name the synthetic upgrade role as its upgrade authority')
    const dir = path.join(root, 'own-stack-elf'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const [role, bytes] of Object.entries(own.elfs)) { const file = path.join(dir, `${role}.so`); writeFileSync(file, bytes, { mode: 0o600 }); ownArgs.push('--upgradeable-program', own.stack.programs[role], file, upgrade) }
  }
  const args = ['--ledger', ledger, '--reset', '--quiet', '--bind-address', '127.0.0.1', '--rpc-port', String(rpcPort), '--faucet-port', String(faucetPort),
    '--gossip-port', String(gossipPort), '--dynamic-port-range', `${base + 8}-${base + 47}`, '--account-dir', genesis,
    // Keep every receipt of the run readable (the default retention pruned receipts within ~1,000 slots).
    '--limit-ledger-size', '200000000',
    ...Object.values(elfs).flatMap(elf => ['--upgradeable-program', elf.programId, elf.path, upgrade]), ...ownArgs]
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
    log?.(`validator ${url} genesis ${genesisHash} (pid ${child.pid}); set ${set.name}: ${Object.entries(elfs).map(([role, e]) => `${role} ${e.programId.slice(0, 4)}… ${e.sha256.slice(0, 12)}`).join(', ')}${set.bridge ? `; bridge snapshot slot ${set.bridge.slot}` : ''}${own ? `; own stack ${own.name}: ${Object.entries(own.stack.programs).map(([role, id]) => `${role} ${id.slice(0, 4)}… ${own.elfSha256[role].slice(0, 12)}`).join(', ')}, marker ${own.quoteMint.slice(0, 4)}…` : ''}`)
    return { url, url2: `http://localhost:${rpcPort}`, rpcPort, faucetPort, connection, genesisHash, pid: child.pid, stop, elfs }
  } catch (error) { await stop(); throw error }
}
