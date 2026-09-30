import test from 'node:test'
import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { NOTE_LIMITS, NOTE_MAX_CHARS, NoteError, createHolderNotes, noteChallenge, noteHash, noteMessage, sanitizeNote, verifyNoteRequest } from '../src/holder-notes.mjs'
import { blockedWord } from '../src/note-blocklist.mjs'
import { createBalanceCache, noteAtaAddresses, readAtaBalances, sumAtaBalances } from '../app/lib/holder-note-balances.mjs'
import { NOTE_MAX, holdingLabel, publicNote, shortWallet } from '../app/lib/holder-note-format.mjs'

const MINT = Keypair.generate().publicKey.toBase58()
const MARKET = { mint: MINT, pool: Keypair.generate().publicKey.toBase58(), repoId: '42' }

// Solana signMessage is a raw ed25519 signature over the UTF-8 message.
const signMessage = (keypair, message) => {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.subarray(0, 32))])
  return sign(null, Buffer.from(message, 'utf8'), { key: pkcs8, format: 'der', type: 'pkcs8' }).toString('base64')
}
const rejects = (fn, pattern) => assert.throws(fn, error => error instanceof NoteError && pattern.test(error.message))

test('sanitizing collapses whitespace, strips control and invisible characters, and enforces 1–280 characters', () => {
  assert.equal(sanitizeNote('  Great\n\n\tmaintainers\u0000 and   docs ​‮ '), 'Great maintainers and docs')
  assert.equal(sanitizeNote('é'), 'é')
  assert.equal(sanitizeNote('🚀'.repeat(NOTE_MAX_CHARS)), '🚀'.repeat(NOTE_MAX_CHARS))
  rejects(() => sanitizeNote('a'.repeat(NOTE_MAX_CHARS + 1)), /280 characters/)
  rejects(() => sanitizeNote(' \n​ '), /Write a short note/)
  rejects(() => sanitizeNote(42), /Write a short note/)
  rejects(() => sanitizeNote('x'.repeat(5000)), /280 characters/)
  assert.equal(NOTE_MAX, NOTE_MAX_CHARS)
})

test('HTML is rejected; comparisons and hearts are plain text', () => {
  for (const text of ['<b>bold</b>', 'hi <img src=x onerror=alert(1)>', '<!-- x -->', 'a &amp; b', '&#60;script'])
    rejects(() => sanitizeNote(text), /plain text/)
  assert.equal(sanitizeNote('a < b and c > d <3'), 'a < b and c > d <3')
})

test('URL rule: only github.com links pass; everything link-like elsewhere is blocked', () => {
  for (const text of ['Read github.com/foo/bar', 'https://github.com/foo/bar/issues/1.', 'see www.github.com/x', 'node.js port v1.2.3, e.g. faster'])
    assert.equal(sanitizeNote(text), text)
  for (const text of ['buy at https://evil.io', 'pump.fun/abc', 'join t.me/scam', 'github.com.evil.io/login', 'https://github.com.evil.io',
    'http://github.com@evil.xyz', 'raw.githubusercontent.com/x', 'discord.gg/free', 'ftp://files.example', 'www.example.org', 'claim.sol airdrop'])
    rejects(() => sanitizeNote(text), /Links are not allowed/)
})

test('small local blocklist catches slurs incl. leetspeak, without flagging innocent words', () => {
  assert.equal(blockedWord('you f4gg0t'), true)
  assert.equal(blockedWord('k!ke'), true)
  assert.equal(blockedWord('R E T A R D'), false)
  assert.equal(blockedWord('what a retard'), true)
  assert.equal(blockedWord('Retards!'), true)
  for (const text of ['raccoon', 'spices', 'Scunthorpe', 'cocoon', 'Niger delta', 'skunk'])
    assert.equal(blockedWord(text), false, text)
  rejects(() => sanitizeNote('holders are retards'), /respectful/)
})

test('signature: valid, wrong wallet, tampered note, expired, and delete messages', () => {
  const owner = Keypair.generate(), other = Keypair.generate()
  let t = 1_000_000
  const now = () => t
  const { terms, message } = noteChallenge({ wallet: owner.publicKey.toBase58(), mint: MINT, text: ' Solid  maintainers ', now })
  assert.match(message, new RegExp(`Mint: ${MINT}`))
  assert.match(message, new RegExp(`Note SHA-256: ${noteHash('Solid maintainers')}`))
  assert.match(message, new RegExp(`Nonce: ${terms.nonce}`))
  assert.equal(noteMessage(terms), message)
  const ok = verifyNoteRequest(terms, signMessage(owner, message), 'Solid maintainers', now)
  assert.deepEqual([ok.action, ok.wallet, ok.mint, ok.body], ['post', owner.publicKey.toBase58(), MINT, 'Solid maintainers'])
  rejects(() => verifyNoteRequest(terms, signMessage(other, message), 'Solid maintainers', now), /Invalid Solana wallet signature/)
  rejects(() => verifyNoteRequest({ ...terms, wallet: other.publicKey.toBase58() }, signMessage(owner, message), 'Solid maintainers', now), /Invalid Solana wallet signature/)
  rejects(() => verifyNoteRequest({ ...terms, mint: Keypair.generate().publicKey.toBase58() }, signMessage(owner, message), 'Solid maintainers', now), /Invalid Solana wallet signature/)
  rejects(() => verifyNoteRequest(terms, signMessage(owner, message), 'Different note', now), /changed after signing/)
  rejects(() => verifyNoteRequest(terms, 'AAAA', 'Solid maintainers', now), /Invalid Solana wallet signature/)
  t += 5 * 60 * 1000
  rejects(() => verifyNoteRequest(terms, signMessage(owner, message), 'Solid maintainers', now), /expired/)
  const del = noteChallenge({ wallet: owner.publicKey.toBase58(), mint: MINT, action: 'delete', now })
  assert.doesNotMatch(del.message, /SHA-256/)
  assert.equal(verifyNoteRequest(del.terms, signMessage(owner, del.message), undefined, now).action, 'delete')
  rejects(() => noteChallenge({ wallet: 'not-a-key', mint: MINT, text: 'x' }), /Invalid wallet/)
  rejects(() => noteChallenge({ wallet: owner.publicKey.toBase58(), mint: MINT, action: 'publish', text: 'x' }), /Invalid note action/)
})

// In-memory store with the same contract as createNoteStore (see the PostgreSQL test below for the SQL).
function fakeStore({ buyers = [] } = {}) {
  const notes = new Map(), nonces = new Set(), hits = new Map(), calls = []
  return { notes, calls,
    async takeQuota(scopes) {
      for (const [scope, limit] of scopes) { const n = hits.get(scope) ?? 0; if (n >= limit) return false; hits.set(scope, n + 1) }
      return true
    },
    async hasBought(market, wallet) { calls.push(['hasBought', market.mint, wallet]); return buyers.includes(wallet) },
    async consumeNonce(nonce) { if (nonces.has(nonce)) return false; nonces.add(nonce); return true },
    async upsert({ mint, wallet, body, balance }) {
      const note = { id: String(notes.get(`${mint}:${wallet}`)?.id ?? notes.size + 1), wallet, body, balanceAtPost: balance.toString(), hidden: false }
      notes.set(`${mint}:${wallet}`, note)
      return note
    },
    async remove(mint, wallet) { return notes.delete(`${mint}:${wallet}`) },
  }
}

async function signedPost(service, keypair, text, ip = 'ip-1') {
  const { terms, message } = await service.challenge({ market: MARKET, wallet: keypair.publicKey.toBase58(), action: 'post', text, ip })
  return { terms, signature: signMessage(keypair, message) }
}
const rejectsAsync = (promise, status, pattern) => assert.rejects(promise, error => error instanceof NoteError && error.status === status && pattern.test(error.message))

test('posting requires holding the token now AND an indexed buy in this market', async () => {
  const holderBuyer = Keypair.generate(), buyerSold = Keypair.generate(), holderNoBuy = Keypair.generate()
  const balances = { [holderBuyer.publicKey.toBase58()]: 5_000_000n, [buyerSold.publicKey.toBase58()]: 0n, [holderNoBuy.publicKey.toBase58()]: 9n }
  const store = fakeStore({ buyers: [holderBuyer.publicKey.toBase58(), buyerSold.publicKey.toBase58()] })
  const reads = []
  const service = createHolderNotes({ store, readBalance: async (wallet, mint) => { reads.push([wallet, mint]); return balances[wallet] } })
  await rejectsAsync(signedPost(service, buyerSold, 'sold already'), 403, /Hold this token/)
  await rejectsAsync(signedPost(service, holderNoBuy, 'airdropped'), 403, /bought this token here/)
  const request = await signedPost(service, holderBuyer, 'Great maintainers')
  assert.deepEqual(reads.at(-1), [holderBuyer.publicKey.toBase58(), MINT])
  // Balance is re-read at submit time: selling between challenge and submit blocks the post.
  balances[holderBuyer.publicKey.toBase58()] = 0n
  await rejectsAsync(service.submit({ market: MARKET, ...request, text: 'Great maintainers', ip: 'ip-1' }), 403, /Hold this token/)
  balances[holderBuyer.publicKey.toBase58()] = 7_000_000n
  const { note } = await service.submit({ market: MARKET, ...request, text: 'Great maintainers', ip: 'ip-1' })
  assert.deepEqual([note.body, note.balanceAtPost], ['Great maintainers', '7000000'])
})

test('nonce is single use; one note per wallet is updated in place; delete needs its own signature', async () => {
  const wallet = Keypair.generate(), key = wallet.publicKey.toBase58()
  const store = fakeStore({ buyers: [key] })
  const service = createHolderNotes({ store, readBalance: async () => 1_000_000n })
  const first = await signedPost(service, wallet, 'First take')
  await service.submit({ market: MARKET, ...first, text: 'First take', ip: 'ip-1' })
  await rejectsAsync(service.submit({ market: MARKET, ...first, text: 'First take', ip: 'ip-1' }), 409, /already used/)
  const second = await signedPost(service, wallet, 'Edited take')
  const { note } = await service.submit({ market: MARKET, ...second, text: 'Edited take', ip: 'ip-1' })
  assert.equal(store.notes.size, 1)
  assert.equal(note.body, 'Edited take')
  // A signature for another market cannot be used here.
  const other = { ...MARKET, mint: Keypair.generate().publicKey.toBase58() }
  const third = await signedPost(service, wallet, 'Wrong market')
  await rejectsAsync(service.submit({ market: other, ...third, text: 'Wrong market', ip: 'ip-1' }), 400, /Invalid note request/)
  const del = await service.challenge({ market: MARKET, wallet: key, action: 'delete', ip: 'ip-1' })
  assert.deepEqual(await service.submit({ market: MARKET, terms: del.terms, signature: signMessage(wallet, del.message), ip: 'ip-1' }), { deleted: true })
  assert.equal(store.notes.size, 0)
})

test('per-wallet and per-IP rate limits', async () => {
  const wallet = Keypair.generate(), key = wallet.publicKey.toBase58()
  const service = createHolderNotes({ store: fakeStore({ buyers: [key] }), readBalance: async () => 1n })
  for (let i = 0; i < NOTE_LIMITS.walletWrites; i++) {
    const request = await signedPost(service, wallet, `take ${i}`, `ip-${i}`)
    await service.submit({ market: MARKET, ...request, text: `take ${i}`, ip: `ip-${i}` })
  }
  const request = await signedPost(service, wallet, 'one more', 'ip-fresh')
  await rejectsAsync(service.submit({ market: MARKET, ...request, text: 'one more', ip: 'ip-fresh' }), 429, /Too many/)
  const busyIp = createHolderNotes({ store: fakeStore({ buyers: [key] }), readBalance: async () => 1n })
  for (let i = 0; i < NOTE_LIMITS.ipRequests; i++) await busyIp.challenge({ market: MARKET, wallet: key, action: 'delete', ip: 'same' })
  await rejectsAsync(busyIp.challenge({ market: MARKET, wallet: key, action: 'delete', ip: 'same' }), 429, /Too many/)
})

test('holder badges: ATAs for both token programs, batched and cached ~5 minutes; unknown is never "sold"', async () => {
  const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58()
  const entries = noteAtaAddresses(MINT, [a, b])
  assert.deepEqual(entries.map(e => e.address.toBase58()), [
    getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(a), true, TOKEN_PROGRAM_ID).toBase58(),
    getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(a), true, TOKEN_2022_PROGRAM_ID).toBase58(),
    getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(b), true, TOKEN_PROGRAM_ID).toBase58(),
    getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(b), true, TOKEN_2022_PROGRAM_ID).toBase58()])
  const account = (owner, amount, mint = MINT) => { const data = Buffer.alloc(165); new PublicKey(mint).toBuffer().copy(data, 0); new PublicKey(owner).toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64); return { data } }
  assert.deepEqual(sumAtaBalances(MINT, entries, [account(a, 5n), account(a, 2n), null, account(a, 99n)]), new Map([[a, 7n], [b, 0n]]))
  assert.equal(sumAtaBalances(MINT, entries.slice(0, 1), [account(a, 5n, Keypair.generate().publicKey.toBase58())]).get(a), 0n)

  const calls = []
  const connection = { getMultipleAccountsInfo: async keys => { calls.push(keys.length); return keys.map(() => null) } }
  const many = Array.from({ length: 60 }, () => Keypair.generate().publicKey.toBase58())
  await readAtaBalances(connection, MINT, many)
  assert.deepEqual(calls, [100, 20])

  let t = 0, fetches = []
  const current = { [a]: 3n, [b]: 0n }
  const cache = createBalanceCache({ clock: () => t, fetchBalances: async (mint, wallets) => { fetches.push(wallets); return new Map(wallets.map(w => [w, current[w]])) } })
  assert.deepEqual(await cache(MINT, [a, b, a]), new Map([[a, 3n], [b, 0n]]))
  assert.deepEqual(await cache(MINT, [a, b]), new Map([[a, 3n], [b, 0n]]))
  assert.deepEqual(fetches, [[a, b]])
  t += 5 * 60 * 1000 + 1
  current[a] = 0n
  assert.equal((await cache(MINT, [a])).get(a), 0n)
  assert.deepEqual(fetches, [[a, b], [a]])
  const failing = createBalanceCache({ fetchBalances: async () => { throw Error('rpc down') } })
  assert.equal((await failing(MINT, [a])).get(a), null)

  const note = { id: '1', wallet: a, body: 'x', updatedAt: new Date(0), balanceAtPost: '5000000' }
  assert.deepEqual([publicNote(note, 0n).sold, publicNote(note, null).sold, publicNote(note, null).balance, publicNote(note, 2n).balance], [true, false, '5000000', '2'])
  assert.equal(holdingLabel('1234567000000'), '1.2M')
  assert.equal(holdingLabel('12500000'), '12.5')
  assert.equal(holdingLabel('1'), '<0.01')
  assert.equal(shortWallet(a), `${a.slice(0, 4)}…${a.slice(-4)}`)
})

// Real SQL against a throwaway local database (all committed migrations): buyer check, one-per-wallet upsert, replayed
// nonces, quota exhaustion, and hidden notes excluded from public reads.
const url = process.env.HOLDER_NOTES_TEST_DATABASE_URL
test('real PostgreSQL: holder notes store', { skip: !url }, async () => {
  const [{ default: pg }, { drizzle }, { migrate }, { createNoteStore }] = await Promise.all([import('pg'), import('drizzle-orm/node-postgres'),
    import('drizzle-orm/node-postgres/migrator'), import('../src/holder-notes.mjs')])
  assert.equal(new URL(url).hostname, '127.0.0.1')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    const repoId = 990000 + Math.floor(Math.random() * 9999), mint = Keypair.generate().publicKey.toBase58(), poolKey = Keypair.generate().publicKey.toBase58()
    const [curveBuyer, dammBuyer, seller, stranger] = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58())
    await pool.query("insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values($1,'local','notes','local/notes',1,0,false,now())", [repoId])
    await pool.query("insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol) values($1,'prepared',$2,$3,'w','c','Notes','NOTE')", [repoId, mint, poolKey])
    await pool.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price,trader)
      values($1,$2,0,1,now(),'buy','1','1','1',$3),($1,$2,1,1,now(),'sell','1','1','1',$4)`, [poolKey, `sig${repoId}`, curveBuyer, seller])
    await pool.query(`insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,trader)
      values($1,$2,$3,0,1,now(),5,'buy','{}',$4)`, [repoId, poolKey, `damm${repoId}`, dammBuyer])
    const store = createNoteStore(pool), market = { mint, pool: poolKey }
    assert.deepEqual(await Promise.all([curveBuyer, dammBuyer, seller, stranger].map(w => store.hasBought(market, w))), [true, true, false, false])

    await store.upsert({ mint, wallet: curveBuyer, body: 'first', balance: 5n })
    const edited = await store.upsert({ mint, wallet: curveBuyer, body: 'edited', balance: 6n })
    assert.deepEqual([edited.body, edited.balanceAtPost, edited.hidden], ['edited', '6', false])
    const { rows: [{ n }] } = await pool.query('select count(*)::int n from holder_notes where mint=$1', [mint])
    assert.equal(n, 1)
    await assert.rejects(pool.query("insert into holder_notes(mint,wallet,body,balance_at_post) values($1,'x',$2,1)", [mint, 'a'.repeat(281)]))

    const dammNote = await store.upsert({ mint, wallet: dammBuyer, body: 'damm', balance: 1n })
    assert.deepEqual((await store.list(mint)).notes.map(x => x.body), ['damm', 'edited'])
    await store.setHidden(dammNote.id, true, 'github:1')
    assert.deepEqual((await store.list(mint)).notes.map(x => x.body), ['edited'])
    assert.equal((await store.upsert({ mint, wallet: dammBuyer, body: 'try again', balance: 1n })).hidden, true)
    assert.equal(await store.remove(mint, dammBuyer), false)
    assert.deepEqual((await store.list(mint)).notes.map(x => x.body), ['edited'])
    assert.equal((await store.own(mint, dammBuyer)).hidden, true)
    assert.equal((await store.recent(50)).find(x => x.id === dammNote.id).hiddenBy, 'github:1')
    await store.setHidden(dammNote.id, false, 'github:1')
    assert.equal((await store.list(mint)).notes.length, 2)
    await assert.rejects(store.setHidden('999999999', true, 'x'), /not found/)
    assert.equal(await store.remove(mint, curveBuyer), true)

    for (let i = 0; i < 11; i++) await store.upsert({ mint, wallet: Keypair.generate().publicKey.toBase58(), body: `n${i}`, balance: 1n })
    const page = await store.list(mint)
    assert.equal(page.notes.length, 10)
    assert.equal(page.hasMore, true)
    assert.deepEqual([(await store.list(mint, { offset: 10 })).notes.length, (await store.list(mint, { offset: 10 })).hasMore], [2, false])

    const nonce = Keypair.generate().publicKey.toBuffer().toString('hex').slice(0, 32), later = new Date(Date.now() + 60_000)
    assert.equal(await store.consumeNonce(nonce, later), true)
    assert.equal(await store.consumeNonce(nonce, later), false)

    const scope = `note-test:${repoId}`
    assert.equal(await store.takeQuota([[scope, 2, 60]]), true)
    assert.equal(await store.takeQuota([[scope, 2, 60]]), true)
    assert.equal(await store.takeQuota([[scope, 2, 60]]), false)
  } finally { await pool.end() }
})
