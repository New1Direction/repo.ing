// Child processes of the stack: each in its own process group (so a dev server's workers die with it), logged to a file,
// with output lines kept in memory for waits and the control API, and stopped with TERM then KILL.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { sleep } from './common.mjs'

export function startProcess(name, command, args, { cwd, env, logFile, stdin = 'ignore' }) {
  const out = createWriteStream(logFile, { flags: 'a', mode: 0o600 })
  const child = spawn(command, args, { cwd, env, stdio: [stdin, 'pipe', 'pipe'], detached: true })
  const lines = []
  let partial = ''
  const take = chunk => {
    out.write(chunk)
    const text = partial + chunk.toString('utf8'), parts = text.split('\n')
    partial = parts.pop()
    for (const line of parts) { lines.push(line); if (lines.length > 5000) lines.shift() }
  }
  child.stdout.on('data', take); child.stderr.on('data', take)
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', error => { take(Buffer.from(`${name}: ${error.message}\n`)); resolve({ code: 1, signal: null }) })
  })
  const closed = new Promise(resolve => child.once('close', resolve))
  const alive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null
  let stopping
  function stop() {
    return stopping ??= (async () => {
      // The CLI may already have exited while its worker group is still alive.
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
      for (let i = 0; i < 50 && alive(); i++) await sleep(200)
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* group gone */ }
      await Promise.race([closed, sleep(2000)])
      if (alive()) throw Error(`${name} did not stop`)
      if (!out.writableFinished) await new Promise(resolve => out.end(resolve))
    })()
  }
  return { name, child, pid: child.pid, lines, exited, alive, stop, write: text => child.stdin.write(text) }
}
