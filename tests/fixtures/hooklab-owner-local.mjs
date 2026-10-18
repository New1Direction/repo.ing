// Disposable native solana-test-validator for the owner-driver integration test.
// Programs load at their mainnet IDs from the pinned ELFs with a SYNTHETIC upgrade authority;
// every role is a freshly generated synthetic keypair. Never touches production custody.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { loadArtifacts, ELF } from '../../src/hooklab-owner-driver/artifacts.mjs'
import { idlInstruction } from '../../src/hooklab-owner-driver/instructions.mjs'
import { PROGRAMS, QUOTE_MINT, LOADER, SYSTEM, MAINNET_GENESIS, pda, pk, kb, holdingAddress, sha256, derivedAddresses } from '../../src/hooklab-owner-driver/pins.mjs'

export const ELF_DIR = process.env.HOOKLAB_OWNER_ELF_DIR ?? '/Users/clubpenguin/Documents/ChatGPT/hooks-local-state/rebuilt-inclusive/elf'
export const VALIDATOR = process.env.HOOKLAB_OWNER_VALIDATOR ?? '/opt/homebrew/bin/solana-test-validator'
const ELF_FILES = { launch: 'bordrless_launch.so', swap: 'bordrless_swap.so', gate: 'hook_max_wallet.so', token: 'bordrless_token.so' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.unref(); server.on('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})
async function portRange(count) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000)
    const ok = await Promise.all(Array.from({ length: count }, (_, i) => new Promise(resolve => {
      const s = createServer(); s.once('error', () => resolve(false)); s.listen(base + i, '127.0.0.1', () => s.close(() => resolve(true)))
    })))
    if (ok.every(Boolean)) return base
  }
  throw Error('No free local port range')
}
export function syntheticRoles() {
  return Object.fromEntries(['admin', 'guardian', 'treasury', 'upgrade', 'payer', 'creator', 'mint', 'selectedConfig'].map(role => [role, Keypair.generate()]))
}
export function writeKeyFiles(dir, roles) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return Object.fromEntries(Object.entries(roles).map(([role, key]) => {
    const file = path.join(dir, `${role}.synthetic.json`); writeFileSync(file, JSON.stringify([...key.secretKey]), { mode: 0o600 }); return [role, file]
  }))
}
function tokenAccount(name, value, size) {
  const { coders } = loadArtifacts()
  const bytes = Buffer.concat([Buffer.from(sha256(`account:${name}`), 'hex').subarray(0, 8), coders.token.types.encode(name, value)])
  const out = Buffer.alloc(size); bytes.copy(out); return out
}
const account = (pubkey, { lamports, data = Buffer.alloc(0), owner = SYSTEM, executable = false }) => ({ pubkey, account: { lamports, data: [data.toString('base64'), 'base64'], owner, executable, rentEpoch: 0 } })
/** Synthetic genesis: quote mint at the production quote address (no bridge backing), holdings, payer/upgrade lamports. */
export function writeGenesis(dir, roles, { creatorQuote = '10000000000' } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const amount = new BN('1000000000000000')
  const mint = tokenAccount('Mint', { version: 1, decimals: 9, supply: amount, max_supply: amount, mint_authority: null, freeze_authority: null, hook_authority: null,
    metadata_authority: null, hook_program: null, hook_flags: 0, name: 'LOCAL synthetic quote', symbol: 'LOCALQ', uri: '', created_at: new BN(0),
    creator: roles.payer.publicKey, hook_signer_bump: 0, reserved: Array(31).fill(0) }, 519)
  const holding = (owner, value) => {
    const address = holdingAddress(QUOTE_MINT, owner), bump = PublicKey.findProgramAddressSync([Buffer.from('holding'), kb(QUOTE_MINT), kb(owner)], pk(PROGRAMS.token))[1]
    return account(address, { lamports: 10000000, owner: PROGRAMS.token, data: tokenAccount('Holding', { version: 1, bump, mint: pk(QUOTE_MINT), owner: pk(owner), amount: new BN(value),
      delegate: null, delegated_amount: new BN(0), frozen: false, hook_data: Array(64).fill(0), reserved: Array(16).fill(0) }, 204) })
  }
  const rows = [account(QUOTE_MINT, { lamports: 10000000, owner: PROGRAMS.token, data: mint }),
    holding(roles.creator.publicKey.toBase58(), creatorQuote), holding(roles.treasury.publicKey.toBase58(), '0'),
    account(roles.payer.publicKey.toBase58(), { lamports: 1000000000000 }), account(roles.upgrade.publicKey.toBase58(), { lamports: 100000000000 })]
  rows.forEach((row, i) => writeFileSync(path.join(dir, `account-${i}.json`), JSON.stringify(row)))
}
export async function startValidator(root, roles) {
  for (const [role, file] of Object.entries(ELF_FILES)) if (sha256(readFileSync(path.join(ELF_DIR, file))) !== ELF[role].sha256) throw Error(`Pinned ${role} ELF differs`)
  const base = await portRange(4), rpc = base, faucet = base + 2, gossip = base + 3
  const ledger = path.join(root, 'ledger'), genesis = path.join(root, 'genesis'), upgrade = roles.upgrade.publicKey.toBase58()
  writeGenesis(genesis, roles)
  const args = ['--ledger', ledger, '--reset', '--quiet', '--bind-address', '127.0.0.1', '--rpc-port', String(rpc), '--faucet-port', String(faucet), '--gossip-port', String(gossip),
    '--limit-ledger-size', '10000', '--account-dir', genesis,
    ...Object.entries(ELF_FILES).flatMap(([role, file]) => ['--upgradeable-program', PROGRAMS[role], path.join(ELF_DIR, file), upgrade])]
  const child = spawn(VALIDATOR, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false })
  let stderr = ''; child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
  const url = `http://127.0.0.1:${rpc}`, url2 = `http://localhost:${rpc}`, connection = new Connection(url, { commitment: 'finalized' })
  const stop = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(200); if (child.exitCode === null) child.kill('SIGKILL') } }
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode !== null) throw Error(`solana-test-validator exited ${child.exitCode}: ${stderr}`)
      try { if (await connection.getSlot('finalized') > 2) break } catch { /* starting */ }
      if (i > 240) throw Error('Validator did not finalize a slot within 120 s')
      await sleep(500)
    }
    const genesisHash = await connection.getGenesisHash()
    if (genesisHash === MAINNET_GENESIS) throw Error('Refusing: local validator reports the mainnet genesis')
    return { url, url2, connection, genesisHash, stop, ledger }
  } catch (error) { await stop(); throw error }
}
export async function sendLocal(connection, instructions, signers) {
  const latest = await connection.getLatestBlockhash('finalized')
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: latest.blockhash, instructions }).compileToV0Message())
  tx.sign(signers)
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 0, preflightCommitment: 'finalized' })
  const result = await connection.confirmTransaction({ signature, ...latest }, 'finalized')
  if (result.value.err) throw Error(`Local bootstrap failed: ${JSON.stringify(result.value.err)}`)
  return signature
}
/** Mirror the mainnet starting state: both configs paused, governance revision 0, zero fees and shares. */
export async function bootstrapConfigs(connection, roles, genesisHash) {
  const d = derivedAddresses(), k = role => roles[role].publicKey, a = role => roles[role].publicKey.toBase58()
  const launchArgs = { admin: k('admin'), treasury: k('treasury'), quote_mint: pk(QUOTE_MINT), launch_fee_lamports: new BN(0), lp_fee_bps: 0, max_creator_fee_bps: 0,
    sniper_window_secs: new BN(0), sniper_start_bps: 0, curve_bps: 7500, supply: new BN('1000000000000000'), decimals: 6, min_virtual_quote: new BN(1000000000), max_virtual_quote: new BN(1000000000),
    paused: true, rule_bounds: { max_holder_fee_bps: 0, max_burn_bps: 0, max_rules_fee_bps: 0, min_max_wallet_bps: 1, max_max_wallet_bps: 1, max_creator_lock_secs: 0, max_early_window_secs: 0, max_early_lock_secs: 0 } }
  const swapArgs = { admin: k('admin'), protocol_fee_bps: 0, fee_collector: k('treasury'), treasury: k('treasury'), pool_creation_fee_lamports: new BN(0), paused: true, launch_protocol_share_bps: 0 }
  const custody = [...createHash('sha256').update('synthetic owner-driver local custody').digest()]
  for (const [role, args] of [['launch', launchArgs], ['swap', swapArgs]]) {
    const program = PROGRAMS[role], common = { program, event_authority: pda(program, '__event_authority'), program_data: pda(LOADER, kb(program)), system_program: SYSTEM }
    await sendLocal(connection, [idlInstruction(role, 'init_config', { args }, { ...common, authority: a('upgrade'), config: role === 'launch' ? d.launchConfig : d.swapConfig })], [roles.upgrade])
    await sendLocal(connection, [idlInstruction(role, 'init_governance', { args: { genesis: [...pk(genesisHash).toBuffer()], guardian: k('guardian'), custody_digest: custody } },
      { ...common, admin: a('admin'), payer: a('payer'), config: role === 'launch' ? d.launchConfig : d.swapConfig, governance: role === 'launch' ? d.launchGovernance : d.swapGovernance })], [roles.payer, roles.admin])
  }
}
export function localConfig(roles, overrides = {}) {
  const a = role => roles[role].publicKey.toBase58(), yes = value => ({ value, approved: true })
  return { schema: 'repoing/hooklab-owner-config/1', network: 'local-test', note: 'synthetic local validator only',
    roles: Object.fromEntries(['admin', 'guardian', 'treasury', 'upgrade', 'payer', 'creator'].map(r => [r, a(r)])),
    decisions: { creatorFeeBps: yes(100), maxRulesFeeBps: yes(100), launchProtocolShareBps: yes(2500), protocolFeeBps: yes(0), capBps: yes(200),
      grant: yes({ creator: a('creator'), maxLaunches: '1', expirySlots: '100000' }), selectedConfig: yes(a('selectedConfig')), canaryMint: yes(a('mint')),
      canaryLaunch: yes({ name: 'Local canary', symbol: 'LCANARY', uri: '', label: 'private-canary', virtualQuote: '1000000000', maxRentLamports: '60000000' }),
      canaryBuy: yes({ amountInRaw: '1000200', slippageBps: 50, maxPriceImpactBps: 1000 }), canarySell: yes({ amountInRaw: 'all', slippageBps: 50, maxPriceImpactBps: 1000 }),
      fund: yes({ creatorLamports: '2000000000', adminLamports: '1000000000', treasuryLamports: '1000000000' }), canaryWrapLamports: yes('0'), collectRoute: yes('quote'),
      lookupTable: yes(null), computeUnitPriceMicroLamports: yes('0'), ...overrides } }
}
export const cleanup = root => rmSync(root, { recursive: true, force: true })
