// The owner agent's local-acceptance mode: a disposable admin key FILE against a local validator, for the e2e suite.
// It must refuse a mainnet genesis, any non-loopback origin or RPC, the production admin, and a missing state directory.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypair } from '@solana/web3.js'
import { localAgentSettings } from '../src/hooklab-owner-agent-local.mjs'
import { MAINNET_GENESIS } from '../src/hooklab-owner-driver/pins.mjs'

const LOCAL_GENESIS = Keypair.generate().publicKey.toBase58()
const MAINNET_ADMIN = 'DVdd2snkU94Q9SUbXe8Xgr5AQ1cnxSoy3ebQ9mCTj8S5'
const disposable = Keypair.generate()
const keyText = JSON.stringify([...disposable.secretKey])
const reader = genesis => ({ getGenesisHash: async () => genesis })
const base = () => ({ origin: 'https://localhost:4443', rpcs: ['https://127.0.0.1:4444/', 'https://127.0.0.1:4445/'],
  connections: [reader(LOCAL_GENESIS), reader(LOCAL_GENESIS)], adminKeyText: keyText, stateDir: '/tmp/hooklab-owner-agent-local-test', mainnetAdmin: MAINNET_ADMIN, expectedGenesis: LOCAL_GENESIS })

test('local acceptance takes the admin from the disposable key file and pins the local genesis', async () => {
  const settings = await localAgentSettings(base())
  assert.deepEqual(settings, { adminAddress: disposable.publicKey.toBase58(), genesisHash: LOCAL_GENESIS, stateDir: '/tmp/hooklab-owner-agent-local-test' })
})

test('local acceptance refuses a mainnet genesis on either provider', async () => {
  await assert.rejects(localAgentSettings({ ...base(), connections: [reader(MAINNET_GENESIS), reader(MAINNET_GENESIS)] }), /refuses the mainnet genesis/)
  await assert.rejects(localAgentSettings({ ...base(), connections: [reader(LOCAL_GENESIS), reader(MAINNET_GENESIS)] }), /different genesis/)
})

test('local acceptance signs only on the pinned local genesis: never devnet, testnet or another local validator', async () => {
  const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', TESTNET = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'
  await assert.rejects(localAgentSettings({ ...base(), expectedGenesis: undefined }), /must be pinned/)
  await assert.rejects(localAgentSettings({ ...base(), expectedGenesis: DEVNET, connections: [reader(DEVNET), reader(DEVNET)] }), /public cluster/)
  await assert.rejects(localAgentSettings({ ...base(), expectedGenesis: MAINNET_GENESIS, connections: [reader(MAINNET_GENESIS), reader(MAINNET_GENESIS)] }), /public cluster/)
  await assert.rejects(localAgentSettings({ ...base(), connections: [reader(DEVNET), reader(DEVNET)] }), /public cluster genesis/)
  await assert.rejects(localAgentSettings({ ...base(), connections: [reader(TESTNET), reader(TESTNET)] }), /public cluster genesis/)
  const other = Keypair.generate().publicKey.toBase58()
  await assert.rejects(localAgentSettings({ ...base(), connections: [reader(other), reader(other)] }), /pinned local genesis/)
})

test('local acceptance refuses non-loopback origins and RPCs', async () => {
  await assert.rejects(localAgentSettings({ ...base(), origin: 'https://repo.ing' }), /HTTPS loopback origin/)
  await assert.rejects(localAgentSettings({ ...base(), origin: 'http://localhost:4443' }), /HTTPS loopback origin/)
  await assert.rejects(localAgentSettings({ ...base(), rpcs: ['https://api.mainnet-beta.solana.com', 'https://127.0.0.1:4445/'] }), /loopback RPC/)
})

test('local acceptance refuses the production admin key and needs its own state directory', async () => {
  await assert.rejects(localAgentSettings({ ...base(), mainnetAdmin: disposable.publicKey.toBase58() }), /production admin/)
  await assert.rejects(localAgentSettings({ ...base(), stateDir: undefined }), /state directory/)
  await assert.rejects(localAgentSettings({ ...base(), stateDir: 'relative/dir' }), /state directory/)
  await assert.rejects(localAgentSettings({ ...base(), adminKeyText: '[1,2,3]' }), /64-byte keypair/)
})

// The real agent script, pointed at a loopback RPC that claims the mainnet genesis: it must stop before reading the
// queue, signing or creating anything.
test('the agent script in --local-acceptance mode exits before doing anything when the RPC reports mainnet', async () => {
  const calls = []
  const rpc = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => {
      const { id, method } = JSON.parse(body); calls.push(method)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: method === 'getGenesisHash' ? MAINNET_GENESIS : null }))
    })
  })
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve))
  const port = rpc.address().port, dir = mkdtempSync(path.join(tmpdir(), 'owner-agent-local-')), keyFile = path.join(dir, 'admin.json'), stateDir = path.join(dir, 'state')
  writeFileSync(keyFile, keyText, { mode: 0o600 })
  try {
    const child = spawn(process.execPath, ['scripts/hooklab-owner-agent.mjs', '--local-acceptance', '--genesis', LOCAL_GENESIS, '--state-dir', stateDir, '--admin-key', keyFile,
      '--origin', 'https://localhost:9', '--rpc', `http://127.0.0.1:${port}`, '--rpc2', `http://localhost:${port}`],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { PATH: process.env.PATH, HOME: dir, HOOK_OWNER_APPROVAL_TOKEN: 'x'.repeat(40) }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
    const code = await new Promise(resolve => child.on('exit', resolve))
    assert.equal(code, 2, stderr)
    assert.match(stderr, /refuses the mainnet genesis/)
    assert.deepEqual([...new Set(calls)], ['getGenesisHash'], 'only the genesis was read')
    assert.equal(existsSync(stateDir), false, 'no ledger or table journal was written')
    assert.deepEqual(readdirSync(dir).sort(), ['admin.json'], 'nothing written under HOME either')
  } finally { rpc.close(); rmSync(dir, { recursive: true, force: true }) }
})
