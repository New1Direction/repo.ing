import BN from 'bn.js'
import { createMarketConfigResolver } from './market-config.mjs'
import { assertClaimSnapshot } from './claim-review.mjs'
import { claimAmounts } from './claim-amounts.mjs'
import bs58 from 'bs58'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, sql } from 'drizzle-orm'
import { markets, repoBeneficiaries, repoClaims } from './db/schema.mjs'

import { createGraduatedFees, recordGraduatedFees } from './graduated-fees.mjs'
import { settleClaim } from './claim-settlement.mjs'

// The creator's WSOL ATA is permissionless to create and fund, so routing payouts through it lets
// anyone perturb a claim's receipt. Graduated fees unwrap through a one-time authority instead
// (the SDK's claimPositionFee2 always uses the position owner's ATA).
export async function graduatedClaimInstructions(graduated, { owner, receiver, temporary, tokenAProgram }) {
  const p = graduated.poolState
  if (!p.tokenBMint.equals(NATIVE_MINT)) throw new Error('Graduated pool quote is not SOL')
  const tokenAAccount = getAssociatedTokenAddressSync(p.tokenAMint, receiver, true, tokenAProgram)
  const tokenBAccount = getAssociatedTokenAddressSync(NATIVE_MINT, temporary, false, TOKEN_PROGRAM_ID)
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, tokenAAccount, receiver, p.tokenAMint, tokenAProgram),
    createAssociatedTokenAccountIdempotentInstruction(owner, tokenBAccount, temporary, NATIVE_MINT, TOKEN_PROGRAM_ID),
    await graduated.amm.buildClaimPositionFeeInstruction({ owner, poolAuthority: graduated.amm.poolAuthority, pool: graduated.pool,
      position: graduated.position, positionNftAccount: graduated.nftAccount, tokenAAccount, tokenBAccount,
      tokenAVault: p.tokenAVault, tokenBVault: p.tokenBVault, tokenAMint: p.tokenAMint, tokenBMint: p.tokenBMint,
      tokenAProgram, tokenBProgram: TOKEN_PROGRAM_ID }),
    createCloseAccountInstruction(tokenBAccount, receiver, temporary),
  ]
}

export function createClaim({ pool, connection, config, creator, githubVerifier }) {
  if (!githubVerifier?.verifyCallback && !githubVerifier?.verifyCurrentAuthority) throw new Error('Fresh GitHub App verifier required')
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const resolveConfig = createMarketConfigResolver(config)
  const graduatedFees = createGraduatedFees({ connection, config, db: pool })

  const claim = async request => {
    const report = stage => { try { request.onProgress?.(stage) } catch { /* UI progress never changes payout settlement. */ } }
    if ('receiver' in request || 'beneficiaryWallet' in request || 'pool' in request || 'mint' in request) {
      throw new Error('Claim receiver and market are selected from the canonical repository record only')
    }
    const repoId = BigInt(request.githubRepoId)
    if (repoId <= 0n) throw new Error('GitHub repository ID must be positive')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId.toString()])
      try {
        const db = drizzle(client)
        const [market] = await db.select().from(markets).where(eq(markets.githubRepoId, repoId)).limit(1)
        if (!market || market.status !== 'confirmed' || !market.indexedAt || market.launchFinality !== 'finalized') {
          throw new Error('Repository has no indexed canonical market')
        }
        const mintKey = new PublicKey(market.mint)
        const configKey = resolveConfig(market)
        const poolKey = new PublicKey(market.pool)
        if (!deriveDbcPoolAddress(NATIVE_MINT, mintKey, configKey).equals(poolKey) ||
            market.creatorWallet !== creator.publicKey.toBase58()) {
          throw new Error('Canonical pool or platform creator authority mismatch')
        }
        const [pending] = await db.select().from(repoClaims).where(sql`${repoClaims.githubRepoId} = ${repoId} and ${repoClaims.status} = 'pending'`).limit(1)
        if (pending) throw new Error(`Pending claim ${pending.claimSignature} requires settlement review before another claim`)
        if (await connection.getBalance(creator.publicKey, 'confirmed') === 0) {
          throw new Error('Payout signer needs SOL for network costs')
        }

        const authorization = request.githubAuthorization
        if (!authorization || typeof authorization !== 'object') throw new Error('Fresh GitHub authorization required')
        const github = githubVerifier.verifyCurrentAuthority ? await githubVerifier.verifyCurrentAuthority({ githubRepoId: repoId }) : await githubVerifier.verifyCallback({ githubRepoId: repoId, expectedGithubRepoId: repoId,
          code: authorization.code, state: authorization.state, expectedState: authorization.expectedState })
        const checkedAt = new Date(github.verifiedAt)
        if (github.verified !== true || github.permission !== 'admin' || BigInt(github.githubRepoId) !== repoId ||
            !Number.isFinite(checkedAt.getTime()) || Date.now() - checkedAt.getTime() > 60_000 ||
            checkedAt.getTime() > Date.now() + 5_000) {
          throw new Error('Current GitHub admin authority required')
        }
        report('GitHub admin access verified. Checking accrued fees…')

        const [beneficiary] = await db.select().from(repoBeneficiaries).where(eq(repoBeneficiaries.githubRepoId, repoId)).limit(1)
        if (!beneficiary) throw new Error('Repository has no bound beneficiary')
        const receiverKey = new PublicKey(beneficiary.wallet)
        const state = await dbc.state.getPool(poolKey)
        const fixed = await dbc.state.getPoolConfig(configKey)
        if (!state || !fixed || !state.poolState.creator.equals(creator.publicKey) ||
            !state.poolState.config.equals(configKey) || !state.poolState.baseMint.equals(mintKey) ||
            !fixed.quoteMint.equals(NATIVE_MINT) || fixed.creatorTradingFeePercentage <= 0) {
          throw new Error('Canonical Meteora creator fee state mismatch')
        }
        const graduated = await graduatedFees.read(market, state, fixed)
        await recordGraduatedFees(client, market, graduated)
        const { rows: [ledger] } = await client.query(`select coalesce(sum(amount_base_units),0)::text as earned
          from builder_fee_credits where github_repo_id=$1`, [String(repoId)])
        const [settled] = await db.select({ paid: sql`coalesce(sum(${repoClaims.amountBaseUnits}), 0)::text` })
          .from(repoClaims).where(sql`${repoClaims.githubRepoId} = ${repoId} and ${repoClaims.status} = 'settled'`)
        if (request.review) assertClaimSnapshot(request.review, { repoId, beneficiary, paid: settled.paid })
        const outstanding = BigInt(ledger.earned) - BigInt(settled.paid)
        const dbcFee = BigInt(state.poolState.creatorQuoteFee.toString())
        const { payoutAmount, dbcPayout, dammFee, surplus } = claimAmounts({ dbcFee, dammFee: graduated?.available ?? 0n, outstanding, review: request.review })
        if (surplus > 0n) console.error('claim fee surplus: Meteora holds unindexed creator fees', { repo: repoId.toString(), surplus: surplus.toString() })
        const beforeFee = dbcFee + dammFee
        report('Repository fees match the Solana pools. Preparing payout…')
        const transaction = new Transaction()
        const temporaries = []
        if (dbcPayout > 0n) {
          const temporary = Keypair.generate()
          temporaries.push(temporary)
          transaction.add(await dbc.creator.claimCreatorTradingFee({ creator: creator.publicKey, payer: creator.publicKey, pool: poolKey,
            maxBaseAmount: new BN(0), maxQuoteAmount: new BN(dbcPayout.toString()), receiver: receiverKey, tempWSolAcc: temporary.publicKey }))
        }
        if (dammFee > 0n) {
          const temporary = Keypair.generate()
          temporaries.push(temporary)
          transaction.add(...await graduatedClaimInstructions(graduated, { owner: creator.publicKey, receiver: receiverKey,
            temporary: temporary.publicKey, tokenAProgram: fixed.tokenType === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID }))
        }
        const latest = await connection.getLatestBlockhash('confirmed')
        transaction.feePayer = creator.publicKey
        transaction.recentBlockhash = latest.blockhash
        transaction.sign(creator, ...temporaries)
        const signature = bs58.encode(transaction.signature)
        const simulation = await connection.simulateTransaction(transaction)
        if (simulation.value.err) throw new Error(`Claim preflight failed: ${JSON.stringify(simulation.value.err)}`)
        if (Date.now() - checkedAt.getTime() > 60_000) throw Error('GitHub authority check expired; retry the claim')
        // The pending signature is durable before broadcast. An uncertain submission blocks a new payout.
        await db.insert(repoClaims).values({ githubRepoId: repoId, beneficiaryWallet: beneficiary.wallet,
          amountBaseUnits: payoutAmount, dammAmountBaseUnits: dammFee, asset: NATIVE_MINT.toBase58(), claimSignature: signature, status: 'pending',
          signedTransaction: transaction.serialize().toString('base64'), lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) })
        await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false })
        report('Payout submitted. Waiting for Solana finality…')
        const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'finalized')
        if (confirmation.value.err) throw new Error(`Meteora claim failed: ${JSON.stringify(confirmation.value.err)}`)
        report('Transaction finalized. Verifying the payout receipt…')
        const receipt = await settleClaim(client, connection, { claimSignature: signature,
          signedTransaction: transaction.serialize().toString('base64'), beneficiaryWallet: beneficiary.wallet,
          amountBaseUnits: payoutAmount, dammAmountBaseUnits: dammFee })
        if (receipt?.status !== 'settled') throw Error('Finalized claim receipt is unavailable')
        const afterState = await dbc.state.getPool(poolKey)
        const afterGraduated = await graduatedFees.read(market, afterState, fixed)
        await recordGraduatedFees(client, market, afterGraduated)
        return { ...receipt, githubRepoId: repoId, githubUserId: BigInt(github.githubUserId),
          permission: github.permission, beneficiaryWallet: beneficiary.wallet, pool: market.pool,
          mint: market.mint, creatorFeeBefore: beforeFee,
          creatorFeeAfter: BigInt(afterState.poolState.creatorQuoteFee.toString()) + (afterGraduated?.available ?? 0n) }
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId.toString()]) }
    } finally { client.release() }
  }
  return { claim }
}
