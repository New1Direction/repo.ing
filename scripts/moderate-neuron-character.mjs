// Owner-operated, off-chain review. No public moderation endpoint or paid models.
import { createHookLabDatabasePool } from '../src/hooklab-database.mjs'
import { neuronCharacterStore } from '../src/neuron-characters.mjs'
const [id, decision, ...words] = process.argv.slice(2)
if (!process.env.NEURONS_DATABASE_URL || !id || !['published', 'rejected'].includes(decision) || !words.length) {
  console.error('Usage: NEURONS_DATABASE_URL=... node scripts/moderate-neuron-character.mjs UUID published|rejected "Review reason (10–500 characters)"')
  process.exitCode = 1
} else {
  const pool = createHookLabDatabasePool({ databaseUrl: process.env.NEURONS_DATABASE_URL })
  try {
    const character = await neuronCharacterStore(pool).review(id, decision, words.join(' '))
    console.log(JSON.stringify({ id: character.id, status: character.status, metadataSha256: character.metadataSha256, financialExecutionEnabled: false }))
  } catch { console.error('Review failed. Check the ID, reason and isolated database configuration.'); process.exitCode = 1 }
  finally { await pool.end() }
}
