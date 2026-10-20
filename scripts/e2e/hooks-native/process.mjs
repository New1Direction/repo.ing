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
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  const alive = () => child.exitCode === null && child.signalCode === null
  async function stop() {
    if (!alive()) return
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    for (let i = 0; i < 50 && alive(); i++) await sleep(200)
    if (alive()) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
    await Promise.race([exited, sleep(2000)])
    out.end()
  }
  return { name, child, pid: child.pid, lines, exited, alive, stop, write: text => child.stdin.write(text) }
}
