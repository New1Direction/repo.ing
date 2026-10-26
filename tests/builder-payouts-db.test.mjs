import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, sign } from 'node:crypto'
import pg from 'pg'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'
import { PAYOUT_WALLET_CAP_LAMPORTS, PayoutRefused, checkPayoutReceipt, claimMessage, createBuilderPayouts, owedLamports,
  unclaimedSweepDate } from '../src/builder-payouts.mjs'

// Real PostgreSQL with every committed migration (0087_builder_payouts): the switch and caps, claim windows, one-use
// signed challenges, and the pending-then-settled payout row. The chain is scripted: balances, a simulation, the
// broadcast and a finalized receipt built from the exact signed transfer.
const url = process.env.BUILDER_PAYOUT_TEST_DATABASE_URL
const SOL = 'So11111111111111111111111111111111111111112'
const REPO = 7001n, OTHER = 7002n, ADMIN = 901
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
const signText = (keypair, text) => bs58.encode(sign(null, Buffer.from(text, 'utf8'),
  createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(keypair.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' })))
const refused = code => error => error instanceof PayoutRefused && error.code === code

function scriptedChain(balances) {
  const sent = []
  return {
    sent,
    balance: async address => balances.get(address) ?? 0n,
    rentMinimum: async () => 890_880n,
    latestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulate: async () => null,
    broadcast: async (bytes, landing) => { sent.push({ bytes, ...landing }) },
    finalize: async () => null,
    receipt: async () => {
      const { Transaction } = await import('@solana/web3.js')
      const tx = Transaction.from(sent.at(-1).bytes), message = tx.compileMessage()
      const transfer = tx.instructions[0], amount = transfer.data.readBigUInt64LE(4)
      const keys = message.accountKeys.map(k => k.toBase58())
      const pre = keys.map(k => Number(balances.get(k) ?? 0n)), fee = 5000
      const post = keys.map((k, i) => pre[i] + (k === transfer.keys[1].pubkey.toBase58() ? Number(amount) : 0)
        - (k === transfer.keys[0].pubkey.toBase58() ? Number(amount) + fee : 0))
      return { transaction: { message }, meta: { err: null, fee, preBalances: pre, postBalances: post } }
    },
  }
}

test('builder payouts on real PostgreSQL', { skip: !url && 'BUILDER_PAYOUT_TEST_DATABASE_URL not set' }, async t => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_builder_payout_test', 'Disposable test database required')
  const pool = new pg.Pool({ connectionString: url, max: 4 })
  const payoutSigner = Keypair.generate(), wallet = Keypair.generate(), stranger = Keypair.generate()
  let verifiedAt = () => new Date(), permission = 'admin'
  const githubVerifier = { verifyCurrentAuthority: async ({ githubRepoId }) =>
    ({ verified: permission === 'admin', permission, githubRepoId, githubUserId: ADMIN, verifiedAt: verifiedAt() }) }
  const balances = new Map([[payoutSigner.publicKey.toBase58(), 1_500_000_000n], [wallet.publicKey.toBase58(), 1_000_000n]])
  const chain = scriptedChain(balances)
  const payouts = createBuilderPayouts({ pool, payoutSigner, githubVerifier, chain })
  const setControls = (enabled, maxClaim = 500_000_000n, daily = 2_000_000_000n) => pool.query(
    `update claim_controls set enabled = $1, max_claim_lamports = $2, daily_lamports = $3, updated_by = 'test' where key = 'builder_payouts'`,
    [enabled, String(maxClaim), String(daily)])
  const challengeAndSign = async (repo, signer = wallet) => {
    const c = await payouts.requestChallenge({ githubRepoId: repo })
    return { nonce: c.nonce, signature: signText(signer, c.message), challenge: c }
  }

  try {
    await pool.query(`truncate repo_claims, claim_payout_challenges, repo_claim_windows, repo_beneficiaries, fee_events, markets, repositories restart identity cascade`)
    for (const [id, i] of [[REPO, 1], [OTHER, 2], [1250276806n, 3]]) {
      await pool.query(`insert into repositories (github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
        values ($1, 'o', $2, $3, 1, 0, false, now())`, [String(id), `r${i}`, `o/r${i}`])
      const mint = Keypair.generate().publicKey.toBase58(), poolKey = Keypair.generate().publicKey.toBase58()
      await pool.query(`insert into markets (github_repo_id, status, launcher_wallet, creator_wallet, token_name, token_symbol, mint, pool, launch_signature)
        values ($1, 'confirmed', $2, $2, 'T', 'T', $3, $4, $5)`, [String(id), Keypair.generate().publicKey.toBase58(), mint, poolKey, `launch-${i}`])
      await pool.query(`insert into fee_events (github_repo_id, mint, pool, signature, event_index, amount_base_units, asset, kind, slot)
        values ($1, $2, $3, $4, 0, $5, $6, 'dbc_creator_quote', 1)`, [String(id), mint, poolKey, `sig-${i}`, String(1_200_000_000n), SOL])
      await pool.query(`insert into repo_beneficiaries (github_repo_id, github_user_id, wallet, method) values ($1, $2, $3, 'signature')`,
        [String(id), ADMIN, wallet.publicKey.toBase58()])
    }

    await t.test('the paused repositories can never open, and nothing pays before a window opens', async () => {
      await assert.rejects(pool.query(`insert into repo_claim_windows (github_repo_id, opened_by) values (1250276806, 'test')`), /check/)
      await assert.rejects(payouts.requestChallenge({ githubRepoId: REPO }), refused('claims-not-open'))
      await pool.query(`insert into repo_claim_windows (github_repo_id, opened_by) values ($1, 'test'), ($2, 'test')`, [String(REPO), String(OTHER)])
    })

    await t.test('the switch is off by default and refuses a valid claim', async () => {
      const { nonce, signature } = await challengeAndSign(REPO)
      await assert.rejects(payouts.claim({ githubRepoId: REPO, nonce, signature }), refused('payouts-off'))
    })

    await t.test('a stale or non-admin GitHub check, and a signature from another wallet, are refused', async () => {
      await setControls(true)
      const fresh = await challengeAndSign(REPO)
      verifiedAt = () => new Date(Date.now() - 61_000)
      await assert.rejects(payouts.claim({ githubRepoId: REPO, ...fresh }), refused('github-admin-required'))
      verifiedAt = () => new Date(); permission = 'write'
      await assert.rejects(payouts.requestChallenge({ githubRepoId: REPO }), refused('github-admin-required'))
      permission = 'admin'
      const other = await challengeAndSign(REPO, stranger)
      await assert.rejects(payouts.claim({ githubRepoId: REPO, ...other }), refused('invalid-signature'))
      const wrongRepo = await challengeAndSign(OTHER)
      await assert.rejects(payouts.claim({ githubRepoId: REPO, ...wrongRepo }), refused('challenge-mismatch'))
    })

    await t.test('a valid claim pays the owed amount up to the per-claim cap, then settles on the exact receipt', async () => {
      const { nonce, signature } = await challengeAndSign(REPO)
      const result = await payouts.claim({ githubRepoId: REPO, nonce, signature })
      assert.equal(result.status, 'settled')
      assert.equal(result.amountLamports, 500_000_000n, 'per-claim cap')
      const { rows: [row] } = await pool.query(`select status, payout_source, payout_nonce, amount_base_units::text as amount from repo_claims where claim_signature = $1`, [result.signature])
      assert.deepEqual(row, { status: 'settled', payout_source: 'payout-wallet', payout_nonce: nonce, amount: '500000000' })
      assert.equal(await owedLamports(pool, REPO), 700_000_000n)
      // Replaying the same nonce and signature is refused.
      await assert.rejects(payouts.claim({ githubRepoId: REPO, nonce, signature }), refused('challenge-used'))
    })

    await t.test('the rolling 24-hour cap holds across repositories', async () => {
      await setControls(true, 500_000_000n, 700_000_000n)
      const { nonce, signature } = await challengeAndSign(OTHER)
      const result = await payouts.claim({ githubRepoId: OTHER, nonce, signature })
      assert.equal(result.amountLamports, 200_000_000n, 'only what is left of the day')
      const next = await challengeAndSign(REPO)
      await assert.rejects(payouts.claim({ githubRepoId: REPO, ...next }), refused('daily-cap'))
    })

    await t.test('a payout wallet above its 2 SOL cap refuses to pay', async () => {
      await setControls(true, 500_000_000n, 5_000_000_000n)
      balances.set(payoutSigner.publicKey.toBase58(), PAYOUT_WALLET_CAP_LAMPORTS + 1n)
      const { nonce, signature } = await challengeAndSign(REPO)
      await assert.rejects(payouts.claim({ githubRepoId: REPO, nonce, signature }), refused('payout-wallet-over-cap'))
    })
  } finally { await pool.end() }
})

test('the claim message is frozen and binds repository, wallet and nonce', () => {
  const text = claimMessage({ githubRepoId: '1', wallet: 'W', nonce: 'n', expiresAt: '2026-10-26T00:00:00.000Z' })
  assert.equal(text, ['repo.ing builder payout claim v1', 'I claim this repository\'s builder fees to this Solana wallet.', 'Chain: Solana',
    'Repository ID: 1', 'Wallet: W', 'Nonce: n', 'Expires: 2026-10-26T00:00:00.000Z',
    'This signature authorizes one payout. It does not send a transaction from your wallet.'].join('\n'))
})

test('unclaimed balances become sweepable twelve months after claims open', () => {
  assert.equal(unclaimedSweepDate('2026-10-26T12:00:00Z').toISOString(), '2027-10-26T12:00:00.000Z')
})

test('a receipt that moves anything but the exact transfer is refused', () => {
  const keys = ['P', 'R', 'S']
  const tx = (pre, post, fee = 5000) => ({ transaction: { message: { accountKeys: keys } }, meta: { err: null, fee, preBalances: pre, postBalances: post } })
  assert.equal(checkPayoutReceipt(tx([100_000, 0, 1], [89_000, 1000, 1]), { payer: 'P', recipient: 'R', amount: 1000n }), false)
  assert.equal(checkPayoutReceipt(tx([100_000, 0, 1], [94_000, 1000, 1]), { payer: 'P', recipient: 'R', amount: 1000n }), true)
  assert.equal(checkPayoutReceipt(tx([100_000, 0, 1], [94_000, 1000, 2]), { payer: 'P', recipient: 'R', amount: 1000n }), false)
})
