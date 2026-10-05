// A minimal fake PostgreSQL server for tests of how the pg client behaves when a connection is lost: trust
// authentication and the simple query protocol only. Every statement answers one row { v: '1' }, except one containing
// pg_sleep, which never answers (a statement in flight). It is not PostgreSQL and checks no SQL.
import net from 'node:net'

const message = (type, body = Buffer.alloc(0)) => {
  const out = Buffer.alloc(5 + body.length)
  out.write(type, 0, 'latin1'); out.writeInt32BE(4 + body.length, 1); body.copy(out, 5)
  return out
}
const cstring = text => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])])
const int32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const int16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b }
const READY = message('Z', Buffer.from('I'))
// What pg_terminate_backend and a server shutdown send before the socket closes.
const TERMINATED = message('E', Buffer.concat([cstring('SFATAL'), cstring('VFATAL'), cstring('C57P01'),
  cstring('Mterminating connection due to administrator command'), Buffer.from([0])]))
const ONE_ROW = Buffer.concat([
  message('T', Buffer.concat([int16(1), cstring('v'), int32(0), int16(0), int32(23), int16(4), int32(-1), int16(0)])),
  message('D', Buffer.concat([int16(1), int32(1), Buffer.from('1')])),
  message('C', cstring('SELECT 1')), READY])

export async function startFakePostgres() {
  const sockets = new Set(), statements = []
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let buffer = Buffer.alloc(0), started = false
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return
          const length = buffer.readInt32BE(0)
          if (buffer.length < length) return
          buffer = buffer.subarray(length); started = true
          socket.write(Buffer.concat([message('R', int32(0)), message('K', Buffer.concat([int32(4242), int32(1)])), READY]))
          continue
        }
        if (buffer.length < 5) return
        const length = buffer.readInt32BE(1)
        if (buffer.length < 1 + length) return
        const type = String.fromCharCode(buffer[0]), body = buffer.subarray(5, 1 + length)
        buffer = buffer.subarray(1 + length)
        if (type === 'X') { socket.end(); return }
        if (type !== 'Q') continue
        const sql = body.toString('utf8', 0, body.length - 1)
        statements.push(sql)
        if (!/pg_sleep/.test(sql)) socket.write(ONE_ROW)
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `postgres://test@127.0.0.1:${server.address().port}/test`, statements,
    // The server ends every connection, as a restart or a failover does.
    terminateAll() { for (const socket of sockets) { socket.write(TERMINATED); socket.end() } },
    // A network cut: no message, the sockets just go.
    cutAll() { for (const socket of sockets) socket.destroy() },
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve) }),
  }
}
