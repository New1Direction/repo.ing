import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const DAY = 86400000, MINIMUM = 50000000n
const fail = message => { throw Error(message) }
export function reminderEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)) fail('Enter a valid email address.')
  return email
}
export const remindersConfigured = (env = process.env) => env.BUILDER_REMINDERS_ENABLED === 'true' &&
  Boolean(env.RESEND_API_KEY && env.BUILDER_REMINDER_FROM && env.BUILDER_REMINDER_SECRET?.length >= 32)

export function reminderToken(row, purpose, secret) {
  const value = `${row.github_user_id}.${row.revision}.${purpose}`
  return `${value}.${createHmac('sha256', secret).update(value).digest('hex')}`
}
export function verifyReminderToken(token, row, purpose, secret) {
  if (!row || typeof token !== 'string') return false
  const expected = reminderToken(row, purpose, secret)
  return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected))
}
export function reminderPlan(repos, baseline = {}) {
  const ready = repos.filter(r => r.status === 'MATCH' && r.wallet && BigInt(r.available) > 0n)
  const available = ready.reduce((sum, r) => sum + BigInt(r.available), 0n)
  const newEarnings = ready.reduce((sum, r) => {
    const before = baseline[`${r.repoId}:${r.wallet}`] ?? '0'
    return sum + (BigInt(r.earned) > BigInt(before) ? BigInt(r.earned) - BigInt(before) : 0n)
  }, 0n)
  return { ready, available: String(available), notify: available >= MINIMUM && newEarnings >= MINIMUM,
    baseline: Object.fromEntries(repos.filter(r => r.status === 'MATCH').map(r => [`${r.repoId}:${r.wallet}`, String(r.earned)])) }
}
const sol = n => `${BigInt(n) / 1000000000n}.${String(BigInt(n) % 1000000000n).padStart(9, '0').replace(/0+$/, '') || '0'}`

// "Payout address change requested" (src/payout-address.mjs): a notice, sent at once, that a pasted address will become
// the payout address after its hold, with the claim page where any current admin can cancel it. It authorizes nothing.
export function payoutAddressNotice({ origin, repos, wallet, activeAt, requestedByLogin, previousWallet, unsubscribe }) {
  const one = repos.length === 1
  const subject = one ? `Payout address change requested for ${repos[0].fullName}` : `Payout address change requested for ${repos.length} repositories`
  const text = ['repo.ing payout address change requested', '',
    `GitHub user ${requestedByLogin} pasted a new Solana payout address for ${one ? repos[0].fullName : 'these repositories'}:`,
    ...(one ? [] : repos.map(repo => `- ${repo.fullName}`)), '', wallet, '',
    `It can receive builder payouts from ${new Date(activeAt).toISOString()}, after a 48-hour hold.`,
    previousWallet ? `Until then, payouts keep going to the current payout address ${previousWallet}.` : 'Until then, claims stay closed.', '',
    'If you did not expect this, any current admin of the repository can cancel it before then:',
    ...repos.map(repo => `${origin}/claim/${repo.repoId}`), '',
    'This email is a notice only. It never authorizes a payout.', '', `Unsubscribe: ${unsubscribe}`].join('\n')
  return { subject, text }
}

// Fixed provider, server configuration only. No browser-supplied delivery URL.
export function createReminderSender(env = process.env, fetchImpl = fetch) {
  if (!remindersConfigured(env)) return null
  if (/[\r\n]/.test(env.BUILDER_REMINDER_FROM)) fail('Invalid sender')
  return async ({ to, subject, text, key }) => {
    const response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ from: env.BUILDER_REMINDER_FROM, to: [to], subject, text }) })
    const body = await response.json()
    if (!response.ok || !body.id) fail('Email could not be sent. Please try again later.')
    return body.id
  }
}

export function createBuilderReminders({ pool, send, reconcile, secret, origin, now = Date.now }) {
  const link = (row, purpose) => `${origin}/builders/reminders#${purpose}=${reminderToken(row, purpose, secret)}`
  const withLock = async (id, work) => {
    const db = await pool.connect()
    try {
      await db.query('select pg_advisory_lock(hashtextextended($1,0))', [`builder-reminder:${id}`])
      try { return await work(db) } finally { await db.query('select pg_advisory_unlock(hashtextextended($1,0))', [`builder-reminder:${id}`]) }
    } finally { db.release() }
  }
  const status = async id => {
    const { rows: [row] } = await pool.query('select email,verified_at from builder_reminders where github_user_id=$1', [id])
    return row ? { email: row.email, status: row.verified_at ? 'active' : 'pending' } : { status: 'off' }
  }
  const subscribe = async (id, email) => {
    if (!send) fail('Email reminders are not available yet.')
    email = reminderEmail(email)
    return withLock(id, async db => {
      // Persists across cancellation, and limits the same destination even when
      // different authenticated accounts request it. No raw address in this log.
      for (const value of [`user:${id}`, `email:${email}`]) {
        const key = createHmac('sha256', secret).update(`reminder-rate:${value}`).digest('hex')
        const { rows } = await db.query(`insert into builder_reminder_requests(key,requested_at) values($1,$2)
          on conflict(key) do update set requested_at=excluded.requested_at
          where builder_reminder_requests.requested_at < $3 returning key`, [key, new Date(now()), new Date(now()-600000)])
        if (!rows.length) fail('Please wait ten minutes before requesting another email.')
      }
      const row = { github_user_id: id, revision: randomBytes(16).toString('hex') }
      // A newly entered address is never active until its own confirmation.
      await db.query(`insert into builder_reminders(github_user_id,email,revision,created_at) values($1,$2,$3,$4)
        on conflict(github_user_id) do update set email=excluded.email,revision=excluded.revision,created_at=excluded.created_at,
        verified_at=null,last_sent_at=null,next_check_at=now(),baseline='{}',delivery=null`, [id, email, row.revision, new Date(now())])
      await send({ to: email, subject: 'Confirm your repo.ing earnings reminders', key: `builder-confirm-${row.revision}`,
        text: `You requested builder earnings reminders on repo.ing.\n\nConfirm: ${link(row, 'confirm')}\n\nAt most one email per day, when at least 0.05 SOL in new verified fees is available. This link expires in 24 hours. No wallet signature is needed to confirm email.\n\nIf you did not request this, ignore this email or remove the request: ${link(row, 'unsubscribe')}` })
      return { status: 'pending', email }
    })
  }
  const act = async (token, purpose) => {
    if (!['confirm', 'unsubscribe'].includes(purpose) || !/^\d+\.[a-f0-9]{32}\.(confirm|unsubscribe)\.[a-f0-9]{64}$/.test(token ?? '')) fail('This reminder link is invalid or expired.')
    return withLock(token.split('.')[0], async db => {
      const { rows: [row] } = await db.query('select * from builder_reminders where github_user_id=$1', [token.split('.')[0]])
      if (!verifyReminderToken(token, row, purpose, secret)) fail('This reminder link is invalid or expired.')
      if (purpose === 'unsubscribe') {
        await db.query('delete from builder_reminders where github_user_id=$1', [row.github_user_id]); return { status: 'off' }
      }
      if (!send || now() - row.created_at.getTime() > DAY) fail('This confirmation expired. Request a new email from Builders.')
      await db.query('update builder_reminders set verified_at=coalesce(verified_at,$2) where github_user_id=$1', [row.github_user_id, new Date(now())])
      return { status: 'active' }
    })
  }
  const remove = id => withLock(id, db => db.query('delete from builder_reminders where github_user_id=$1', [id]))
  // Confirmed subscribers among githubUserIds only; never a new or unconfirmed address. One idempotency key per request
  // and recipient, so a retried call cannot send twice.
  const notifyPayoutAddressChange = async ({ githubUserIds, key, repoIds, wallet, activeAt, requestedByLogin, previousWallet = null }) => {
    if (!send) return { status: 'DISABLED', accepted: 0, failed: 0 }
    const ids = [...new Set(githubUserIds.map(String))].filter(id => /^[1-9]\d*$/.test(id))
    if (!ids.length || !/^[\w-]{1,80}$/.test(key)) return { status: 'NONE', accepted: 0, failed: 0 }
    const { rows: recipients } = await pool.query(`select github_user_id, email, revision from builder_reminders
      where github_user_id = any($1::bigint[]) and verified_at is not null`, [ids])
    if (!recipients.length) return { status: 'NONE', accepted: 0, failed: 0 }
    const { rows: repos } = await pool.query(`select github_repo_id::text as "repoId", full_name as "fullName" from repositories
      where github_repo_id = any($1::bigint[]) order by full_name`, [repoIds.map(String)])
    if (!repos.length) return { status: 'NONE', accepted: 0, failed: 0 }
    let accepted = 0, failed = 0
    for (const row of recipients) {
      const notice = payoutAddressNotice({ origin, repos, wallet, activeAt, requestedByLogin, previousWallet, unsubscribe: link(row, 'unsubscribe') })
      try { await send({ to: row.email, subject: notice.subject, text: notice.text, key: `payout-address-${key}-${row.github_user_id}` }); accepted++ }
      catch { failed++ }
    }
    return { status: 'CHECKED', accepted, failed }
  }
  const runOnce = async () => {
    if (!send) return { status: 'DISABLED', accepted: 0 }
    await pool.query('delete from builder_reminders where verified_at is null and created_at < $1', [new Date(now() - 2 * DAY)])
    await pool.query('delete from builder_reminder_requests where requested_at < $1', [new Date(now() - 2 * DAY)])
    const { rows } = await pool.query(`select github_user_id from builder_reminders where verified_at is not null
      and next_check_at <= $1 order by next_check_at limit 10`, [new Date(now())])
    let accepted = 0, failed = 0
    for (const item of rows) await withLock(item.github_user_id, async db => {
      const { rows: [row] } = await db.query('select * from builder_reminders where github_user_id=$1', [item.github_user_id])
      if (!row?.verified_at || row.next_check_at.getTime() > now()) return
      try {
        if (row.delivery) {
          // Never retry after the provider's 24h deduplication window. Freeze the
          // entire payload while retrying; a new balance must not reuse its key.
          const delivery = JSON.parse(row.delivery)
          const retry = now() - delivery.createdAt < 3600000
          if (retry) { await send(delivery.message); accepted++ }
          await db.query(`update builder_reminders set last_sent_at=$2,next_check_at=$3,baseline=$4,delivery=null where github_user_id=$1`,
            [row.github_user_id, retry ? new Date(now()) : row.last_sent_at, new Date(now() + DAY), JSON.stringify(delivery.baseline)])
          return
        }
        if (row.last_sent_at && now() - row.last_sent_at.getTime() < DAY) return
        // SOL markets only: a stock pair has no owner claim (src/stock-owner-claims.mjs), so never a "claim your fees" reminder.
        const { rows: markets } = await db.query(`select m.github_repo_id::text as "repoId",m.mint,r.full_name as "fullName",b.wallet
          from repo_beneficiaries b join markets m on m.github_repo_id=b.github_repo_id join repositories r on r.github_repo_id=m.github_repo_id
          where b.github_user_id=$1 and m.early_access_end is null and m.status='confirmed' and m.launch_finality='finalized' and m.indexed_at is not null and m.quote_asset_id is null limit 100`, [row.github_user_id])
        const repos = []
        for (const market of markets) {
          const fees = await reconcile(market.repoId)
          repos.push({ ...market, status: fees.status, available: String(fees.onchainCreatorFee ?? 0), earned: String(fees.recordedEarned) })
        }
        const plan = reminderPlan(repos, JSON.parse(row.baseline))
        if (!plan.notify) {
          await db.query('update builder_reminders set next_check_at=$2 where github_user_id=$1', [row.github_user_id, new Date(now() + 3600000)]); return
        }
        const message = { to: row.email, key: `builder-digest-${randomBytes(16).toString('hex')}`,
          subject: 'Your repository earnings are ready to review',
          text: [`repo.ing builder earnings`, '', `${sol(plan.available)} SOL in verified pool fees at ${new Date(now()).toISOString()}.`,
            ...plan.ready.map(r => `${r.fullName}: ${sol(r.available)} SOL`), '', `Review earnings: ${origin}/builders`,
            'Amounts can change. GitHub authority, payout readiness, and your saved recipient are checked again when you claim. This email never authorizes a payout.',
            '', `Unsubscribe: ${link(row, 'unsubscribe')}`].join('\n') }
        const delivery = { message, baseline: { ...JSON.parse(row.baseline), ...plan.baseline }, createdAt: now() }
        await db.query('update builder_reminders set delivery=$2 where github_user_id=$1', [row.github_user_id, JSON.stringify(delivery)])
        await send(message); accepted++
        await db.query(`update builder_reminders set last_sent_at=$2,next_check_at=$3,baseline=$4,delivery=null where github_user_id=$1`,
          [row.github_user_id, new Date(now()), new Date(now() + DAY), JSON.stringify(delivery.baseline)])
      } catch {
        failed++
        await db.query('update builder_reminders set next_check_at=$2 where github_user_id=$1', [row.github_user_id, new Date(now() + 600000)])
      }
    })
    return { status: 'CHECKED', accepted, failed }
  }
  return { status, subscribe, act, remove, runOnce, notifyPayoutAddressChange }
}
