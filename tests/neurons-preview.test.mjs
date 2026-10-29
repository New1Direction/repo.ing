import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { characterPersona, findPersona, searchPersonas, validateNeuronDraft } from '../app/lib/neurons-preview.mjs'
import { PERSONALITY_IMPORT_TEMPLATE, PERSONALITY_IMPORT_DRAFT_KEY } from '../app/lib/neuron-import.mjs'

const { NeuronsLibrary, NeuronCharacterPreview, NeuronLaunchPreview } = await appModule('app/components/neurons-preview.jsx')
const documentFor = element => new JSDOM(html(element)).window.document

test('library search combines case-insensitive names/tickers, source DNA and category', () => {
  assert.deepEqual(searchPersonas(' bEaN ').map(value => value.id), ['coffee-bean'])
  assert.deepEqual(searchPersonas('9:166').map(value => value.id), ['coffee-bean'])
  assert.deepEqual(searchPersonas('$BEAN').map(value => value.id), ['coffee-bean'])
  assert.deepEqual(searchPersonas('caffeinated').map(value => value.id), ['coffee-bean'])
  assert.deepEqual(searchPersonas('queen', 'People'), [])
  assert.deepEqual(searchPersonas('', 'Fantasy').map(value => value.id), ['ancient-ghost', 'red-queen'])
  assert.deepEqual(searchPersonas('not-a-persona'), [])
  const doc = documentFor(h(NeuronsLibrary))
  assert.equal(doc.querySelectorAll('article').length, 6)
  assert.equal(doc.querySelector('nav a[aria-current="page"]').getAttribute('href'), '/neurons')
  assert.ok(doc.querySelector('input[aria-label="Search personas"]'))
})

test('imported profiles expose their recipe and provenance without borrowing preset chat or implying token execution', () => {
  const personality = { ...structuredClone(PERSONALITY_IMPORT_TEMPLATE), model: { id: 'Qwen/Qwen3-8B', revision: 'b'.repeat(40) },
    examples: [{ prompt: 'Your name?', reply: '<script>Never execute me</script>' }] }
  const character = { id: '70621973-a55f-41dc-b90e-5aba6eec1fc9', name: personality.name, ticker: personality.ticker,
    story: personality.story, personality, creatorWallet: 'PublicCreatorWallet', metadataSha256: 'c'.repeat(64), reviewedAt: '2026-10-29T12:00:00Z' }
  const library = documentFor(h(NeuronsLibrary, { publishedCharacters: [character] }))
  const card = library.querySelector('section[aria-label="Published characters"] article')
  assert.match(card.textContent, /IMPORTED RECIPE · UNVERIFIED/)
  assert.match(card.textContent, /Attributed to Your name or handle/)
  assert.ok(card.querySelector(`a[href="/api/neuron-characters?export=${character.id}"]`))
  assert.ok(library.querySelector('a[href="/neurons/import"]'))
  const profile = documentFor(h(NeuronCharacterPreview, { persona: characterPersona(character), character }))
  assert.equal(profile.querySelector('h1').textContent, personality.name)
  assert.ok(profile.querySelector('section[aria-label="Imported personality chat unavailable"]'))
  assert.equal(profile.querySelector('textarea'), null)
  assert.equal(profile.querySelector('[role="log"]'), null)
  assert.equal(profile.querySelector('script'), null)
  assert.ok(profile.body.textContent.includes(personality.model.revision))
  assert.match(profile.body.textContent, /not verification of the model revision/)
  assert.ok([...profile.querySelectorAll('button')].find(button => button.textContent.includes('Buying available')).disabled)
})

test('personality import validates before review, recovers separately, and submits only the reviewed data with retry safety', async () => {
  const { act } = await import('react')
  const { NeuronPersonalityImport } = await appModule('app/components/neuron-import.jsx')
  const { WalletProvider } = await appModule('app/components/wallet.jsx')
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://repo.ing/neurons/import' })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    self: dom.window, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const originalFetch = globalThis.fetch, requests = []
  let root
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    const personality = { ...structuredClone(PERSONALITY_IMPORT_TEMPLATE), model: { id: 'Qwen/Qwen3-8B', revision: 'b'.repeat(40) },
      associatedConcepts: { terms: ['pirate', '海盗', '<script>x</script>'], method: 'j-lens', sourceUrl: 'https://example.com/analysis' } }
    localStorage.setItem(PERSONALITY_IMPORT_DRAFT_KEY, JSON.stringify({ personality }))
    localStorage.setItem('repoing-neuron-preview-v1', 'preset draft must survive')
    globalThis.fetch = async (url, init) => {
      if (url === '/api/hook-lab/wallet-identity') return Response.json({ signedIn: true, principal: { wallet: '11111111111111111111111111111111', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      assert.equal(url, '/api/neuron-characters')
      requests.push(JSON.parse(init.body))
      return requests.length === 1 ? Response.json({ error: 'Temporary outage' }, { status: 503 }) : Response.json({ character: { id: 'fixture-id', status: 'pending' } })
    }
    const { createRoot } = await import('react-dom/client')
    root = createRoot(document.getElementById('root'))
    await act(async () => root.render(h(WalletProvider, null, h(NeuronPersonalityImport, { publishing: { genesisHash: 'fixture' } }))))
    const click = async text => {
      const button = [...document.querySelectorAll('button')].find(element => element.textContent.includes(text))
      assert.ok(button, text); assert.equal(button.disabled, false, text)
      await act(async () => button.click())
    }
    const fill = async value => act(async () => {
      const input = document.querySelector('textarea')
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await click('CONTINUE SAVED CHARACTER')
    assert.equal(document.activeElement.textContent, 'Meet your character.')
    const concepts = () => document.querySelector('[aria-label="Associated concepts"]')
    assert.deepEqual([...concepts().querySelectorAll('li')].map(term => term.textContent), personality.associatedConcepts.terms)
    assert.match(concepts().textContent, /J-lens · Creator-supplied, not verified traits/)
    assert.equal(concepts().querySelector('script'), null)
    assert.equal(document.querySelector('[aria-label="Publish character"]'), null)
    await click('Change recipe')
    assert.equal(JSON.parse(document.querySelector('textarea').value).name, personality.name)
    await fill(JSON.stringify({ ...personality, model: { ...personality.model, revision: 'main' } }))
    await click('Load character')
    assert.match(document.querySelector('[role="alert"]').textContent, /model.revision/)
    assert.equal(requests.length, 0)
    await fill(JSON.stringify(personality)); await click('Load character')
    assert.equal(document.activeElement.textContent, 'Meet your character.')
    assert.match(document.body.textContent, /Unverified recipe/)
    await click('Change recipe')
    assert.deepEqual(JSON.parse(document.querySelector('textarea').value), personality)
    const fileInput = document.querySelector('input[type="file"]')
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [{ size: 8193, text: async () => JSON.stringify(personality) }] })
    await act(async () => fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    assert.match(document.querySelector('[role="alert"]').textContent, /8 KiB/)
    assert.equal(document.querySelector('[aria-label="Publish character"]'), null)
    assert.equal(document.querySelector('textarea').value, '')
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [{ size: 1000, text: async () => JSON.stringify(personality) }] })
    await act(async () => fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    assert.equal(document.activeElement.textContent, 'Meet your character.')
    assert.equal(requests.length, 0)
    await click('Continue to publish')
    assert.equal(document.activeElement.textContent, 'Ready for the library.')
    await click('Back to character')
    assert.equal(document.querySelector('[aria-label="Publish character"]'), null)
    await click('Continue to publish')
    await act(async () => document.querySelector('input[type="checkbox"]').click())
    await click('Submit for public review')
    assert.match(document.querySelector('[role="alert"]').textContent, /Temporary outage/)
    await click('Try submission again')
    assert.deepEqual(requests[0], requests[1])
    assert.deepEqual(requests[1].personality, personality)
    assert.equal(Object.hasOwn(requests[1], 'personaId'), false)
    assert.equal(localStorage.getItem(PERSONALITY_IMPORT_DRAFT_KEY), null)
    assert.equal(localStorage.getItem('repoing-neuron-preview-v1'), 'preset draft must survive')
    assert.match(document.querySelector('[aria-label="Submission receipt"]').textContent, /in the queue/)
    assert.equal([...document.querySelectorAll('button')].some(button => button.textContent.includes('Back to character')), false)
    const character = { id: 'fixture-id', personality, name: personality.name, ticker: personality.ticker, story: personality.story,
      creatorWallet: '11111111111111111111111111111111', metadataSha256: 'c'.repeat(64), reviewedAt: '2026-10-29T12:00:00Z' }
    await act(async () => root.render(h(NeuronCharacterPreview, { persona: characterPersona(character), character })))
    await click('Source DNA')
    assert.deepEqual([...concepts().querySelectorAll('li')].map(term => term.textContent), personality.associatedConcepts.terms)
    assert.equal(concepts().querySelector('a').href, personality.associatedConcepts.sourceUrl)
    assert.match(concepts().textContent, /not verified traits/)
    assert.equal(concepts().querySelector('script'), null)
    delete character.personality.associatedConcepts
    await act(async () => root.render(h(NeuronCharacterPreview, { persona: characterPersona(character), character })))
    assert.equal(concepts(), null)
  } finally {
    if (root) await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
})

test('saved drafts accept bounded identity fields, never wallet, mint or executable fee terms', () => {
  const value = { personaId: 'crab', name: '  Sideways Club  ', ticker: 'SIDE2', story: 'A friendly ocean explorer.', mint: 'forged', creatorWallet: 'attacker', feeBps: 9999 }
  assert.deepEqual(validateNeuronDraft(value), { personaId: 'crab', name: 'Sideways Club', ticker: 'SIDE2', story: 'A friendly ocean explorer.' })
  for (const change of [{ personaId: 'unknown' }, { name: ' ' }, { name: 'a'.repeat(41) }, { ticker: '1CRAB' }, { ticker: 'C' }, { ticker: 'a'.repeat(11) }, { story: 'short' }, { story: 'a'.repeat(281) }]) assert.equal(validateNeuronDraft({ ...value, ...change }), null)
  assert.ok(validateNeuronDraft({ ...value, name: 'a'.repeat(40), ticker: 'ABCDEFGHIJ', story: 'a'.repeat(280) }))
})

test('character preview discloses scripts and offers no executable trading or invented market results', () => {
  const doc = documentFor(h(NeuronCharacterPreview, { persona: findPersona('crab') }))
  const text = doc.body.textContent
  assert.match(text, /Scripted preview · not live AI/)
  assert.match(text, /No finalized trades/)
  assert.match(text, /not activation-steered/)
  const market = doc.querySelector('section[aria-label="Market preview"]')
  assert.match(market.textContent, /Not started/)
  const trade = doc.querySelector('section[aria-label="Trading unavailable"]')
  assert.ok([...trade.querySelectorAll('button')].find(button => button.textContent.includes('available after live launch')).disabled)
  assert.equal(doc.querySelector('button[aria-label="Send message"]').disabled, true)
  assert.equal(doc.querySelector('textarea').maxLength, 500)
})

test('launch preview starts from the selected recipe with no wallet or payment step', () => {
  const doc = documentFor(h(NeuronLaunchPreview, { initialId: 'red-queen' }))
  assert.match(doc.querySelector('button[aria-pressed="true"]').textContent, /Red Queen/)
  assert.match(doc.querySelector('details').textContent, /L9 \/ N2408/)
  assert.match(doc.querySelector('details').textContent, /down · α 1.25/)
  assert.match(doc.body.textContent, /No wallet signature. No fees. Nothing goes on chain./)
  assert.equal(doc.querySelectorAll('button[type="submit"]').length, 1)
  assert.equal(doc.querySelector('form').getAttribute('action'), null)
})

test('published identity has a stable profile URL, escaped story and no executable market', () => {
  const character = { id: '70621973-a55f-41dc-b90e-5aba6eec1fc9', personaId: 'crab', name: 'Sideways Club', ticker: 'SIDE',
    story: '<script>alert("no")</script> Ocean explorer.', status: 'published', reviewedAt: '2026-10-28T12:00:00Z', creatorWallet: 'PublicCreatorWallet', metadataSha256: 'a'.repeat(64) }
  const library = documentFor(h(NeuronsLibrary, { publishedCharacters: [character], publishingEnabled: true }))
  const card = library.querySelector('section[aria-label="Published characters"] article')
  assert.equal(card.querySelector('a').getAttribute('href'), `/neurons/${character.id}`)
  assert.equal(card.querySelectorAll('a')[1].getAttribute('href'), '/neurons/new?persona=crab')
  assert.match(card.textContent, /Published/)
  assert.match(card.textContent, /Based on Crab/)
  assert.match(card.textContent, /Content reviewed/)
  assert.equal(card.querySelector('code[title]').title, character.creatorWallet)
  assert.match(library.querySelector('p[role="status"]').textContent, /7 characters to discover/)
  assert.ok(card.closest('section').compareDocumentPosition(library.querySelector('section[aria-label="Source personas"]')) & library.defaultView.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.match(card.closest('section').textContent, /Scripted chat; no tokens or trading/)
  assert.equal(card.querySelector('script'), null)
  const profile = documentFor(h(NeuronCharacterPreview, { persona: findPersona('crab'), character }))
  assert.equal(profile.querySelector('h1').textContent, character.name)
  assert.match(profile.body.textContent, /Content reviewed/)
  assert.equal([...profile.querySelectorAll('p')].filter(p => p.textContent === character.story).length, 2)
  assert.equal(profile.querySelector('header a').getAttribute('href'), '/neurons/crab')
  const publication = profile.querySelector('details')
  assert.match(publication.textContent, /Publication details/)
  assert.ok(publication.textContent.includes(character.creatorWallet))
  assert.ok(publication.textContent.includes(character.metadataSha256))
  assert.equal(profile.body.textContent.includes('Custom draft text'), false)
  assert.ok([...profile.querySelectorAll('button')].find(button => button.textContent.includes('Buying available')).disabled)
})

test('community profiles open the composer, share the public identity and preserve the bounded scripted conversation', async () => {
  const { act } = await import('react')
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://repo.ing/neurons/70621973-a55f-41dc-b90e-5aba6eec1fc9' })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    self: dom.window, location: dom.window.location, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let root, copied = ''
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    dom.window.matchMedia = () => ({ matches: true })
    dom.window.Element.prototype.scrollIntoView = () => {}
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied = value } } })
    localStorage.setItem('repoing-neuron-preview-v1', JSON.stringify({ personaId: 'crab', name: 'Private draft', ticker: 'PRIVATE', story: 'Private draft text must not replace a public character.' }))
    const { createRoot } = await import('react-dom/client')
    root = createRoot(document.getElementById('root'))
    const character = { id: '70621973-a55f-41dc-b90e-5aba6eec1fc9', personaId: 'crab', name: 'Sideways Club', ticker: 'SIDE', story: 'An ocean explorer.',
      reviewedAt: '2026-10-28T12:00:00Z', creatorWallet: 'PublicCreatorWallet', metadataSha256: 'b'.repeat(64) }
    await act(async () => root.render(h(NeuronCharacterPreview, { persona: findPersona('crab'), character })))
    const click = async text => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent === text)
      assert.ok(button, text); await act(async () => button.click())
    }
    assert.equal(document.querySelector('h1').textContent, 'Sideways Club')
    await click('Start chatting')
    const input = document.querySelector('textarea')
    assert.equal(document.activeElement, input)
    await click('Share profile')
    assert.equal(copied, `https://repo.ing/neurons/${character.id}`)
    assert.match(document.querySelector('[role="status"]').textContent, /Public character link copied/)
    for (const message of ['Hello!', 'What do you like?', 'Any advice?']) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(input, message)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      await act(async () => input.closest('form').requestSubmit())
    }
    const conversation = document.querySelector('[role="log"]')
    for (const reply of findPersona('crab').replies) assert.ok(conversation.textContent.includes(reply))
    assert.equal(input.disabled, true)
    assert.equal(document.querySelector('button[aria-label="Send message"]').disabled, true)
    assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'View conversation'))
    await click('Reset preview')
    assert.equal(input.disabled, false)
    assert.equal(conversation.textContent.includes('Hello!'), false)
    assert.ok(conversation.textContent.includes(findPersona('crab').greeting))
  } finally {
    if (root) await act(async () => root.unmount())
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
})

test('creation resumes a draft and safely retries after editing, even when browser storage is blocked', async () => {
  const { act } = await import('react')
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://repo.ing/neurons/new' })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    self: dom.window, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const originalFetch = globalThis.fetch
  const requests = []
  let root
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    localStorage.setItem('repoing-neuron-preview-v1', JSON.stringify({ personaId: 'crab', name: 'Tidal Thinker', ticker: 'TIDE2', story: 'A sideways thinker with ocean-sized ideas.' }))
    globalThis.fetch = async (url, init) => {
      if (url === '/api/hook-lab/wallet-identity') return Response.json({ signedIn: true, principal: { wallet: '11111111111111111111111111111111', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      assert.equal(url, '/api/neuron-characters')
      requests.push(JSON.parse(init.body))
      return requests.length === 1 ? Response.json({ error: 'Temporary outage. Try again.' }, { status: 503 })
        : Response.json({ character: { id: '70621973-a55f-41dc-b90e-5aba6eec1fc9', status: 'pending' } })
    }
    const { createRoot } = await import('react-dom/client')
    const { WalletProvider } = await appModule('app/components/wallet.jsx')
    root = createRoot(document.getElementById('root'))
    await act(async () => root.render(h(WalletProvider, null, h(NeuronLaunchPreview, { initialId: 'coffee-bean', publishing: { genesisHash: 'fixture' } }))))
    const click = async text => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent.includes(text))
      assert.ok(button, text); assert.equal(button.disabled, false, text)
      await act(async () => button.click())
    }
    await click('Resume draft')
    assert.equal(document.querySelector('input').value, 'Tidal Thinker')
    assert.match(document.querySelector('aside').textContent, /TIDE2/)
    await click('Continue to review')
    assert.match(document.body.textContent, /0 SOL · no transaction/)
    assert.equal(document.body.textContent.includes('Future trading fees'), false)
    const submit = () => [...document.querySelectorAll('button')].find(item => /Submit for public review|Try submission again/.test(item.textContent))
    assert.equal(submit().disabled, true)
    await act(async () => document.querySelector('input[type="checkbox"]').click())
    await click('Submit for public review')
    assert.match(document.querySelector('[role="alert"]').textContent, /Temporary outage/)
    await click('Back')
    await click('Continue to review')
    // Publishing must not depend on localStorage being writable (private browsing/storage quota).
    dom.window.Storage.prototype.setItem = () => { throw new Error('Storage blocked') }
    await act(async () => document.querySelector('input[type="checkbox"]').click())
    await click('Submit for public review')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].requestId, requests[1].requestId)
    assert.equal(requests[1].name, 'Tidal Thinker')
    const receipt = document.querySelector('[aria-label="Submission receipt"]')
    assert.match(receipt.textContent, /in the queue/)
    assert.equal(document.activeElement, receipt)
    assert.equal(receipt.querySelector('a').getAttribute('href'), '/neurons/mine')
    assert.equal(localStorage.getItem('repoing-neuron-preview-v1'), null)
    assert.equal(document.querySelector('ol[aria-label="Creation progress"] button:not(:disabled)'), null)
    assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === 'Back'), false)
  } finally {
    if (root) await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
})

test('discovery combines community search, collection/category filters, honest counts and alphabetical sorting', async () => {
  const { act } = await import('react')
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://repo.ing/neurons' })
  const globals = { window: dom.window, self: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let root
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    const { createRoot } = await import('react-dom/client')
    root = createRoot(document.getElementById('root'))
    const characters = [
      { id: 'newest', personaId: 'crab', name: 'Zora', ticker: 'ZORA', story: 'Bioluminescent tide pools.', creatorWallet: 'CreatorAlpha' },
      { id: 'older', personaId: 'red-queen', name: 'Aster', ticker: 'ASTER', story: 'An imaginative tea party.', creatorWallet: 'CreatorBeta' },
    ]
    const render = async props => act(async () => root.render(h(NeuronsLibrary, { publishingEnabled: true, ...props })))
    await render({ publishedCharacters: characters })
    const count = () => document.querySelector('p[role="status"]').textContent
    const titles = () => [...document.querySelectorAll('article h2')].map(element => element.textContent)
    const click = async (group, text) => {
      const button = [...document.querySelectorAll(`${group} button`)].find(element => element.textContent.startsWith(text))
      assert.ok(button, text)
      await act(async () => button.click())
    }
    const search = async value => act(async () => {
      const input = document.querySelector('input[type="search"]')
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.match(count(), /8 characters to discover/)
    assert.deepEqual(titles().slice(0, 2), ['Zora', 'Aster'])
    await search('BIOLUMINESCENT')
    assert.deepEqual(titles(), ['Zora'])
    assert.match(count(), /1 character match/)
    assert.equal(document.body.textContent.includes('No matching'), false)
    await search('$ASTER')
    assert.deepEqual(titles(), ['Aster'])
    await search('CreatorAlpha')
    assert.deepEqual(titles(), ['Zora'])
    await search('')
    await click('[aria-label="Character collection"]', 'Community')
    await act(async () => {
      const select = document.querySelector('select'); select.value = 'name'
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    assert.deepEqual(titles(), ['Aster', 'Zora'])
    await click('[aria-label="Personality category"]', 'Fantasy')
    assert.deepEqual(titles(), ['Aster'])
    await search('ocean-no-match')
    assert.match(count(), /0 characters/)
    assert.match(document.body.textContent, /No matching characters/)
    await click('main', 'Clear filters')
    assert.deepEqual(titles(), ['Aster', 'Zora'])
    await click('[aria-label="Character collection"]', 'Source')
    assert.equal(titles().length, 6)
    assert.equal(document.querySelector('section[aria-label="Published characters"]'), null)
    await click('[aria-label="Character collection"]', 'Community')
    await render({ publishedCharacters: [] })
    assert.match(document.body.textContent, /The next character could be yours/)
    await render({ publishingUnavailable: true })
    assert.match(document.body.textContent, /temporarily unavailable/)
    assert.equal(document.body.textContent.includes('The next character could be yours'), false)
  } finally {
    if (root) await act(async () => root.unmount())
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
})
