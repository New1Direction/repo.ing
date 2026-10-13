import os from 'node:os'
import pg from 'pg'
import { walletLinkPair } from '../src/wallet-clusters.mjs'

// Operator-recorded wallet links (docs/LAUNCH_TRANSPARENCY.md#linked-wallets): two wallets an operator has public evidence are one
// controller, for example a funding transaction. Trading integrity, holder diversity and incentive eligibility then treat them as one.
//   node --env-file=.env.local scripts/wallet-links.mjs list [wallet]
//   node --env-file=.env.local scripts/wallet-links.mjs add <walletA> <walletB> "<evidence, at least 8 characters>"
//   node --env-file=.env.local scripts/wallet-links.mjs remove <walletA> <walletB>
// Removing keeps the row (removed_at), so the history of what was asserted stays auditable.
const [command, first, second, ...rest] = process.argv.slice(2)
if (!process.env.DATABASE_URL || !['list', 'add', 'remove'].includes(command)) {
  console.error('Usage: DATABASE_URL=... node scripts/wallet-links.mjs list [wallet] | add <walletA> <walletB> "<evidence>" | remove <walletA> <walletB>')
  process.exit(2)
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  if (command === 'list') {
    const { rows } = await pool.query(`select wallet_a, wallet_b, evidence, recorded_by, created_at, removed_at from wallet_links
      where $1::text is null or wallet_a = $1 or wallet_b = $1 order by id`, [first ?? null])
    console.log(JSON.stringify(rows, null, 1))
  } else if (command === 'add') {
    const { walletA, walletB } = walletLinkPair(first, second)
    const evidence = rest.join(' ').trim()
    if (evidence.length < 8 || evidence.length > 500) throw new Error('Evidence is 8 to 500 characters: say what links them (a transaction, an explorer link)')
    const { rowCount } = await pool.query(`insert into wallet_links (wallet_a, wallet_b, evidence, recorded_by) values ($1, $2, $3, $4)
      on conflict (wallet_a, wallet_b) where removed_at is null do nothing`, [walletA, walletB, evidence, os.userInfo().username.slice(0, 100)])
    console.log(rowCount ? `Linked ${walletA} and ${walletB}.` : 'Already linked.')
  } else {
    const { walletA, walletB } = walletLinkPair(first, second)
    const { rowCount } = await pool.query('update wallet_links set removed_at = now() where wallet_a = $1 and wallet_b = $2 and removed_at is null', [walletA, walletB])
    console.log(rowCount ? `Removed the link between ${walletA} and ${walletB}.` : 'No active link.')
  }
} finally { await pool.end() }
