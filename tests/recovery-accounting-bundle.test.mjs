import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'

const exec = promisify(execFile)
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

test('accounting bundle dispatches genesis through native fetch and sanitizes failures before DB access', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'accounting-bundle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  await exec(process.execPath, ['scripts/build-recovery-accounting.mjs', directory])
  const runner = join(directory, 'scripts/accounting.mjs')
  const metadata = JSON.parse(readFileSync(join(directory, 'build.json'), 'utf8'))
  const cleanEnv = { PATH: process.env.PATH, HOME: directory, ACCOUNTING_CUSTODY_SHA256: metadata.custodySha256 }
  const validation = await exec(process.execPath, [runner, '--validate'], { env: cleanEnv })
  assert.deepEqual(JSON.parse(validation.stdout), { lane: 'accounting', status: 'VALIDATED_NO_EXECUTION', networkCalls: 0, databaseWrites: 0 })
  let databaseConnections = 0
  const db = createTcpServer(socket => { databaseConnections++; socket.destroy() })
  await new Promise((resolve, reject) => db.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => db.close(resolve)))
  for (const mode of ['wrong-mainnet', 'provider-failure']) await t.test(mode, async () => {
    const sentinel = 'DO_NOT_EMIT_ACCOUNTING_CREDENTIAL_OR_BODY'
    const methods = []
    const providers = []
    try {
      for (const [i, host] of ['127.0.0.1', '::1'].entries()) {
        const server = createServer(async (request, response) => {
          const chunks = []
          for await (const chunk of request) chunks.push(chunk)
          const rpc = JSON.parse(Buffer.concat(chunks))
          methods.push(rpc.method)
          response.setHeader('Content-Type', 'application/json')
          if (mode === 'provider-failure') {
            response.writeHead(503).end(JSON.stringify({ secret: sentinel }))
          } else response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: i === 0 ? genesis : 'not-mainnet' }))
        })
        await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve))
        providers.push({ server, url: `http://${i === 0 ? host : `[${host}]`}:${server.address().port}/?token=${sentinel}` })
      }
      let result
      try {
        await exec(process.execPath, [runner], { timeout: 10000, maxBuffer: 1024 * 1024, env: { ...cleanEnv,
          RECOVERY_FEE_DATABASE_URL: `postgresql://repoing_fee_indexer@127.0.0.1:${db.address().port}/repoing_operational?sslmode=verify-full`,
          SOLANA_RPC_URL: providers[0].url, SOLANA_VERIFICATION_RPC_URL: providers[1].url } })
        assert.fail('Invalid genesis or provider failure must stop accounting')
      } catch (error) { result = error }
      // Bundled bindings must not corrupt native-fetch error/stack handling.
      assert.equal(methods.length, 2, result.stderr?.includes('__filename is not defined') ? 'BUNDLE_FILENAME_UNDEFINED' : 'GENESIS_REQUESTS_MISSING')
      assert.deepEqual(methods, ['getGenesisHash', 'getGenesisHash'])
      assert.equal(result.code, 1)
      assert.deepEqual(JSON.parse(result.stdout), { lane: 'accounting', status: 'CYCLE_FAILED' })
      assert.equal(databaseConnections, 0)
      assert(!`${result.stdout}${result.stderr}`.includes(sentinel))
      assert(!`${result.stdout}${result.stderr}`.includes('http://'))
      assert(!result.stderr.includes('__filename is not defined'), 'BUNDLE_FILENAME_UNDEFINED')
    } finally {
      await Promise.all(providers.map(({ server }) => new Promise(resolve => {
        server.closeAllConnections(); server.close(resolve)
      })))
    }
  })
})
