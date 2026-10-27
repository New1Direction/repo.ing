// Economic acceptance, deliberately separate from historical selected-hook receipts.
// No model2 pricing helpers and no manual registry handoff. Missing app wiring fails.
import { createHash } from 'node:crypto'
import { PublicKey, AddressLookupTableAccount, AddressLookupTableProgram } from '@solana/web3.js'
import { describe, expect } from 'e2e'
import { test } from '@e2e-dev/web'
import { taxHookSetupManifest } from '../../../src/hooklab-hook-catalog.mjs'
import { connection, control, db, freshWallet, stack, until } from './support/stack.ts'
import { approveSignatures } from './support/wallets.ts'
import { finalizedOperations, operations } from './support/db.ts'
import { accountKeys, authenticatedEvents, big, coders, coinBalance, holdingAddress, lamportDelta, launchAccount, launchAddress, one, poolAccount, receipt, verifySignatures } from './support/chain.ts'
import { openLaunchPage, signInForLaunch, type OpenLaunched } from './support/open-flows.ts'
import { freshBuyerOnCoinPage, prepareTrade, tradeResult } from './support/flows.ts'
import { claimable, claimViaUi } from './support/claims.ts'
import { expectSettlementIsReceipt } from './support/settlement.ts'
import { SiteClient } from './support/site-client.ts'

const PLATFORM_OWNER = 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i'
const SELECTED_HOOK = '8WpjE7zTWWhLyzXnenjn3P1iXriTZTfgaiKSmf2kugau'
// Run the same public lifecycle for both independently pinned implementations.
// These hooks implement token callbacks, not the quote-cut callback: positive SOL
// cut limits correctly make simulation refuse them. Exercise supported nonzero
// burns instead. A separate author recipient is outside the V1 creator UI too.
for (const role of ['selected', 'alternate'] as const) {
const SYMBOL = role === 'selected' ? 'TAXV1' : 'RCPTV1', TAX_BPS = role === 'selected' ? 200n : 0n
const BURN_BUY = 37n, BURN_SELL = 83n, AUTHOR_SHARE = 2500
let coin: OpenLaunched, collector: string, creatorAccrued = 0n, platformAccrued = 0n
let platformTokensAccrued = 0n
let quoteReserve = 0n
let graduationSeen = false
const hooks = () => {
  if (stack.mode !== 'economic-hook' || stack.selectedHooks?.length !== 2) throw Error('Explicit economic-hook stack with two pinned candidate hooks required')
  if (!['127.0.0.1', 'localhost'].includes(new URL(stack.validator.url).hostname)) throw Error('Loopback chain required')
  expect(stack.selectedHooks.find(h => h.role === 'selected')?.program).toBe(SELECTED_HOOK)
  return stack.selectedHooks
}
const activeHook = () => hooks().find(h => h.role === role)!
const taxAddress = () => PublicKey.findProgramAddressSync([Buffer.from('tax'), new PublicKey(coin.mint).toBuffer()], new PublicKey(hooks()[0].program))[0]
async function collected() {
  if (role === 'alternate') {
    const address = PublicKey.findProgramAddressSync([Buffer.from('receipts'), new PublicKey(coin.mint).toBuffer()], new PublicKey(activeHook().program))[0]
    const a = await connection.getAccountInfo(address, 'finalized')
    expect(a?.owner.toBase58()).toBe(activeHook().program)
    expect(a!.data.length).toBe(82)
    expect(Buffer.from(a!.data).subarray(42, 74).equals(new PublicKey(coin.mint).toBuffer())).toBe(true)
    return Buffer.from(a!.data).readBigUInt64LE(74)
  }
  const a = await connection.getAccountInfo(taxAddress(), 'finalized')
  expect(a?.owner.toBase58()).toBe(hooks()[0].program)
  // Split TaxConfig appends the fixed platform holding after the unchanged collected offset.
  expect(a!.data.length).toBe(181)
  expect(new PublicKey(Buffer.from(a!.data).subarray(149, 181)).toBase58()).toBe(holdingAddress(coin.mint, PLATFORM_OWNER))
  return Buffer.from(a!.data).readBigUInt64LE(141)
}
async function approveTrade(screen: any, amount: string, side: 'buy' | 'sell', app: any) {
  await prepareTrade(screen, SYMBOL, side, amount)
  const measure = screen.getByRole('button', { name: 'Get measured quote', exact: true })
  await expect(measure).toBeEnabled({ timeout: 30_000 }); await measure.tap()
  await expect(screen.getByRole('heading', { name: 'Review measured quote', exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(screen.getByText('Unmeasured — get a quote first', { exact: true })).not.toBeVisible()
  await screen.getByRole('region', { name: 'Exact selected-hook trade review', exact: true }).scrollIntoView()
  await app.screenshot(`economic-${side}-measured-quote`)
  await screen.getByRole('button', { name: 'Use this minimum and review', exact: true }).tap()
  await expect(screen.getByRole('heading', { name: 'Review this exact trade', exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(screen.getByText('Unmeasured — get a quote first', { exact: true })).not.toBeVisible()
  await screen.getByRole('region', { name: 'Exact selected-hook trade review', exact: true }).scrollIntoView()
  await app.screenshot(`economic-${side}-exact-review`)
  await screen.getByRole('button', { name: 'Approve exact trade', exact: true }).tap()
}
async function checkedTrade(op: any, wallet: string, before: bigint, collectorBefore: bigint) {
  const tx = await receipt(op.signature)
  expect(tx.meta?.err).toBeNull(); verifySignatures(tx, wallet)
  const keys = accountKeys(tx)
  const invoked = (tx.meta?.innerInstructions ?? []).flatMap(g => g.instructions.map(ix => keys[ix.programIdIndex]))
  expect(invoked.includes(activeHook().program)).toBe(true)
  expect(invoked.includes(hooks().find(h => h.role !== role)!.program)).toBe(false)
  expect(invoked.includes(stack.programs!.gate)).toBe(false)
  expect(tx.transaction.message.compiledInstructions.some(ix => keys[ix.programIdIndex] === stack.programs!.gate)).toBe(false)
  const paid = await collected() - before
  expect(paid > 0n).toBe(true)
  const evidence = authenticatedEvents(tx), swaps = evidence.filter(e => e.program === 'swap')
  expect(evidence.some(e => e.name === 'InclusiveCreatorFeeAccrued')).toBe(false)
  const swap = one(swaps, 'Swapped'), native = one(swaps, 'SwappedNative'), buy = swap.direction === 1
  expect(swap.pool.toBase58()).toBe(coin.pool)
  expect(swap.trader.toBase58()).toBe(wallet); expect(swap.recipient.toBase58()).toBe(wallet)
  expect(big(swap.slot)).toBe(BigInt(tx.slot))
  const swapEvent = evidence.find(e => e.name === 'Swapped')!
  expect(swapEvent.caller).toBeNull()
  const transfers = evidence.filter(e => e.program === 'token' && e.name === 'Transferred' && e.data.mint.toBase58() === coin.mint)
  const main = transfers.filter(e => e.index === swapEvent.index)
  expect(main.length).toBe(1); expect(main[0].caller).toBe(stack.programs!.swap)
  const transfer = main[0].data, gross = big(buy ? swap.amount_out : swap.amount_in)
  const burn = gross * (buy ? BURN_BUY : BURN_SELL) / 10000n
  expect(big(transfer.amount)).toBe(gross - burn)
  expect(transfer[buy ? 'destination_owner' : 'source_owner'].toBase58()).toBe(wallet)
  expect(big(buy ? swap.cuts_out : swap.cuts_in)).toBe(((gross - burn) * TAX_BPS + 9999n) / 10000n)
  expect(big(buy ? swap.burn_out : swap.burn_in)).toBe(burn)
  expect(burn > 0n).toBe(true)
  // Graduation can transfer reserve top-up too. Check ceil tax per actual token transfer,
  // not once on their sum or only on the swap output.
  let tokenPaid = 0n, platformTokens = 0n, collectorTokens = 0n
  for (const { data: t } of transfers) {
    const tax = (big(t.amount) * TAX_BPS + 9999n) / 10000n
    const platform = tax / 4n, remainder = tax - platform
    const actual = t.deltas.map((d: any) => [d.holding.toBase58(), big(d.amount)]).sort((a: any, b: any) => a[0].localeCompare(b[0]))
    const expected = role === 'selected' ? [[holdingAddress(coin.mint, PLATFORM_OWNER), platform], [holdingAddress(coin.mint, collector), remainder]].sort((a: any, b: any) => a[0].localeCompare(b[0])) : []
    expect(actual).toEqual(expected)
    tokenPaid += tax
    platformTokens += platform; collectorTokens += remainder
  }
  expect(paid).toBe(role === 'selected' ? tokenPaid : BigInt(transfers.length * 2))
  if (role === 'selected') {
    expect(await coinBalance(coin.mint, collector) - collectorBefore).toBe(collectorTokens)
    platformTokensAccrued += platformTokens
    expect(await coinBalance(coin.mint, PLATFORM_OWNER)).toBe(platformTokensAccrued)
    // These are token credits, never native-SOL payments to either tax recipient.
    expect(lamportDelta(tx, collector)).toBe(0n)
    expect(lamportDelta(tx, PLATFORM_OWNER)).toBe(0n)
    expect(lamportDelta(tx, holdingAddress(coin.mint, collector))).toBe(0n)
    expect(lamportDelta(tx, holdingAddress(coin.mint, PLATFORM_OWNER))).toBe(0n)
  }
  expect(big(buy ? transfer.destination_post : transfer.source_post)).toBe(await coinBalance(coin.mint, wallet))
  const quoteDeltas = buy ? swap.deltas_in : swap.deltas_out
  expect(quoteDeltas.length).toBe(1)
  expect(quoteDeltas[0].holding.toBase58()).toBe(coin.launch)
  const creator = big(quoteDeltas[0].amount), protocol = big(swap.protocol_fee)
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d
  const pool = (await poolAccount(coin.pool)).value, share = BigInt(pool.protocol_share_bps)
  const lpBps = BigInt(swap.lp_fee_bps)
  const creatorBasis = buy ? big(swap.amount_in) : big(swap.amount_out) - ceil(big(swap.amount_out) * lpBps, 10000n)
  const grossCreator = ceil(creatorBasis * BigInt((await launchAccount(coin.launch)).value.creator_fee_bps), 10000n)
  const creatorShare = grossCreator * share / 10000n
  const lpQuote = ceil((buy ? big(swap.amount_in) - grossCreator : big(swap.amount_out)) * lpBps, 10000n)
  // Platform revenue comes from the existing gross creator budget, never an
  // additional charge. Token tax remains a separate, conserved token split.
  expect(share).toBe(2500n)
  expect(creator + creatorShare).toBe(grossCreator)
  expect(creator).toBe(grossCreator - creatorShare)
  expect(protocol).toBe(lpQuote + creatorShare)
  expect(lamportDelta(tx, coin.launch)).toBe(creator)
  expect(native.quote_deltas.map((d: any) => [d.holding.toBase58(), big(d.amount)])).toEqual([[coin.launch, creator]])
  const delivered = big(swap.delivered_out), received = big(swap.received_in)
  const mainTax = ((gross - burn) * TAX_BPS + 9999n) / 10000n
  expect(received).toBe(buy ? big(swap.amount_in) - creator : gross - burn - mainTax)
  expect(delivered).toBe(buy ? gross - burn - mainTax : big(swap.amount_out) - protocol - creator)
  expect(big(swap.quote_reserve)).toBe(quoteReserve + (buy ? received - lpQuote - creatorShare : -big(swap.amount_out)))
  quoteReserve = big(pool.quote_reserve)
  expect(big(native.quote_lamports)).toBe(buy ? received : delivered)
  expect(lamportDelta(tx, coin.pool)).toBe(buy ? received : -(delivered + creator))
  const holdingRent = lamportDelta(tx, holdingAddress(coin.mint, wallet))
  expect(lamportDelta(tx, wallet)).toBe(buy ? -big(swap.amount_in) - BigInt(tx.meta!.fee) - holdingRent : delivered - BigInt(tx.meta!.fee))
  creatorAccrued += creator; platformAccrued += protocol
  expect(big((await poolAccount(coin.pool)).value.protocol_fees_quote)).toBe(platformAccrued)
  expectSettlementIsReceipt(op, tx)
  expect(op.first_finalized?.quote?.protocolFeesQuoteAccrued).toBe(String(protocol))
  // Model1 authenticates an increment, not an absolute historical counter.
  expect(op.first_finalized?.quote?.after?.protocolFeesQuote).toBeNull()
  if (evidence.some(e => e.name === 'Graduated')) {
    graduationSeen = true
    const g = one(evidence.filter(e => e.program === 'launch'), 'Graduated')
    const f = one(swaps, 'CurveFinalized')
    expect(evidence.find(e => e.name === 'Graduated')!.caller).toBeNull()
    expect(evidence.find(e => e.name === 'CurveFinalized')!.caller).toBe(stack.programs!.launch)
    expect(g.launch.toBase58()).toBe(coin.launch); expect(g.mint.toBase58()).toBe(coin.mint)
    expect(g.pool.toBase58()).toBe(coin.pool); expect(g.cranker.toBase58()).toBe(wallet)
    expect(big(g.base_reserve)).toBe(big(f.base_reserve))
    expect(big(g.quote_reserve)).toBe(big(f.quote_reserve))
    expect(big(g.lp_minted)).toBe(big(f.lp_minted)); expect(big(g.lp_minted) > 0n).toBe(true)
  }
  expect((await control<Record<string, number>>('GET', '/rpc/sends'))[op.signature]).toBe(1)
  return tx
}

describe(`local unreviewed economic ${role} hook lifecycle`, { serial: true }, () => {
  test('both distinct catalogue candidates are genuinely immutable exact ELFs on the disposable chain', async () => {
    expect((await control('GET', '/health')).agent).toBe(false)
    const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
    for (const [dependency, expected] of [
      ['token', '5fbbb2ebca32ed3df4c0299da3376141969ac6088700c86390d8b05d0c451dab'],
      ['gate', '0f3261b6420f20a3c9feb1d5ead5e8cb432ce972e8716d61dda995fe78c1697b'],
    ] as const) {
      const program = new PublicKey(stack.programs![dependency]), pd = PublicKey.findProgramAddressSync([program.toBuffer()], loader)[0]
      const [p, d] = await connection.getMultipleAccountsInfo([program, pd], 'finalized')
      expect(p?.executable).toBe(true); expect(p?.owner.toBase58()).toBe(loader.toBase58())
      expect(Buffer.from(p!.data).subarray(4).equals(pd.toBuffer())).toBe(true)
      expect(d?.owner.toBase58()).toBe(loader.toBase58())
      expect(createHash('sha256').update(d!.data.subarray(45)).digest('hex')).toBe(expected)
      console.log('ECONOMIC_DEPENDENCY_PIN', JSON.stringify({ dependency, program: program.toBase58(), sha256: expected }))
    }
    for (const h of hooks()) {
      const program = new PublicKey(h.program), pd = PublicKey.findProgramAddressSync([program.toBuffer()], loader)[0]
      const [p, d] = await connection.getMultipleAccountsInfo([program, pd], 'finalized')
      expect(p?.executable).toBe(true); expect(p?.owner.toBase58()).toBe(loader.toBase58())
      expect(Buffer.from(p!.data).subarray(4).equals(pd.toBuffer())).toBe(true)
      expect(d?.owner.toBase58()).toBe(loader.toBase58())
      const bytes = Buffer.from(d!.data)
      expect(bytes.readUInt32LE()).toBe(3); expect(bytes[12]).toBe(0)
      expect(bytes.length).toBe(45 + h.pin.elfLength)
      expect(createHash('sha256').update(bytes.subarray(45)).digest('hex')).toBe(h.pin.elfSha256)
      console.log('ECONOMIC_HOOK_PIN', JSON.stringify({ ...h.pin, immutable: true, genesis: stack.genesisHash }))
    }
  })

  test('developer publishes both hooks; creator selects this implementation and reviews nonzero economics', { timeout: 900_000 }, async ({ app, screen, browser }) => {
    const creator = await freshWallet(20); collector = (await freshWallet(1)).publicKey.toBase58()
    expect(collector).not.toBe(PLATFORM_OWNER)
    expect(collector).not.toBe(creator.publicKey.toBase58())
    await openLaunchPage({ app, screen, browser }, creator)
    const approvals = await approveSignatures(browser)
    await app.open('/hooks/publish'); await signInForLaunch(screen)
    await screen.getByText('Setup manifest format', { exact: true }).tap()
    await screen.getByText(/both platform and collector token accounts are created atomically/).scrollIntoView()
    await app.screenshot('economic-two-recipient-setup-disclosure')
    await screen.getByText('Setup manifest format', { exact: true }).tap()
    for (const h of hooks()) {
      const selectedHook = { program: h.program, flags: h.flags }
      // Both publications are exercised by the same launch/trade/claim lifecycle.
      const derived = (seed: string) => ({ kind: 'pda', program: 'selectedHook', seeds: [{ kind: 'bytes', hex: Buffer.from(seed).toString('hex') }, { kind: 'mint' }] })
      const manifest = h.role === 'selected' ? taxHookSetupManifest(selectedHook) : {
        schema: 'repoing/hook-setup-manifest/1', selectedHook, fields: [], instructions: [{
          data: [{ kind: 'bytes', hex: createHash('sha256').update('global:prepare').digest().subarray(0, 8).toString('hex') }],
          accounts: [{ source: { kind: 'creator' }, signer: true, writable: true }, { source: { kind: 'mint' }, signer: false, writable: false },
            { source: derived('receipts'), signer: false, writable: true }, { source: derived('bordrless-hook-accounts'), signer: false, writable: true },
            { source: { kind: 'fixed', address: '11111111111111111111111111111111' }, signer: false, writable: false }],
        }],
      }
      for (const [label, value] of Object.entries({ 'Hook name': h.name, 'Immutable version': 'local-v1', 'Hook program address': h.program,
        'Callback flags (1–255)': String(h.flags), 'Declared behavior': h.role === 'selected' ? `Tax transfer destinations; collector exempt. Transfers to and from fixed platform treasury ${PLATFORM_OWNER} are tax-exempt. Creators cannot replace this exempt address.` : 'Transfer callback receipt only.',
        'Declared fees (including token fees)': h.role === 'selected' ? 'Configured 200 bps transfer tax, rounded up; platform receives floor(gross/4), collector receives remainder. App creates both holdings atomically with launch. No token-tax SOL surcharge.' : 'No token fee.',
        'Declared risks and restrictions': 'Local unreviewed candidate. No mainnet authorization.', 'Declarative setup manifest (JSON)': JSON.stringify(manifest) })) await screen.getByLabel(label, { exact: true }).fill(value)
      await screen.getByRole('button', { name: 'Publish immutable version' }).tap()
      await expect(screen.getByText('Published. Creators can discover this version in the hook selector.')).toBeVisible({ timeout: 60_000 })
      await app.screenshot(`economic-publication-${h.role}`)
    }
    await app.open('/hooks/launch-review')
    await screen.getByLabel('Coin name').fill('Economic tax candidate'); await screen.getByLabel('Ticker').fill(SYMBOL)
    await screen.getByLabel('Upload coin image').setInputFiles('fixtures/coin.png')
    await expect(screen.getByText('Looks good')).toBeVisible()
    await screen.getByLabel('Hook configuration').selectOption({ value: 'selected' })
    for (const h of hooks()) await until(`visible catalogue choice ${h.name}`, async () =>
      (await screen.getByRole('option', { name: h.name, exact: false }).count()) >= 1)
    const client = new SiteClient(creator); await client.signIn()
    const catalog = await fetch(new URL('/api/hook-lab/hook-catalog', stack.origin)).then(r => r.json())
    const publication = catalog.publications.find((p: any) => p.selectedHook.program === activeHook().program && p.publisher === creator.publicKey.toBase58())
    expect(!!publication).toBe(true)
    await screen.getByLabel('Published hook version').selectOption({ value: publication.digest })
    if (role === 'selected') {
      await screen.getByLabel('Transfer fee (basis points)').fill(String(TAX_BPS))
      await screen.getByLabel('Wallet cap (basis points; 0 disables)').fill('0'); await screen.getByLabel('Collector wallet').fill(collector)
    }
    await screen.getByText('Advanced economics (optional)', { exact: true }).tap()
    await screen.getByLabel('Author share of creator revenue', { exact: true }).selectOption({ value: 'configure' })
    await screen.getByLabel('Author share (0–5000 bps)', { exact: true }).fill(String(AUTHOR_SHARE))
    await screen.getByLabel('Token burn rules', { exact: true }).selectOption({ value: 'configure' })
    await screen.getByLabel('Buy token burn', { exact: false }).fill(String(BURN_BUY))
    await screen.getByLabel('Sell token burn', { exact: false }).fill(String(BURN_SELL))
    // Non-menu fee at the existing combined fee/burn ceiling: 117 + 83 = 200.
    await screen.getByLabel('Creator fee (bps)', { exact: true }).fill('117')
    await app.screenshot('economic-creator-configuration')
    await screen.getByRole('button', { name: 'Review launch' }).tap(); await signInForLaunch(screen)
    const review = screen.getByRole('region', { name: 'Check your launch' })
    await expect(review).toContainText('1.17%')
    await expect(review).toContainText('floor(gross / 4)')
    await expect(review).toContainText('Unconfigured (hook defaults)')
    await expect(review).toContainText('2500 bps')
    await expect(review).toContainText('Buy 37 bps · Sell 83 bps')
    await expect(review).toContainText('It does not go to a separate recipient.')
    await app.screenshot('economic-nonzero-launch-review')
    await screen.getByRole('button', { name: /^(Sign and launch|Check hook availability)$/ }).tap()
    const address = creator.publicKey.toBase58()
    for (const stage of ['hook-setup', 'preparation', 'launch']) {
      await until(`${stage} review (requires release2 policy and explicit setupLimits)`, async () => (await operations(address, stage)).find(op => op.status === 'reviewed'))
      if (stage === 'hook-setup') {
        const [setupReview] = await operations(address, stage), cost = setupReview.review.supplementalTableCost
        expect(cost.permanentFreeze).toBe(true)
        expect(BigInt(cost.rentLamports) > 0n && BigInt(cost.rentLamports) < BigInt(setupReview.review.maxNativeDebitLamports)).toBe(true)
        const disclosure = screen.getByLabel('Permanent supplemental table cost')
        await expect(disclosure).toContainText(`${cost.rentLamports} lamports`)
        await expect(disclosure).toContainText('rent cannot be reclaimed')
        await expect(disclosure).toContainText('table cannot be closed')
        const reviewed = screen.getByLabel('Exact selected-hook transaction review')
        await expect(reviewed.getByText(cost.address, { exact: true })).not.toBeVisible()
        await reviewed.getByText('Technical details', { exact: true }).tap()
        await expect(reviewed.getByText(cost.address, { exact: true })).toBeVisible()
        await app.screenshot('economic-hook-setup-details')
        await reviewed.getByText('Technical details', { exact: true }).tap()
        await expect(disclosure).toBeVisible()
        expect(await connection.getAccountInfo(new PublicKey(cost.address), 'finalized')).toBeNull()
        const { rows: [original] } = await db.query('select custody_operation_id, name, symbol, uri, creator_fee_bps, selected_hook, hook_publication from hook_lab_launch_requests where creator_wallet=$1', [address])
        expect(!!original).toBe(true)
        const before = (await operations(address)).map(op => [op.id, op.message_sha256, op.signature])
        const tampered = await client.post('/api/hook-lab/native-launch', {
          action: 'reserve', operationId: original.custody_operation_id, name: original.name, symbol: original.symbol, uri: original.uri,
          label: SYMBOL, virtualQuote: '0', creatorFeeBps: original.creator_fee_bps, capBps: 0, selectedHook: original.selected_hook,
          hookPublication: { ...original.hook_publication, configuration: { ...original.hook_publication.configuration, feeBps: '201' } },
        })
        expect(tampered.status >= 400 && tampered.status < 500).toBe(true)
        expect((await operations(address)).map(op => [op.id, op.message_sha256, op.signature])).toEqual(before)
      }
      await expect(screen.getByLabel('Exact selected-hook transaction review')).toBeVisible()
      await app.screenshot(`economic-${stage}-review`)
      await screen.getByRole('button', { name: 'Continue', exact: true }).tap()
    }
    await expect(screen.getByRole('heading', { name: `$${SYMBOL} is live` })).toBeVisible({ timeout: 300_000 })
    const [setup] = await finalizedOperations(address, 'hook-setup', 1), [preparation] = await finalizedOperations(address, 'preparation', 1), [launchOp] = await finalizedOperations(address, 'launch', 1)
    const mint = launchOp.resolved_request.mint, launch = launchAddress(mint), pool = (await launchAccount(launch)).value.pool.toBase58()
    coin = { creator, address, mint, launch, pool, preparation, launchOp, reviewText: publication.digest }
    const tx = await receipt(setup.signature!); verifySignatures(tx, address)
    expect(accountKeys(tx).slice(0, tx.transaction.message.header.numRequiredSignatures)).toEqual([address])
    const cost = setup.review.supplementalTableCost, table = await connection.getAccountInfo(new PublicKey(cost.address), 'finalized')
    expect(table?.owner.toBase58()).toBe(AddressLookupTableProgram.programId.toBase58())
    expect(BigInt(table!.lamports)).toBe(BigInt(cost.rentLamports))
    const tableState = AddressLookupTableAccount.deserialize(table!.data)
    expect(tableState.authority).toBeUndefined(); expect(tableState.deactivationSlot).toBe(0xffffffffffffffffn)
    expect(tableState.lastExtendedSlot).toBe(tx.slot)
    expect(lamportDelta(tx, cost.address)).toBe(BigInt(cost.rentLamports))
    const intents = await db.query('select mint, hook_publication from hook_lab_selected_hook_setup_intents where owner_wallet=$1', [address])
    expect(intents.rows.map(r => r.mint)).toEqual([mint]); expect(intents.rows[0].hook_publication.digest).toBe(publication.digest)
    // No out-of-app repair: the launch transaction itself must create both holdings.
    const launchTx = await receipt(launchOp.signature!)
    const packetBytes = 1 + 64 * launchTx.transaction.message.header.numRequiredSignatures + launchTx.transaction.message.serialize().length
    expect(packetBytes <= 1232).toBe(true)
    expect(launchTx.transaction.message.addressTableLookups.some(t => t.accountKey.toBase58() === cost.address)).toBe(true)
    if (role === 'selected') {
    for (const owner of [collector, PLATFORM_OWNER]) {
    const holding = holdingAddress(mint, owner)
    const creations = authenticatedEvents(launchTx).filter(e => e.program === 'token' && e.name === 'HoldingCreated' && e.data.holding.toBase58() === holding)
    const created = one(creations, 'HoldingCreated'), launchKeys = accountKeys(launchTx)
    const launchIndex = launchTx.transaction.message.compiledInstructions.findIndex(ix => launchKeys[ix.programIdIndex] === stack.programs!.launch)
    expect(launchIndex >= 0 && creations[0].index > launchIndex).toBe(true)
    expect(creations[0].caller).toBeNull()
    expect(created.owner.toBase58()).toBe(owner); expect(created.mint.toBase58()).toBe(mint)
    expect(created.payer.toBase58()).toBe(address)
    expect((await connection.getAccountInfo(new PublicKey(holding), 'finalized'))?.owner.toBase58()).toBe(stack.programs!.token)
    expect(await coinBalance(mint, owner)).toBe(0n)
    expect(lamportDelta(launchTx, holding) > 0n).toBe(true)
    }
    }
    expect(big((await poolAccount(pool)).value.protocol_fees_quote)).toBe(0n)
    quoteReserve = big((await poolAccount(pool)).value.quote_reserve)
    expect((await poolAccount(pool)).value.fee_model).toBe(1)
    expect((await launchAccount(launch)).value.author_share_bps).toBe(0)
    // V1 binds config author to the creator, so the effective on-chain share is
    // deliberately zero even when a nonzero share was requested in the UI.
    expect(launchOp.resolved_request.authorShareBps).toBe(AUTHOR_SHARE)
    expect(launchOp.resolved_request.quoteCut).toBeUndefined()
    const configInfo = await connection.getAccountInfo(new PublicKey(launchOp.resolved_request.selectedConfig), 'finalized')
    expect(configInfo?.owner.toBase58()).toBe(stack.programs!.launch)
    const config = coders.launch.accounts.decode('LaunchConfig', configInfo!.data)
    expect(config.creator.toBase58()).toBe(address)
    expect(config.author_share_bps).toBe(AUTHOR_SHARE)
    expect(Buffer.from(config.reserved).readUInt16LE(1)).toBe(0)
    expect(Buffer.from(config.reserved).readUInt16LE(3)).toBe(0)
    expect((await launchAccount(launch)).value.rules.burn_buy_bps).toBe(Number(BURN_BUY))
    expect((await launchAccount(launch)).value.rules.burn_sell_bps).toBe(Number(BURN_SELL))
    expect(await claimable(launch)).toBe(0n)
    const launchTransfers = authenticatedEvents(launchTx).filter(e => e.program === 'token' && e.name === 'Transferred' && e.data.mint.toBase58() === mint)
    expect(launchTransfers.length > 0).toBe(true)
    // Launch seeds the reserve through token transfers too. The receipt hook
    // records both callbacks even though the tax hook exempts this reserve seed.
    expect(await collected()).toBe(role === 'alternate' ? BigInt(launchTransfers.length * 2) : 0n)
    console.log('ECONOMIC_LAUNCH', JSON.stringify({ hook: activeHook().program, mint, launch, pool,
      packetBytes, table: cost.address, permanentlyLockedTableRentLamports: cost.rentLamports,
      setupSignature: setup.signature, launchSignature: launchOp.signature, collector }))
    await approvals.off()
  })

  test('asymmetric-burn curve buy/sell, reload and restart retain actual hook receipts', { timeout: 900_000 }, async ({ app, screen, browser }) => {
    const buyer = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint), approvals = await approveSignatures(browser)
    let before = await collected(), balance = await coinBalance(coin.mint, collector)
    await control('POST', '/rpc/faults', { holdNextSendMs: 8000 })
    await approveTrade(screen, '0.5', 'buy', app)
    await until('signed economic buy', async () => (await operations(buyer.address, 'native-buy'))[0]?.signature)
    await browser.reload()
    const [buy] = await finalizedOperations(buyer.address, 'native-buy', 1)
    await checkedTrade(buy, buyer.address, before, balance)
    await control('POST', '/site/restart', { recollect: false }); await app.open(`/hooks/token/${coin.mint}`)
    before = await collected(); balance = await coinBalance(coin.mint, collector)
    await approveTrade(screen, '100%', 'sell', app)
    const [sell] = await finalizedOperations(buyer.address, 'native-sell', 1)
    await checkedTrade(sell, buyer.address, before, balance); await tradeResult(screen, 'sell')
    expect(await coinBalance(coin.mint, buyer.address)).toBe(0n)
    console.log('ECONOMIC_RECOVERY', JSON.stringify({ hook: activeHook().program, mint: coin.mint,
      reloadDuringSignedBuy: buy.signature, sellAfterSiteRestart: sell.signature, sendOnceVerified: true }))
    await app.screenshot('economic-curve-tax-payout'); await approvals.off()
  })

  test('graduate via exact app buys, burn postgraduation trades and claim real quote fees', { timeout: 3_600_000 }, async ({ app, screen, browser }) => {
    // No historical deterministic curve/model2 fill helper: every fill is estimated,
    // reviewed and signed through the current app. Fail boundedly if graduation stalls.
    for (let i = 0; i < 100 && (await launchAccount(coin.launch)).value.status === 0; i++) {
      const buyer = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint, 400), approvals = await approveSignatures(browser)
      const before = await collected(), balance = await coinBalance(coin.mint, collector)
      await approveTrade(screen, 'Max', 'buy', app)
      const [op] = await finalizedOperations(buyer.address, 'native-buy', 1)
      await checkedTrade(op, buyer.address, before, balance)
      await tradeResult(screen, 'buy'); await approvals.off()
    }
    expect(graduationSeen).toBe(true)
    expect((await launchAccount(coin.launch)).value.status).toBe(1); expect((await poolAccount(coin.pool)).value.curve).toBe(false)
    const buyer = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint, 10), approvals = await approveSignatures(browser)
    for (const side of ['buy', 'sell'] as const) {
      const before = await collected(), balance = await coinBalance(coin.mint, collector)
      await approveTrade(screen, side === 'buy' ? '0.1' : '100%', side, app)
      const [op] = await finalizedOperations(buyer.address, `native-${side}`, 1)
      await checkedTrade(op, buyer.address, before, balance); await tradeResult(screen, side)
    }
    await app.screenshot('economic-postgraduation-tax-payout'); await approvals.off()
    expect(creatorAccrued > 0n).toBe(true)
    // Same-wallet author configuration folds the share away: claim all launch credits above rent,
    // not a model2 creator remainder or a second split of model1's gross creator cut.
    expect(await claimable(coin.launch)).toBe(creatorAccrued)
    const claim = await claimViaUi({ app, screen, browser }, coin.creator, { ...coin, symbol: SYMBOL }, creatorAccrued)
    expect(claim.amount).toBe(creatorAccrued)
    const claimed = one(authenticatedEvents(claim.tx), 'CreatorFeesClaimedSol')
    expect(claimed.launch.toBase58()).toBe(coin.launch); expect(claimed.creator.toBase58()).toBe(coin.address)
    expect(big(claimed.lamports)).toBe(creatorAccrued)
    expect(await claimable(coin.launch)).toBe(0n)
    expect(big((await poolAccount(coin.pool)).value.protocol_fees_quote)).toBe(platformAccrued)
    const { signature } = await control('POST', '/owner/stage', { stage: 'collect-native', mint: coin.mint })
    const collection = await receipt(signature)
    expect(collection.meta?.err).toBeNull()
    const collectedFees = one(authenticatedEvents(collection), 'ProtocolFeesCollected')
    expect(collectedFees.pool.toBase58()).toBe(coin.pool)
    expect(big(collectedFees.quote_amount)).toBe(platformAccrued)
    const recipient = collectedFees.collector.toBase58(), collectionFee = accountKeys(collection)[0] === recipient ? BigInt(collection.meta!.fee) : 0n
    expect(lamportDelta(collection, recipient)).toBe(platformAccrued - collectionFee)
    expect(lamportDelta(collection, coin.pool)).toBe(-platformAccrued)
    expect(big((await poolAccount(coin.pool)).value.protocol_fees_quote)).toBe(0n)
    console.log('ECONOMIC_LIFECYCLE', JSON.stringify({ hook: activeHook().program, mint: coin.mint,
      graduated: graduationSeen, postgraduationBuySellVerified: true, creatorClaimLamports: String(creatorAccrued),
      protocolCollectedLamports: String(platformAccrued), taxCollectedBaseUnits: String(await collected()),
      claimSignature: claim.tx.transaction.signatures[0], protocolCollectionSignature: signature }))
  })

  test('server rejects browser-supplied executable assertions before any new signing', async () => {
    const client = new SiteClient(coin.creator); await client.signIn()
    const before = (await operations(coin.address)).map(op => [op.id, op.signature])
    const response = await client.post('/api/hook-lab/hook-catalog', { action: 'select', digest: coin.reviewText, selectedHookPin: activeHook().pin })
    expect(response.status >= 400 && response.status < 500).toBe(true)
    expect((await operations(coin.address)).map(op => [op.id, op.signature])).toEqual(before)
  })
})
}
