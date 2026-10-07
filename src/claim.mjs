import BN from 'bn.js'
import { createMarketConfigResolver } from './market-config.mjs'
import { assertClaimSnapshot } from './claim-review.mjs'
import { claimAmounts, earlyAccessClaimAmounts } from './claim-amounts.mjs'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CP_AMM_PROGRAM_ID, derivePoolAuthority } from '@meteora-ag/cp-amm-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, sql } from 'drizzle-orm'
import { markets, repoClaims } from './db/schema.mjs'
import { assertAuthoritySource } from './market-identity.mjs'

import { createGraduatedFees, recordGraduatedFees } from './graduated-fees.mjs'
import { resolvePayoutRecipient } from './payout-address.mjs'
import { settleClaim } from './claim-settlement.mjs'
import { broadcastUntilSettled, signedWithPriorityFee } from './trade-landing.mjs'
import { EARLY_ACCESS_NOT_CLAIMABLE, isEarlyAccessMarket, tradingEarlyAccessConfig } from './early-access.mjs'
import { accountsAre, assertHookClaimInstructions, hookClaimInstructions, idempotentAta } from './dbc-hook-claims.mjs'

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

const CLAIM_POSITION_FEE = Buffer.from([180, 38, 154, 17, 133, 33, 162, 211])
const DAMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], CP_AMM_PROGRAM_ID)[0]
const CLOSE_ACCOUNT = 9

// Exactly the four instructions graduatedClaimInstructions builds, for this graduated pool, position, owner, receiver and one-time
// account: the receiver's token A account (Token-2022 for an early access market), the one-time WSOL account, claim_position_fee
// with every account in its IDL place and its signer and writable flags, and the WSOL account's close to the receiver.
export function assertGraduatedClaimInstructions(instructions, { owner, receiver, temporary, graduated, tokenAProgram }) {
  const fail = () => { throw Error('Claim transaction does not match the expected claim') }
  if (!Array.isArray(instructions) || instructions.length !== 4) fail()
  const [tokenAAccount, wsolAccount, claim, close] = instructions, p = graduated.poolState
  const tokenA = getAssociatedTokenAddressSync(p.tokenAMint, receiver, true, tokenAProgram)
  const tokenB = getAssociatedTokenAddressSync(NATIVE_MINT, temporary, false, TOKEN_PROGRAM_ID)
  if (!p.tokenBMint.equals(NATIVE_MINT) ||
      !idempotentAta(tokenAAccount, { payer: owner, account: tokenA, owner: receiver, mint: p.tokenAMint, program: tokenAProgram }) ||
      !idempotentAta(wsolAccount, { payer: owner, account: tokenB, owner: temporary, mint: NATIVE_MINT, program: TOKEN_PROGRAM_ID })) fail()
  if (!claim?.programId.equals(CP_AMM_PROGRAM_ID) || !claim.data.equals(CLAIM_POSITION_FEE) || !accountsAre(claim, [[derivePoolAuthority(), false, false],
    [graduated.pool, false, false], [graduated.position, false, true], [tokenA, false, true], [tokenB, false, true], [p.tokenAVault, false, true],
    [p.tokenBVault, false, true], [p.tokenAMint, false, false], [NATIVE_MINT, false, false], [graduated.nftAccount, false, false], [owner, true, false],
    [tokenAProgram, false, false], [TOKEN_PROGRAM_ID, false, false], [DAMM_EVENT_AUTHORITY, false, false], [CP_AMM_PROGRAM_ID, false, false]])) fail()
  if (!close?.programId.equals(TOKEN_PROGRAM_ID) || close.data.length !== 1 || close.data[0] !== CLOSE_ACCOUNT ||
      !accountsAre(close, [[tokenB, false, true], [receiver, false, true], [temporary, true, false]])) fail()
}

// A model market's binding names the model owner's _id when it was made (drizzle/0051_model_authority.sql). After a
// transfer, the new owner's fees must never go to the previous owner's wallet: the claim is refused until they bind one.
export function assertBindingAuthority(beneficiary, source, authority) {
  if ((beneficiary.authoritySource ?? 'github') !== source) throw new Error('Payout binding authority mismatch')
  if (source === 'huggingface' && beneficiary.authorityOwnerSubject !== authority.ownerSubject) {
    throw new Error('The model’s owner changed since this payout wallet was set. The current owner must set a payout wallet before claiming.')
  }
}

// githubVerifier: the market's payout authority. GitHub's (no source field) for repositories; a Hugging Face model market
// takes one with source 'huggingface' (app/lib/hf-session.mjs), whose fresh check also names the model's current owner.
// earlyAccess (EARLY_ACCESS_DBC_CONFIG): a contributor early access market's curve fees are claimed with
// claim_creator_trading_fee2 (src/dbc-hook-claims.mjs, docs/EARLY_ACCESS.md step 6c) and, after its graduation, its DAMM v2 fees with
// claim_position_fee with token A on Token-2022 (step 7c); unset, such a market is refused by name.
export function createClaim({ pool, connection, config, creator, githubVerifier, earlyAccess = tradingEarlyAccessConfig() }) {
  if (!githubVerifier?.verifyCallback && !githubVerifier?.verifyCurrentAuthority) throw new Error('Fresh GitHub App verifier required')
  const source = githubVerifier.source ?? 'github'
  const authorityName = source === 'huggingface' ? 'Hugging Face owner' : 'GitHub admin'
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const resolveConfig = createMarketConfigResolver(config, undefined, undefined, { earlyAccess })
  const graduatedFees = createGraduatedFees({ connection, config, db: pool, earlyAccess, earlyAccessGraduated: true })

  const claim = async request => {
    const report = stage => { try { request.onProgress?.(stage) } catch { /* UI progress never changes payout settlement. */ } }
    if ('receiver' in request || 'beneficiaryWallet' in request || 'pool' in request || 'mint' in request) {
      throw new Error('Claim receiver and market are selected from the canonical repository record only')
    }
    const repoId = BigInt(request.githubRepoId)
    if (repoId <= 0n) throw new Error('GitHub repository ID must be positive')
    assertAuthoritySource(githubVerifier, repoId)
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId.toString()])
      try {
        const db = drizzle(client)
        const [market] = await db.select().from(markets).where(eq(markets.githubRepoId, repoId)).limit(1)
        if (!market || market.status !== 'confirmed' || !market.indexedAt || market.launchFinality !== 'finalized') {
          throw new Error('Repository has no indexed canonical market')
        }
        // A transfer-hook pool's fees are claimed with claim_creator_trading_fee2 (below), only where the early access config is set.
        const hook = isEarlyAccessMarket(market)
        if (hook && !earlyAccess) throw new Error(EARLY_ACCESS_NOT_CLAIMABLE)
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
            checkedAt.getTime() > Date.now() + 5_000 ||
            (source === 'huggingface' && (github.source !== 'huggingface' || !/^[0-9a-f]{24}$/.test(github.ownerSubject ?? '')))) {
          throw new Error(`Current ${authorityName} authority required`)
        }
        report(`${authorityName} access verified. Checking accrued fees…`)

        // Only the active binding is ever a recipient. A pasted address whose hold has passed becomes it here, under this
        // repository's lock, with a new bound_at, so a review of the previous recipient no longer matches; one still in
        // its hold is never paid (src/payout-address.mjs).
        const beneficiary = await resolvePayoutRecipient(client, repoId)
        assertBindingAuthority(beneficiary, source, github)
        // Settled payouts change only under this lock. The review's recipient, binding time and paid revision are checked
        // before any chain read.
        const [settled] = await db.select({ paid: sql`coalesce(sum(${repoClaims.amountBaseUnits}), 0)::text` })
          .from(repoClaims).where(sql`${repoClaims.githubRepoId} = ${repoId} and ${repoClaims.status} = 'settled'`)
        if (request.review) assertClaimSnapshot(request.review, { repoId, beneficiary, paid: settled.paid })
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
        const outstanding = BigInt(ledger.earned) - BigInt(settled.paid)
        const dbcFee = BigInt(state.poolState.creatorQuoteFee.toString())
        const amounts = claimAmounts({ dbcFee, dammFee: graduated?.available ?? 0n, outstanding, review: request.review })
        const { payoutAmount, dbcPayout, dammFee, surplus } = hook ? earlyAccessClaimAmounts(amounts) : amounts
        if (surplus > 0n) console.error('claim fee surplus: Meteora holds unindexed creator fees', { repo: repoId.toString(), surplus: surplus.toString() })
        const beforeFee = dbcFee + (graduated?.available ?? 0n)
        report('Repository fees match the Solana pools. Preparing payout…')
        const payout = new Transaction()
        const temporaries = []
        // An early access payout's exact claims (the hook claim, or after graduation the DAMM v2 one), checked before and after the
        // network fee is added.
        let hookClaim = null, dammClaim = null
        if (dbcPayout > 0n) {
          const temporary = Keypair.generate()
          temporaries.push(temporary)
          if (hook) {
            hookClaim = { kind: 'creator', authority: creator.publicKey, payer: creator.publicKey, pool: poolKey, config: configKey, mint: mintKey,
              maxQuoteAmount: dbcPayout, receiver: receiverKey, temporary: temporary.publicKey }
            const instructions = await hookClaimInstructions(dbc, hookClaim)
            assertHookClaimInstructions(instructions, hookClaim)
            payout.add(...instructions)
          } else {
            payout.add(await dbc.creator.claimCreatorTradingFee({ creator: creator.publicKey, payer: creator.publicKey, pool: poolKey,
              maxBaseAmount: new BN(0), maxQuoteAmount: new BN(dbcPayout.toString()), receiver: receiverKey, tempWSolAcc: temporary.publicKey }))
          }
        }
        if (dammFee > 0n) {
          const temporary = Keypair.generate()
          temporaries.push(temporary)
          const spec = { owner: creator.publicKey, receiver: receiverKey, temporary: temporary.publicKey, graduated,
            tokenAProgram: fixed.tokenType === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID }
          const instructions = await graduatedClaimInstructions(graduated, spec)
          if (hook) {
            dammClaim = { ...spec, tokenAProgram: TOKEN_2022_PROGRAM_ID }
            assertGraduatedClaimInstructions(instructions, dammClaim)
          }
          payout.add(...instructions)
        }
        const latest = await connection.getLatestBlockhash('confirmed')
        // The platform creator signer pays the network fee (base + priority); the beneficiary's receipt is unaffected.
        const { transaction } = await signedWithPriorityFee(connection, payout, { feePayer: creator.publicKey,
          blockhash: latest.blockhash, signers: [creator, ...temporaries] })
        // An early access payout does one claim (earlyAccessClaimAmounts): besides the network fee (at most a unit limit and a price),
        // exactly the four instructions of its hook claim or of its DAMM v2 claim.
        if (hook) {
          const budget = transaction.instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId))
          const claimed = transaction.instructions.filter(ix => !budget.includes(ix))
          if (budget.length > 2 || Boolean(hookClaim) === Boolean(dammClaim)) throw new Error('Claim transaction does not match the expected claim')
          if (hookClaim) assertHookClaimInstructions(claimed, hookClaim)
          else assertGraduatedClaimInstructions(claimed, dammClaim)
        }
        const signature = bs58.encode(transaction.signature)
        const simulation = await connection.simulateTransaction(transaction)
        if (simulation.value.err) throw new Error(`Claim preflight failed: ${JSON.stringify(simulation.value.err)}`)
        if (Date.now() - checkedAt.getTime() > 60_000) throw Error(`${source === 'huggingface' ? 'Hugging Face' : 'GitHub'} authority check expired; retry the claim`)
        // The pending signature is durable before broadcast. An uncertain submission blocks a new payout.
        await db.insert(repoClaims).values({ githubRepoId: repoId, beneficiaryWallet: beneficiary.wallet,
          amountBaseUnits: payoutAmount, dammAmountBaseUnits: dammFee, asset: NATIVE_MINT.toBase58(), claimSignature: signature, status: 'pending',
          signedTransaction: transaction.serialize().toString('base64'), lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) })
        await broadcastUntilSettled(connection, transaction.serialize(), { signature, lastValidBlockHeight: latest.lastValidBlockHeight })
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
        return { ...receipt, githubRepoId: repoId, githubUserId: source === 'github' ? BigInt(github.githubUserId) : null,
          ...(source === 'huggingface' ? { authoritySubject: github.subject, ownerSubject: github.ownerSubject } : {}),
          permission: github.permission, beneficiaryWallet: beneficiary.wallet, pool: market.pool,
          mint: market.mint, creatorFeeBefore: beforeFee,
          creatorFeeAfter: BigInt(afterState.poolState.creatorQuoteFee.toString()) + (afterGraduated?.available ?? 0n) }
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId.toString()]) }
    } finally { client.release() }
  }
  return { claim }
}
