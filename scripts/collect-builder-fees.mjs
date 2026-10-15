// Protected-runtime operator command. No list-all, automatic approval, or trading mode.
import { Connection } from '@solana/web3.js'
import { database, chain, configAddress, creatorSigner } from '../app/lib/server.mjs'
import { createBuilderFeeCollections } from '../src/builder-fee-collections.mjs'

const [mode, id, hash, approval, ...extra] = process.argv.slice(2)
const usage = 'Usage: collect-builder-fees.mjs review REPO_ID [RECEIVER] | review-exact REPO_ID RECEIVER LAMPORTS | simulate REVIEW_ID TERMS_HASH | claim REVIEW_ID TERMS_HASH --approve | receipt REVIEW_ID | recover'
if (!['review', 'review-exact', 'simulate', 'claim', 'receipt', 'recover'].includes(mode) || extra.length ||
    (mode !== 'recover' && !id) || (['simulate', 'claim'].includes(mode) && !hash) ||
    (mode === 'review-exact' && (!hash || !/^[1-9][0-9]*$/.test(approval ?? ''))) ||
    (mode === 'claim' && approval !== '--approve') || (!['claim', 'review-exact'].includes(mode) && approval) ||
    (mode === 'receipt' && hash) || (mode === 'recover' && (id || hash))) throw Error(usage)
for (const name of ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'GRADUATION_VERIFICATION_RPC_URL']) {
  if (!process.env[name]) throw Error(`${name} required`)
}
if (['review', 'review-exact', 'simulate', 'claim'].includes(mode) && !process.env.PLATFORM_CREATOR_SECRET_KEY) throw Error('PLATFORM_CREATOR_SECRET_KEY required')
const pool = database()
try {
  const service = createBuilderFeeCollections({ pool, connection: chain(), config: configAddress(),
    creator: ['review', 'review-exact', 'simulate', 'claim'].includes(mode) ? creatorSigner() : null,
    verification: new Connection(process.env.GRADUATION_VERIFICATION_RPC_URL, 'finalized') })
  let result
  if (mode === 'review') result = await service.review({ repoId: id, ...(hash ? { receiver: hash } : {}) })
  else if (mode === 'review-exact') result = await service.review({ repoId: id, receiver: hash, amount: approval })
  else if (mode === 'receipt') result = await service.receipt(id)
  else if (mode === 'recover') result = await service.recover()
  else result = await service.claim({ reviewId: id, termsHash: hash, simulateOnly: mode === 'simulate' })
  console.log(JSON.stringify(result, null, 2))
} finally { await pool.end() }
