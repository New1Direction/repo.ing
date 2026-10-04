// Drops a test's own database once the test is done with it. pool.end() resolves before the server has seen each of the pool's
// sessions go, and dropping with force terminates any session still open: its client, no longer listened to, reports
// "terminating connection due to administrator command" as an uncaught error, which fails a file whose tests all passed (seen on
// CI). So wait, up to 5 s, until the database has no sessions, then drop it with force, which still ends any that linger.
// admin: a pg Pool or Client connected to another database on the same server.
const POLL_MS = 100
const MAX_POLLS = 50

export async function dropTestDatabase(admin, name) {
  // Tests create their databases with an unquoted name, which PostgreSQL folds to lower case: only such a name matches
  // pg_stat_activity.datname as written, and only such a name is safe to put into the statement.
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`dropTestDatabase: ${JSON.stringify(name)} is not a plain lowercase database name`)
  for (let polls = 0; polls < MAX_POLLS; polls++) {
    const { rows: [{ open }] } = await admin.query('select count(*)::int as open from pg_stat_activity where datname = $1', [name])
    if (!open) break
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  await admin.query(`drop database if exists ${name} with (force)`)
}
