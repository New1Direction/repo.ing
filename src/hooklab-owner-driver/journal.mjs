// One-send journal. Each message sha256 may be claimed exactly once (O_EXCL), and its signed
// wire is persisted before the single send. A later run never resends a claimed message.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const TERMINAL = Object.freeze(new Set(['finalized-success', 'finalized-failure', 'expired-unlanded', 'preflight-rejected', 'abandoned-unsigned']))
const check = (ok, message) => { if (!ok) throw Error(message) }

export function openJournal(root) {
  const dir = path.join(root, 'journal')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = sha => { check(/^[a-f0-9]{64}$/.test(sha), 'Journal key must be a message sha256'); return path.join(dir, `${sha}.json`) }
  const read = sha => JSON.parse(readFileSync(file(sha), 'utf8'))
  const entries = () => readdirSync(dir).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => JSON.parse(readFileSync(path.join(dir, f), 'utf8')))
  return Object.freeze({
    dir,
    /** Exclusive claim; throws if this message was ever claimed before (one-send). */
    claim(entry) {
      try { writeFileSync(file(entry.messageSha256), JSON.stringify({ ...entry, status: 'claimed', claimedAt: new Date().toISOString(), history: [] }, null, 2), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code === 'EEXIST') throw Error(`Message ${entry.messageSha256} was already claimed; one-send journal refuses a second send`); throw error }
    },
    update(sha, patch) {
      const current = read(sha), next = { ...current, ...patch, history: [...current.history, { at: new Date().toISOString(), status: patch.status ?? current.status }] }
      writeFileSync(`${file(sha)}.next`, JSON.stringify(next, null, 2), { mode: 0o600 }); renameSync(`${file(sha)}.next`, file(sha))
      return next
    },
    get(sha) { try { return read(sha) } catch (error) { if (error.code === 'ENOENT') return null; throw error } },
    pending(stage) { return entries().filter(e => e.stage === stage && !TERMINAL.has(e.status)) },
    /** Every attempt that used this reviewed plan (directly or through a refreshed blockhash). */
    byReviewed(sha) { return entries().filter(e => e.messageSha256 === sha || e.reviewedMessageSha256 === sha) },
    lastSuccess(stage) { return entries().filter(e => e.stage === stage && e.status === 'finalized-success' && e.postconditions === 'verified').sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0))[0] ?? null },
    /** Exclusive per-stage execute lock; a lock left by a dead process is taken over. */
    lock(stage) {
      check(/^[a-z-]+$/.test(stage), 'Invalid stage for lock')
      const file = path.join(dir, `${stage}.lock`)
      const take = () => writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
      try { take() } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const holder = JSON.parse(readFileSync(file, 'utf8'))
        let alive = true
        try { process.kill(holder.pid, 0) } catch (e) { alive = e.code === 'EPERM' }
        if (alive) throw Error(`Another execute of ${stage} holds ${file} (pid ${holder.pid} since ${holder.at}); refusing concurrent sends`)
        rmSync(file, { force: true }); take()
      }
      return () => rmSync(file, { force: true })
    },
    summary() {
      const all = entries().sort((a, b) => a.claimedAt.localeCompare(b.claimedAt))
      return all.length ? all.map(e => `${e.claimedAt} ${e.stage.padEnd(28)} ${e.status.padEnd(18)} ${e.signature ?? '-'} slot ${e.slot ?? '-'} msg ${e.messageSha256.slice(0, 16)}`) : ['no journal entries']
    },
  })
}
