import pg from 'pg'

if (!process.env.DATABASE_URL || !process.argv[2]) throw new Error('DATABASE_URL and numeric GitHub repository ID required')
const repoId = BigInt(process.argv[2])
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  const { rows: [row] } = await pool.query('select coalesce(sum(amount_base_units),0)::text as amount from builder_fee_credits where github_repo_id=$1',[String(repoId)])
  console.log(JSON.stringify({ githubRepoId: repoId.toString(), asset: 'SOL', earnedLamports: row.amount }))
} finally { await pool.end() }
