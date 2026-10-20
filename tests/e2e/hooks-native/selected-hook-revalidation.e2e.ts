// Actual HTTP lifecycle negatives, independent of the positive selected-hook flow.
// Requires selected-hook mode and an already running local stack. No private
// custody reads, synthetic evidence, direct database writes, or runtime mocks.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { describe, expect } from 'e2e'
import { test } from '@e2e-dev/web'
import { connection, control, freshWallet, stack } from './support/stack.ts'
import { operations, signerAttempts } from './support/db.ts'
import { SiteClient } from './support/site-client.ts'
import { initializeSelectedRegistry, selected } from './support/selected-hook.ts'
import { receipt } from './support/chain.ts'

const endpoint = '/api/hook-lab/native-launch'
const sends = () => control<Record<string, number>>('GET', '/rpc/sends')

async function reviewedPreparation() {
  const hook = selected() // checks explicit mode and loopback before faucet/RPC
  const creator = await freshWallet(5), client = new SiteClient(creator)
  await client.signIn()
  const upload = await fetch(new URL('/api/hook-lab/coin-image', stack.origin), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
    headers: { origin: stack.origin, 'content-type': 'image/png', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.19.0.16' },
    body: readFileSync(new URL('./fixtures/coin.png', import.meta.url)),
  })
  expect(upload.status).toBe(200)
  const { image } = await upload.json()
  const selectedHook = { program: hook.pin.program, flags: hook.flags }
  const recorded = await client.post('/api/hook-lab/launch-requests', {
    action: 'create', requestId: randomUUID(), name: 'Revalidation Nongate', symbol: 'RECHECK',
    creatorFeeBps: 100, capBps: 0, selectedHook, image, description: '', x: '', website: '', telegram: '',
  })
  expect(recorded.status).toBe(200)
  const operationId = randomUUID(), signingId = randomUUID()
  const intent = { action: 'reserve', operationId, capBps: 0, selectedHook, label: 'RECHECK',
    name: 'Revalidation Nongate', symbol: 'RECHECK', uri: recorded.json.request.uri,
    virtualQuote: '53251917070', creatorFeeBps: 100 }
  const handoff = await client.post(endpoint, intent)
  expect(handoff.status).toBe(409)
  expect(handoff.json.blockers?.[0]?.code).toBe('SELECTED_HOOK_REGISTRY_REQUIRED')
  expect(typeof handoff.json.mint).toBe('string')
  expect((await receipt(await initializeSelectedRegistry(creator, handoff.json.mint))).meta?.err).toBeNull()
  const reserved = await client.post(endpoint, intent)
  expect(reserved.status).toBe(200)
  expect(reserved.json.mint).toBe(handoff.json.mint)
  const reviewed = await client.post(endpoint, { action: 'review', operationId, signingId, stage: 'preparation' })
  // A 409 here is an integration failure, not evidence of mutation refusal.
  expect(reviewed.status).toBe(200)
  expect(reviewed.json.operation.status).toBe('reviewed')
  const issued = await client.post(endpoint, { action: 'wallet-request', signingId })
  expect(issued.status).toBe(200)
  const wire = issued.json.partialTransactionBase64 as string
  const tx = VersionedTransaction.deserialize(Buffer.from(wire, 'base64'))
  expect(createHash('sha256').update(tx.message.serialize()).digest('hex')).toBe(reviewed.json.operation.messageSha256)
  expect(tx.signatures.every(signature => signature.every(byte => byte === 0))).toBe(true)
  const baseline = (await client.post(endpoint, { action: 'get', signingId })).json.operation
  expect(await signerAttempts(signingId)).toEqual([])
  return { creator, client, signingId, wire, baseline }
}

async function unchanged(fixture: Awaited<ReturnType<typeof reviewedPreparation>>) {
  const { client, signingId, baseline, creator } = fixture
  const retained = await client.post(endpoint, { action: 'get', signingId })
  expect(retained.status).toBe(200)
  expect(retained.json.operation).toEqual(baseline)
  const rows = await operations(creator.publicKey.toBase58(), 'preparation')
  expect(rows.length).toBe(1)
  expect(rows[0].message_sha256).toBe(baseline.messageSha256)
  expect(rows[0].signature).toBeNull()
  expect(await signerAttempts(signingId)).toEqual([])
}

describe('selected-hook actual application review revalidation', { serial: true }, () => {
  test('retain-wallet refuses valid wallet signatures over a changed blockhash or instruction without replacing the review', async () => {
    const fixture = await reviewedPreparation(), { client, creator, signingId, wire } = fixture
    const before = await sends()
    for (const mutation of ['blockhash', 'instruction']) {
      const tx = VersionedTransaction.deserialize(Buffer.from(wire, 'base64'))
      if (mutation === 'blockhash') {
        // A different, syntactically valid hash isolates exact-message binding;
        // this transaction is never sent to the validator.
        tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58()
      } else {
        const instruction = tx.message.compiledInstructions.find(ix => ix.data.length > 0)
        if (!instruction) throw Error('Reviewed preparation has no mutable instruction data')
        instruction.data[0] ^= 1
      }
      tx.sign([creator]) // real ed25519 signature of the substituted message
      expect(Buffer.from(tx.message.serialize()).equals(Buffer.from(VersionedTransaction.deserialize(Buffer.from(wire, 'base64')).message.serialize()))).toBe(false)
      const refused = await client.post(endpoint, { action: 'retain-wallet', signingId,
        signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64') })
      expect(refused.status).toBe(409)
      await unchanged(fixture)
      const issuedAgain = await client.post(endpoint, { action: 'wallet-request', signingId })
      expect(issuedAgain.status).toBe(200)
      expect(issuedAgain.json.partialTransactionBase64).toBe(wire)
    }
    expect(await sends()).toEqual(before)
  })

  test('owner creation pause changes the pinned launch config after review and refuses server cosign/send', async () => {
    const fixture = await reviewedPreparation(), { client, creator, signingId, wire } = fixture
    const config = PublicKey.findProgramAddressSync([Buffer.from('config')], new PublicKey(stack.programs!.launch))[0]
    const before = await connection.getAccountInfo(config, 'finalized')
    expect(before).not.toBeNull()
    const tx = VersionedTransaction.deserialize(Buffer.from(wire, 'base64'))
    tx.sign([creator])
    const retained = await client.post(endpoint, { action: 'retain-wallet', signingId,
      signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64') })
    expect(retained.status).toBe(200)
    expect(retained.json.operation.status).toBe('partial')
    fixture.baseline = retained.json.operation
    try {
      const paused = await control('POST', '/owner/stage', { stage: 'guardian-pause', pause: 'creation' })
      expect((await receipt(paused.signature)).meta?.err).toBeNull()
      const after = await connection.getAccountInfo(config, 'finalized')
      expect(after).not.toBeNull()
      expect(Buffer.from(after!.data).equals(Buffer.from(before!.data))).toBe(false)
      // Exclude the supported owner's transaction from application send counts.
      const sendsAfterPause = await sends()
      for (const action of ['wallet-request', 'cosign', 'submit']) {
        const refused = await client.post(endpoint, { action, signingId })
        expect(refused.status).toBe(409)
        await unchanged(fixture)
      }
      expect(await sends()).toEqual(sendsAfterPause)
    } finally {
      // Restore through the same supported owner interface, even on failure.
      const reopened = await control('POST', '/owner/stage', { stage: 'open-launches' })
      expect((await receipt(reopened.signature)).meta?.err).toBeNull()
      const restored = await connection.getAccountInfo(config, 'finalized')
      expect(Buffer.from(restored!.data).equals(Buffer.from(before!.data))).toBe(true)
      // Reopening restores Config but advances creation-control governance.
      // Later reviews must use a freshly collected local operator dossier;
      // leaving the pre-pause dossier installed correctly refuses new reviews.
      await control('POST', '/site/restart', { recollect: true })
    }
  })
})
