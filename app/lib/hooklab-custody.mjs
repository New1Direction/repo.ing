import bs58 from 'bs58'

// Client-only: the recipe planner may retain identities; no server route imports this.
// This module has no signing, sending, RPC, secret export, or execution-enable API.
export const hookLabCustodyCapabilities = Object.freeze({ execution: false, signing: false, sending: false })
const FORMAT = 'hooklab-custody/1'
const ITERATIONS = 600000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const fail = message => { throw new Error(message) }
const cryptoApi = () => globalThis.crypto?.subtle ? globalThis.crypto : fail('Web Crypto in a secure context is required')
const clone = value => structuredClone(value)
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function base64(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(text)
}
function unbase64(value) {
  if (typeof value !== 'string' || value.length > 2000000) fail('Invalid base64')
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0))
  if (base64(bytes) !== value) fail('Noncanonical base64')
  return bytes
}
function address(value) {
  if (typeof value !== 'string' || value.length > 44 || bs58.decode(value).length !== 32) fail('Invalid public key or genesis hash')
  return value
}
function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('Expected SHA-256 digest')
  return value
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('Expected nonnegative safe integer')
  return value
}
function label(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('Invalid record identifier')
  return value
}
function pins(items, required) {
  if (!Array.isArray(items) || (required && !items.length)) fail('Missing identity pins')
  const result = items.map(item => ({ address: address(item.address), sha256: digest(item.sha256) })).sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0)
  if (new Set(result.map(item => item.address)).size !== result.length) fail('Duplicate identity pin')
  return result
}
export function normalizeHookLabBinding(value) {
  if (value?.schemaVersion !== 'hooklab-binding/1') fail('Unsupported binding version')
  return freeze({
    schemaVersion: value.schemaVersion, wallet: address(value.wallet), genesisHash: address(value.genesisHash),
    recipeDigest: digest(value.recipeDigest), manifestDigest: digest(value.manifestDigest),
    programs: pins(value.programs, true), configs: pins(value.configs, false),
  })
}
const sameBinding = (a, b) => JSON.stringify(a) === JSON.stringify(b)
async function hash(bytes) {
  return Array.from(new Uint8Array(await cryptoApi().subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}
async function derive(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 16) fail('Use a strong recovery passphrase of at least 16 characters')
  const bytes = encoder.encode(passphrase)
  try {
    const material = await cryptoApi().subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey'])
    return await cryptoApi().subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  } finally { bytes.fill(0) }
}
const aad = id => encoder.encode(`${FORMAT}:${id}`)
async function encrypt(state, key, salt) {
  const iv = cryptoApi().getRandomValues(new Uint8Array(12))
  const bytes = encoder.encode(JSON.stringify(state))
  try {
    if (bytes.length > 1000000) fail('Custody journal capacity reached; retain existing record')
    const ciphertext = new Uint8Array(await cryptoApi().subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(state.id) }, key, bytes))
    return JSON.stringify({ schemaVersion: FORMAT, salt: base64(salt), iv: base64(iv), ciphertext: base64(ciphertext) })
  } finally { bytes.fill(0) }
}
async function identity() {
  const pair = await cryptoApi().subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const privateBytes = new Uint8Array(await cryptoApi().subtle.exportKey('pkcs8', pair.privateKey))
  try {
    return { publicKey: bs58.encode(new Uint8Array(await cryptoApi().subtle.exportKey('raw', pair.publicKey))), privateKeyPkcs8: base64(privateBytes) }
  } finally { privateBytes.fill(0) }
}
function publicSnapshot(state) {
  // Explicit allowlist: do not spread the private state into a serializable object.
  return freeze(clone({ schemaVersion: FORMAT, id: state.id, revision: state.revision, binding: state.binding,
    identities: { mint: state.identities.mint.publicKey, config: state.identities.config.publicKey },
    events: state.events, executionEnabled: false }))
}

export async function createHookLabCustody({ store, id, binding, passphrase }) {
  label(id)
  binding = normalizeHookLabBinding(binding)
  if (await store.load(id) !== null) fail('Custody already exists; unlock it rather than regenerate identities')
  const salt = cryptoApi().getRandomValues(new Uint8Array(16))
  const key = await derive(passphrase, salt)
  const state = { schemaVersion: FORMAT, id, binding, revision: 0, identities: { mint: await identity(), config: await identity() }, events: [] }
  const persisted = await encrypt(state, key, salt)
  if (!await store.compareAndSwap(id, null, persisted)) fail('Custody already exists; unlock it rather than regenerate identities')
  return session(store, state, key, salt, persisted)
}

export async function unlockHookLabCustody({ store, id, passphrase, binding }) {
  label(id)
  // A disconnected wallet may unlock history, but cannot regain review consent.
  binding = binding === null ? null : normalizeHookLabBinding(binding)
  const persisted = await store.load(id)
  if (persisted === null) fail('Custody not found; no replacement identity was generated')
  const envelope = JSON.parse(persisted)
  if (envelope.schemaVersion !== FORMAT) fail('Unsupported custody version')
  const salt = unbase64(envelope.salt), iv = unbase64(envelope.iv)
  if (salt.length !== 16 || iv.length !== 12) fail('Invalid custody envelope')
  const key = await derive(passphrase, salt)
  let bytes, state
  try {
    bytes = new Uint8Array(await cryptoApi().subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(id) }, key, unbase64(envelope.ciphertext)))
    state = JSON.parse(decoder.decode(bytes))
    if (state.schemaVersion !== FORMAT || state.id !== id || state.revision !== state.events.length) fail('Invalid custody journal')
    normalizeHookLabBinding(state.binding)
  } catch { fail('Unable to unlock custody: wrong passphrase or damaged record') }
  finally { bytes?.fill(0) }
  const opened = session(store, state, key, salt, persisted)
  try { await opened.checkBinding(binding); return opened }
  catch (error) { opened.lock(); throw error }
}

function session(store, initial, initialKey, salt, initialPersisted) {
  let state = initial, key = initialKey, persisted = initialPersisted, closed = false, invalidating = false
  let queue = Promise.resolve()
  const assertOpen = () => { if (closed) fail('Custody is locked; unlock again') }
  const assertActive = () => {
    assertOpen()
    if (invalidating || state.events.some(event => event.type === 'binding-invalidated')) fail('Wallet or plan binding invalidated; only recovery observations can be appended')
  }
  const review = stepId => state.events.find(event => event.type === 'reviewed' && event.stepId === stepId) ?? fail('Step has no immutable review')
  function append(build) {
    const work = queue.then(async () => {
      assertOpen()
      const event = await build()
      assertOpen()
      const next = { ...state, revision: state.revision + 1, events: [...state.events, { ...event, sequence: state.revision + 1 }] }
      const encrypted = await encrypt(next, key, salt)
      assertOpen()
      if (event.type === 'reviewed') assertActive()
      if (!await store.compareAndSwap(state.id, persisted, encrypted)) {
        closed = true; key = null; state = null
        fail('Custody changed in another session; unlock the latest record')
      }
      // lock() may have run while the durable write completed. Do not reopen the session.
      if (closed) fail('Custody locked during write; reload to inspect its durable outcome')
      state = next; persisted = encrypted
      return publicSnapshot(state)
    })
    queue = work.catch(() => {})
    return work
  }
  return Object.freeze({
    snapshot() { assertOpen(); return publicSnapshot(state) },
    publicIdentity() {
      assertOpen()
      return freeze(clone({ schemaVersion: 'hooklab-public-identity/1', id: state.id, binding: state.binding,
        mint: state.identities.mint.publicKey, config: state.identities.config.publicKey }))
    },
    lock() { closed = true; key = null; state = null; persisted = null },
    checkBinding(current) {
      assertOpen()
      let normalized
      try { normalized = current === null ? null : normalizeHookLabBinding(current) }
      catch { normalized = null } // Malformed/unknown wallet context revokes consent too.
      if (normalized && sameBinding(state.binding, normalized) && !invalidating) return Promise.resolve(publicSnapshot(state))
      invalidating = true // Stop new reviews even if persistence fails; keep recovery evidence.
      if (state.events.some(event => event.type === 'binding-invalidated')) return Promise.resolve(publicSnapshot(state))
      return append(() => ({ type: 'binding-invalidated', reason: normalized ? 'binding-changed' : 'wallet-disconnected' }))
    },
    recordReview(input) {
      const data = clone(input) // Detach before the first await; caller mutations cannot change reviewed bytes.
      return append(async () => {
        assertActive()
        const stepId = label(data.stepId)
        if (state.events.some(event => event.type === 'reviewed' && event.stepId === stepId)) fail('Reviewed step is immutable')
        if (!(data.messageBytes instanceof Uint8Array) || !data.messageBytes.length || data.messageBytes.length > 1232) fail('Invalid reviewed message bytes')
        const expiry = { blockhash: address(data.expiry.blockhash), lastValidBlockHeight: integer(data.expiry.lastValidBlockHeight) }
        const reviewedAtBlockHeight = integer(data.reviewedAtBlockHeight)
        if (reviewedAtBlockHeight > expiry.lastValidBlockHeight) fail('Review is already expired')
        if (!Array.isArray(data.requiredSigners) || !data.requiredSigners.length) fail('Required signers are missing')
        const requiredSigners = data.requiredSigners.map(address)
        const allowed = [state.binding.wallet, state.identities.mint.publicKey, state.identities.config.publicKey]
        if (requiredSigners[0] !== state.binding.wallet || new Set(requiredSigners).size !== requiredSigners.length || requiredSigners.some(signer => !allowed.includes(signer))) fail('Unexpected signer or fee payer')
        return { type: 'reviewed', stepId, messageBase64: base64(data.messageBytes), messageSha256: await hash(data.messageBytes), expiry, reviewedAtBlockHeight, requiredSigners }
      })
    },
    recordSignature(input) {
      const data = clone(input)
      return append(async () => {
        const reviewed = review(data.stepId), signer = address(data.signer)
        if (!reviewed.requiredSigners.includes(signer)) fail('Signer was not reviewed')
        if (state.events.some(event => event.type === 'signature-recorded' && event.stepId === data.stepId && event.signer === signer)) fail('Signature record is immutable')
        const observedBlockHeight = integer(data.observedBlockHeight)
        // Recording an already-existing signature after expiry must not lose recovery evidence.
        if (observedBlockHeight < reviewed.reviewedAtBlockHeight) fail('Signature observation predates review')
        if (!(data.signatureBytes instanceof Uint8Array) || data.signatureBytes.length !== 64) fail('Invalid signature bytes')
        const publicKey = await cryptoApi().subtle.importKey('raw', bs58.decode(signer), 'Ed25519', false, ['verify'])
        if (!await cryptoApi().subtle.verify('Ed25519', publicKey, data.signatureBytes, unbase64(reviewed.messageBase64))) fail('Signature does not match the immutable reviewed bytes')
        return { type: 'signature-recorded', stepId: data.stepId, signer, signature: bs58.encode(data.signatureBytes), observedBlockHeight }
      })
    },
    recordSubmissionObservation({ stepId, signature }) {
      return append(() => {
        const reviewed = review(stepId)
        const signatures = state.events.filter(event => event.type === 'signature-recorded' && event.stepId === stepId)
        if (!reviewed.requiredSigners.every(signer => signatures.some(event => event.signer === signer))) fail('Missing reviewed signatures')
        if (signature !== signatures.find(event => event.signer === reviewed.requiredSigners[0]).signature) fail('Submission signature does not match reviewed fee payer')
        if (state.events.some(event => event.type === 'submission-unknown' && event.stepId === stepId)) fail('Submission observation already recorded')
        return { type: 'submission-unknown', stepId, signature }
      })
    },
  })
}
