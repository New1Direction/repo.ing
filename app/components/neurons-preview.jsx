'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowUp, Check, Copy, ExternalLink, LockKeyhole, MessageCircle, Plus, Search, ShieldCheck, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import { ExploreNavigation } from './explore-navigation'
import { characterPersona, findPersona, NEURON_DRAFT_KEY, NEURON_PERSONAS, searchPersonas, SIMULATION_DISCLOSURE, validateNeuronDraft } from '../lib/neurons-preview.mjs'
import { NeuronPublishAction } from './neuron-publishing'
import { NeuronConcepts } from './neuron-concepts'
import { NeuronRecipeChat } from './neuron-recipe-chat'
import styles from './neurons-preview.module.css'

function Avatar({ persona, large = false }) {
  return <span className={`${styles.avatar} ${large ? styles.avatarLarge : ''}`} style={{ '--persona-color': persona.color }} aria-hidden="true">{persona.icon}</span>
}

function PersonaCard({ persona, published = false }) {
  return <article className={styles.personaCard} style={{ '--persona-color': persona.color }}>
    <div className={styles.cardTop}><div className={styles.cardIdentity}><Avatar persona={persona}/><div className={styles.cardName}><h2>{persona.name}</h2><span>${persona.ticker}</span></div></div><span className={styles.pill}>{published ? 'Published' : 'Scripted'}</span></div>
    {published && <div className={styles.creatorLine}><span>by <code title={persona.creatorWallet}>{persona.creatorWallet.slice(0, 4)}…{persona.creatorWallet.slice(-4)}</code></span><span><ShieldCheck size={13}/>Content reviewed</span></div>}
    <p>{persona.description}</p><div className={styles.tags}>{persona.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
    <blockquote><span className={styles.greetingLabel}>{persona.imported ? 'IMPORTED RECIPE · UNVERIFIED' : 'SCRIPTED GREETING'}</span>{persona.imported ? 'Creator-supplied settings. Live chat is not connected.' : `“${persona.greeting}”`}</blockquote>
    {published && <p className={styles.basedOn}>{persona.imported ? `Attributed to ${persona.attribution.author}` : `Based on ${findPersona(persona.basePersonaId).name}`}</p>}
    <div className={styles.cardDna}><span>SOURCE DNA</span><code>L{persona.layer} : N{persona.neuron} · {persona.direction === 'up' ? '↑' : '↓'}</code></div>
    <div className={styles.cardActions}><Link href={`/neurons/${persona.id}`} aria-label={published ? `Open character ${persona.name}` : `Preview chat with ${persona.name}`}>{published ? 'Open character' : 'Preview chat'}<ArrowRight size={15}/></Link>{persona.imported ? <a href={`/api/neuron-characters?export=${persona.id}`} aria-label={`Download recipe for ${persona.name}`}>Get recipe<ArrowRight size={15}/></a> : <Link href={`/neurons/new?persona=${persona.basePersonaId ?? persona.id}`} aria-label={`Create with ${persona.name}`}><Plus size={15}/>{published ? 'Create similar' : 'Create'}</Link>}</div>
  </article>
}

export function NeuronsLibrary({ publishedCharacters = [], publishingEnabled = false, publishingUnavailable = false }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [scope, setScope] = useState('All')
  const [sort, setSort] = useState('newest')
  const term = query.trim().replace(/^\$/, '').toLowerCase()
  const communityEnabled = publishingEnabled || publishingUnavailable || publishedCharacters.length > 0
  const personas = scope === 'Community' ? [] : searchPersonas(query, category)
  const published = scope === 'Source' ? [] : publishedCharacters.map(character => ({ ...characterPersona(character), id: character.id,
    basePersonaId: character.personaId, name: character.name, ticker: character.ticker, description: character.story, creatorWallet: character.creatorWallet }))
    .filter(persona => (category === 'All' || persona.category === category) && `${persona.name} ${persona.ticker} ${persona.description} ${persona.creatorWallet} ${persona.attribution?.author ?? findPersona(persona.basePersonaId)?.name ?? ''} ${persona.category} ${persona.tags.join(' ')} ${persona.layer}:${persona.neuron}`.toLowerCase().includes(term))
  if (sort === 'name') {
    personas.sort((a, b) => a.name.localeCompare(b.name))
    published.sort((a, b) => a.name.localeCompare(b.name))
  }
  const total = personas.length + published.length
  const filtered = !!query.trim() || category !== 'All'
  function clearFilters() { setQuery(''); setCategory('All') }
  const categories = ['All', ...new Set([...NEURON_PERSONAS.map(persona => persona.category), ...publishedCharacters.map(character => characterPersona(character).category)])]
  return <main className={styles.main}>
    <ExploreNavigation active="neurons"/>
    <section className={styles.hero}>
      <div><div className={styles.eyebrow}><Sparkles size={14}/> NEURON CHARACTERS</div><h1>A little different.<br/><span>A lot of personality.</span></h1><p>Find a personality, try a conversation, and make a character your own.</p></div>
      <div className={styles.heroActions}><Link className="button primary" href="/neurons/new"><Plus size={17}/>Create a Neuro</Link><Link className="button" href="/neurons/import">Import a personality<ArrowRight size={16}/></Link>{publishingEnabled && <Link className="button" href="/neurons/mine">My characters<ArrowRight size={16}/></Link>}<span className={styles.heroNote}>{publishingEnabled ? 'Free to create. Reviewed before publishing.' : 'Free preview. No wallet or GPU needed.'}</span></div>
    </section>
    <section className={styles.discoveryControls} aria-label="Discover characters">
      <div className={styles.discoveryTop}><div className={styles.scopeFilters} role="group" aria-label="Character collection">{(communityEnabled ? ['All', 'Community', 'Source'] : ['All', 'Source']).map(value => <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)}>{value === 'All' ? 'All characters' : value === 'Source' ? 'Source personas' : value}<span>{value === 'Community' ? publishedCharacters.length : value === 'Source' ? NEURON_PERSONAS.length : publishedCharacters.length + NEURON_PERSONAS.length}</span></button>)}</div><label className={styles.sortControl}>Sort<select aria-label="Sort characters" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Newest community first</option><option value="name">Name A–Z</option></select></label></div>
      <label className={`${styles.search} ${styles.discoverySearch}`}><Search size={18}/><input aria-label="Search personas" title="Search names, tickers, stories, creators, or source DNA" type="search" maxLength={100} placeholder="Search characters…" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16}/></button>}</label>
      <div className={styles.categories} role="group" aria-label="Personality category">{categories.map(value => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)}>{value === 'All' ? 'All personalities' : value}</button>)}</div>
    </section>
    {publishingUnavailable && scope !== 'Source' && <div className={styles.discoveryNotice} role="status"><ShieldCheck size={18}/><div><strong>Community profiles are temporarily unavailable.</strong><p>Reload to try again, or keep exploring the source personas.</p><button type="button" onClick={() => window.location.reload()}>Retry loading</button></div></div>}
    <div className={styles.results}><p role="status" aria-live="polite">{total} {total === 1 ? 'character' : 'characters'}{filtered ? total === 1 ? ' matches your filters' : ' match your filters' : ' to discover'}{publishingUnavailable && scope !== 'Source' ? ' · community unavailable' : ''}</p>{filtered ? <button type="button" onClick={clearFilters}>Clear filters<X size={13}/></button> : <span>Scripted chat · no tokens or trading</span>}</div>
    {communityEnabled && scope !== 'Source' && published.length > 0 && <section className={styles.discoverySection} aria-label="Published characters"><div className={styles.libraryHeading}><div><h2>Made by the community.</h2><p>Content reviewed. {published.some(persona => persona.imported) ? 'Imported recipes are unverified; their chat is unavailable.' : 'Scripted chat; no tokens or trading.'}</p></div><span className={styles.sectionCount}>{published.length} published</span></div><div className={styles.cardGrid}>{published.map(persona => <PersonaCard key={persona.id} persona={persona} published/>)}</div></section>}
    {total === 0 && !publishingUnavailable && !filtered && scope === 'Community' ? <div className={styles.empty}><Sparkles size={28}/><h2>The next character could be yours.</h2><p>Approved community profiles will appear here. Start with a source personality.</p><Link className="button primary" href="/neurons/new">Create a Neuro<Plus size={16}/></Link></div> : total === 0 && !(publishingUnavailable && scope === 'Community') && <div className={styles.empty}><Search size={28}/><h2>No matching characters.</h2><p>Try a name, a story keyword, or source DNA like “9:166”.</p><button className="button" onClick={clearFilters}>Clear filters</button><button type="button" className={styles.textButton} onClick={() => { clearFilters(); setScope('All') }}>Browse all characters</button></div>}
    {personas.length > 0 && <section className={styles.discoverySection} aria-label="Source personas"><div className={styles.libraryHeading}><div><h2>Start with a personality.</h2><p>Imported recipes, not locally validated. Try a scripted preview or make one your own.</p></div><a href="https://qwen-neurons-site.vercel.app" target="_blank" rel="noreferrer">Source library<ExternalLink size={14}/></a></div><div className={styles.cardGrid}>{personas.map(persona => <PersonaCard key={persona.id} persona={persona}/>)}</div></section>}
    <div className={styles.bottomNote}><ShieldCheck size={20}/><p><strong>A little imagination. Clear boundaries.</strong> These profiles use imported neuron recipes as inspiration. This preview uses reviewed, fixed replies—not live AI, activation steering, or live markets. Tokens, when enabled, will not convey ownership of a neuron or model.</p></div>
  </main>
}

export function NeuronLaunchPreview({ initialId, publishing = null }) {
  const [personaId, setPersonaId] = useState(initialId)
  const persona = findPersona(personaId)
  const [stage, setStage] = useState(1)
  const [name, setName] = useState(persona.name)
  const [ticker, setTicker] = useState(persona.ticker)
  const [story, setStory] = useState(persona.description)
  const [accepted, setAccepted] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [recovered, setRecovered] = useState(null)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const request = useRef(null)
  const title = useRef(null)
  useEffect(() => {
    try { setRecovered(validateNeuronDraft(JSON.parse(localStorage.getItem(NEURON_DRAFT_KEY)))) } catch {}
  }, [])
  useEffect(() => { title.current?.focus() }, [stage, saved])
  function resumeDraft() {
    setPersonaId(recovered.personaId); setName(recovered.name); setTicker(recovered.ticker); setStory(recovered.story)
    setRecovered(null); setStage(2)
  }
  function choose(id) {
    const next = findPersona(id)
    setPersonaId(id); setName(next.name); setTicker(next.ticker); setStory(next.description); setError('')
  }
  function submit(event) {
    event.preventDefault(); setError('')
    if (stage === 1) { setStage(2); return }
    const draft = validateNeuronDraft({ personaId, name, ticker, story })
    if (!draft) { setError('Use a name up to 40 characters, a 2–10 character ticker starting with a letter, and a 10–280 character story.'); return }
    if (stage === 2) {
      try { localStorage.setItem(NEURON_DRAFT_KEY, JSON.stringify(draft)) } catch {}
      setRecovered(null); setStage(3); return
    }
    if (!accepted) { setError('Confirm that this saves a local preview, not a token launch.'); return }
    try { localStorage.setItem(NEURON_DRAFT_KEY, JSON.stringify(draft)); setSaved(true) }
    catch { setError('Your browser could not save this draft. Allow site storage and try again. Nothing was launched.') }
  }
  return <main className={`${styles.main} ${styles.launchMain}`}>
    <Link href="/neurons" className={styles.back}><ArrowLeft size={15}/> Character library</Link>
    {saved ? <section className={styles.saved}><span className={styles.successIcon}><Check size={30}/></span><div className={styles.eyebrow}>DRAFT SAVED · THIS BROWSER ONLY</div><h1 ref={title} tabIndex={-1}>{name} has a beginning.</h1><p>Your character preview is ready. No token was minted, no SOL was spent,<br/>and nothing was published. Your local draft replaces any earlier preview draft.</p><Avatar persona={persona} large/><Link href={`/neurons/${persona.id}`} className="button primary">Open your character <ArrowRight size={17}/></Link><button className={styles.textButton} onClick={() => { setSaved(false); setStage(2); setAccepted(false) }}>Keep editing</button></section> : <>
      <div className={styles.launchIntro}><div><div className={styles.eyebrow}>CREATE A NEURO</div><h1>A personality. <span>Made yours.</span></h1><p>{publishing ? 'Choose, customize, and submit for review. No transaction needed.' : 'Choose a personality and save a private preview for free.'}</p></div><span className={styles.creationBadge}><ShieldCheck size={16}/>Free to create</span></div>
      {recovered && !submitted && <div className={styles.draftNotice}><div><strong>Pick up where you left off.</strong><span>Your draft: {recovered.name} · ${recovered.ticker}</span></div><button type="button" onClick={resumeDraft}>Resume draft<ArrowRight size={15}/></button><button type="button" aria-label="Dismiss saved draft" onClick={() => setRecovered(null)}><X size={16}/></button></div>}
      <ol className={styles.steps} aria-label="Creation progress">{['Personality', 'Identity', 'Review'].map((label, index) => <li key={label} data-active={stage === index + 1} data-complete={stage > index + 1}><button type="button" disabled={submitted || submitting || stage <= index + 1} aria-current={stage === index + 1 ? 'step' : undefined} onClick={() => { setStage(index + 1); setError('') }}><span>{stage > index + 1 ? <Check size={14}/> : index + 1}</span>{label}</button></li>)}</ol>
      <div className={styles.launchGrid}><form className={styles.formPanel} onSubmit={submit}><h2 ref={title} tabIndex={-1}>{['Choose a personality.', 'Make it yours.', 'One last look.'][stage - 1]}</h2>
        {stage === 1 && <><p className={styles.help}>Find your starting point. Each personality comes with three scripted preview replies.</p><div className={styles.personaPicker}>{NEURON_PERSONAS.map(item => <button type="button" key={item.id} aria-pressed={item.id === personaId} onClick={() => choose(item.id)}><Avatar persona={item}/><span><strong>{item.name}</strong><small>{item.tags.slice(0, 2).join(' · ')}</small></span>{item.id === personaId && <Check size={18}/>}</button>)}</div></>}
        {stage === 2 && <div className={styles.fields}><p className={styles.help}>Give it an identity. Your changes appear in the preview; its scripted replies stay the same.</p><label>Character name<input required maxLength={40} value={name} onChange={event => setName(event.target.value)} autoComplete="off" placeholder="Give your character a name"/></label><label>Ticker<span className={styles.inputPrefix}><span>$</span><input required minLength={2} maxLength={10} pattern="[A-Z][A-Z0-9]{1,9}" title="2–10 letters or numbers, starting with a letter" value={ticker} onChange={event => setTicker(event.target.value.toUpperCase())} autoComplete="off" spellCheck={false}/></span><small>2–10 letters or numbers, starting with a letter. Not a token.</small></label><label>Your character’s story<textarea required minLength={10} maxLength={280} rows={4} value={story} onChange={event => setStory(event.target.value)} placeholder="What makes this character yours?"/><small>{story.length}/280 · saved on this browser when you continue</small></label></div>}
        {stage === 3 && <><p className={styles.help}>{publishing ? 'Your profile stays private until a moderator approves it. Check the details, then sign in to submit.' : 'This saves a private browser preview, not a public profile or token.'}</p><dl className={styles.reviewList}><div><dt>Character</dt><dd>{name} · ${ticker}</dd></div><div><dt>Personality</dt><dd>{persona.name}</dd></div><div><dt>Chat engine</dt><dd>Scripted preview</dd></div><div><dt>Cost today</dt><dd>0 SOL · no transaction</dd></div></dl>{!publishing && <label className={styles.checkbox}><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)}/>I understand this saves a private browser draft. It does not launch a token or create earnings.</label>}</>}
        {stage === 3 && publishing && <NeuronPublishAction key={JSON.stringify({ personaId, name, ticker, story })} draft={{ personaId, name, ticker, story }} genesisHash={publishing.genesisHash} botSiteKey={publishing.botSiteKey} request={request} onSubmitted={() => setSubmitted(true)} onBusyChange={setSubmitting}/>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {!submitted && <div className={styles.formActions}>{stage > 1 && <button className="button" type="button" disabled={submitting} onClick={() => { setStage(stage - 1); setError('') }}>Back</button>}{!(stage === 3 && publishing) && <button className="button primary" type="submit" disabled={stage === 3 && !accepted}>{stage === 3 ? 'Save character preview' : stage === 1 ? 'Make it yours' : 'Continue to review'}<ArrowRight size={16}/></button>}</div>}
      </form><aside className={styles.launchAside} aria-label="Live character preview" style={{ '--persona-color': persona.color }}><span className={styles.eyebrow}>PROFILE PREVIEW<span className={styles.pill}>Scripted chat</span></span><div className={styles.previewIdentity}><Avatar persona={persona} large/><div><h2>{name || 'Your character'}</h2><span className={styles.ticker}>${ticker || 'NEURO'}</span></div></div><p>{story}</p><blockquote>“{persona.greeting}”</blockquote><details className={styles.recipeDetails}><summary>Source DNA · L{persona.layer} / N{persona.neuron}</summary><div className={styles.sourceRecipe}><code>{persona.direction} · α {persona.alpha}</code><p>Qwen3-8B inspiration. Imported recipe, not locally validated. Model revision not published by source.</p></div></details><div className={styles.safeNote}><LockKeyhole size={16}/>{publishing ? 'Free sign-in message only. No transactions or fees.' : 'No wallet signature. No fees. Nothing goes on chain.'}</div></aside></div>
    </>}
  </main>
}

export function NeuronCharacterPreview({ persona: sourcePersona, character = null, chatConfig = null }) {
  const persona = character ? { ...sourcePersona, description: character.story } : sourcePersona
  const [draft, setDraft] = useState(null)
  const [width, setWidth] = useState(44)
  const [tab, setTab] = useState('About')
  const [side, setSide] = useState('Buy')
  const [amount, setAmount] = useState('0.1')
  const [frame, setFrame] = useState('1H')
  const [text, setText] = useState('')
  const [messages, setMessages] = useState([])
  const [shareStatus, setShareStatus] = useState('')
  const log = useRef(null)
  const input = useRef(null)
  useEffect(() => {
    if (character) return
    try { const stored = validateNeuronDraft(JSON.parse(localStorage.getItem(NEURON_DRAFT_KEY))); if (stored?.personaId === persona.id) setDraft(stored) } catch {}
  }, [persona.id, character])
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [messages])
  const name = character?.name ?? draft?.name ?? persona.name
  const ticker = character?.ticker ?? draft?.ticker ?? persona.ticker
  function openChat() {
    input.current?.focus({ preventScroll: true })
    input.current?.closest('section').scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }
  function send(event) {
    event.preventDefault()
    if (!text.trim() || messages.length >= 3) return
    setMessages([...messages, { text: text.trim().slice(0, 500), reply: persona.replies[messages.length] }]); setText(''); input.current?.focus()
  }
  async function share() {
    try { await navigator.clipboard.writeText(`${location.origin}/neurons/${character?.id ?? persona.id}`); setShareStatus(character ? 'Public character link copied.' : 'Profile link copied. Local draft details are not shared.') }
    catch { setShareStatus(character ? 'Copy this page’s address to share your public character.' : 'Copy this page’s address to share the base persona. Local drafts are private.') }
  }
  return <main className={styles.main}>
    <Link href="/neurons" className={styles.back}><ArrowLeft size={15}/> All characters</Link>
    <header className={styles.characterHeader} style={{ '--persona-color': persona.color }}>
      <Avatar persona={persona} large/>
      <div className={styles.characterIdentity}>
        <div className={styles.eyebrow}>{character ? 'COMMUNITY CHARACTER' : draft ? 'YOUR LOCAL DRAFT' : 'SOURCE PERSONALITY'}<span className={styles.pill}>{character ? 'Published' : draft ? 'Private' : 'Imported'}</span></div>
        <div className={styles.characterTitle}><h1>{name}</h1><span>${ticker}</span></div>
        <p>{character?.story ?? draft?.story ?? persona.description}</p>
        <div className={styles.characterTags}><span><i/>{persona.imported ? chatConfig ? 'Mock chat · recipe unverified' : 'Unverified recipe · chat unavailable' : 'Scripted chat'}</span><span>{persona.category}</span>{persona.imported ? <span>Attributed to {persona.attribution.author}</span> : character ? <Link href={`/neurons/${persona.id}`}>Based on {persona.name}<ArrowRight size={12}/></Link> : <span>Source L{persona.layer} · N{persona.neuron}</span>}</div>
        {character && <div className={styles.profileCreator}><span>Created by <code title={character.creatorWallet}>{character.creatorWallet.slice(0, 4)}…{character.creatorWallet.slice(-4)}</code></span><span><ShieldCheck size={13}/>Content reviewed</span><time dateTime={character.reviewedAt}>{new Date(character.reviewedAt).toISOString().slice(0, 10)}</time></div>}
      </div>
      <div className={styles.characterActions}>{persona.imported ? <a className="button primary" href={`/api/neuron-characters?export=${character.id}`}>Download recipe</a> : <button className="button primary" onClick={openChat}><MessageCircle size={16}/>{messages.length >= 3 ? 'View conversation' : 'Start chatting'}</button>}<button className="button" onClick={share}><Copy size={15}/>Share profile</button><span>{persona.imported ? 'Immutable version · no token' : 'Free preview · no wallet needed'}</span></div>
    </header>
    {shareStatus && <p className={styles.shareStatus} role="status">{shareStatus}<button aria-label="Dismiss share notification" onClick={() => setShareStatus('')}><X size={14}/></button></p>}
    <div className={styles.workspaceToolbar}><div><span className={styles.eyebrow}>CHARACTER WORKSPACE</span><span>Chart on the left. Conversation on the right.</span></div><label className={styles.resize}><SlidersHorizontal size={14}/><span>Chat width</span><input type="range" min="32" max="58" value={width} aria-label="Chat panel width" onChange={event => setWidth(Number(event.target.value))}/><output>{width}%</output></label></div>
    <div className={styles.workspace} style={{ '--chat-share': `${width}%` }}>
      <section className={styles.marketPanel} aria-label="Market preview"><div className={styles.panelHeading}><span><span className={styles.marketDot}/>${ticker} / SOL</span><span className={styles.pill}>NOT LIVE</span></div><div className={styles.marketStats}>{['Market cap', '24h volume', 'Holders'].map(label => <div key={label}><span>{label}</span><strong>—</strong></div>)}<div><span>Curve progress</span><strong>Not started</strong></div></div><div className={styles.chartFrames}>{['15M', '1H', '4H', '1D'].map(value => <button key={value} aria-pressed={frame === value} onClick={() => setFrame(value)}>{value}</button>)}<span>No finalized trades · {frame} view</span></div><div className={styles.chartEmpty}><div className={styles.chartGlyph}>⌁</div><h2>Your market starts here.</h2><p>A real price chart appears after a verified launch.<br/>No made-up candles. No simulated returns.</p><span>PRE-LAUNCH</span></div><div className={styles.marketFoot}><ShieldCheck size={13}/>No trading authorization. No transactions prepared.</div></section>
      {persona.imported && chatConfig && <NeuronRecipeChat characterId={character.id} name={name} {...chatConfig}/>}
      {!(persona.imported && chatConfig) && (persona.imported ? <section className={styles.chatPanel} aria-label="Imported personality chat unavailable"><div className={styles.chatHeading}><Avatar persona={persona}/><div><strong>{name}</strong><span>Imported recipe · not evaluated</span></div></div><div className={styles.chatUnavailable}><MessageCircle size={30}/><h2>Your recipe is here.</h2><p>Live inference is not connected. We won’t substitute another personality’s replies or present examples as a real conversation.</p><a className="button" href={`/api/neuron-characters?export=${character.id}`}>Download personality JSON</a></div><div className={styles.composerArea}><p className={styles.help}>Chat unavailable · no model or paid API calls</p></div></section> : <section className={styles.chatPanel} aria-label={`Chat with ${name}`}><div className={styles.chatHeading}><Avatar persona={persona}/><div><strong>{name}</strong><span>Scripted preview · not live AI</span></div><MessageCircle size={19}/></div><div className={styles.chatLog} ref={log} role="log" aria-label="Conversation" aria-live="polite"><div className={styles.chatDate}>A LITTLE CONVERSATION STARTS HERE</div><div className={styles.assistantBubble}>{persona.greeting}</div>{messages.map((message, index) => <div className={styles.messagePair} key={index}><div className={styles.userBubble}>{message.text}</div><div className={styles.assistantBubble}>{message.reply}</div><span className={styles.replyLabel}>Reviewed, fixed preview reply</span></div>)}</div><div className={styles.composerArea}>{messages.length === 0 && <div className={styles.suggestions}>{['Tell me about yourself', 'What do you like?'].map(value => <button key={value} onClick={() => { setText(value); input.current?.focus() }}>{value}</button>)}</div>}<form className={styles.composer} onSubmit={send}><textarea ref={input} aria-label={`Message ${name}`} rows={1} maxLength={500} disabled={messages.length >= 3} placeholder={messages.length >= 3 ? 'You’ve tried all three preview replies' : `Message ${name}…`} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit() } }}/><button type="submit" aria-label="Send message" disabled={!text.trim() || messages.length >= 3}><ArrowUp size={20}/></button></form><div className={styles.composerNote}><span>{3 - messages.length} scripted replies left · no API calls</span>{messages.length > 0 && <button onClick={() => { setMessages([]); setText('') }}>Reset preview</button>}</div></div></section>)}
    </div>
    <div className={styles.detailGrid}><section className={styles.infoPanel}><div className={styles.detailTabs}>{['About', 'Source DNA', 'Earnings'].map(value => <button aria-pressed={tab === value} key={value} onClick={() => setTab(value)}>{value}</button>)}</div>{tab === 'About' && <div className={styles.detailContent}>
      <h2>Meet {name}.</h2><p>{character?.story ?? draft?.story ?? persona.description}</p>
      <p>{persona.imported ? 'A creator-supplied neuron recipe. Content review is not verification of the model revision, steering behavior, quality, or safety. Live chat is unavailable.' : character ? `A community character based on ${persona.name}. Its conversation uses three reviewed scripts from that source personality, not live AI. Your messages don’t change the replies.` : `${SIMULATION_DISCLOSURE} Custom draft text only changes the local profile.`}</p>
      <div className={styles.profileLinks}><Link className="button" href={persona.imported ? '/neurons/import' : `/neurons/new?persona=${persona.id}`}><Plus size={15}/>{persona.imported ? 'Import your own personality' : character ? 'Create a similar character' : 'Create with this persona'}</Link><a href={persona.attribution?.url ?? 'https://qwen-neurons-site.vercel.app'} target="_blank" rel="noreferrer">{persona.imported ? 'Creator attribution' : 'Source research'}<ExternalLink size={13}/></a></div>
      {persona.imported && <><dl className={styles.dnaGrid}>{[['Model', persona.model], ['Revision · unverified', persona.modelRevision], ['Layer / neuron', `${persona.layer} / ${persona.neuron}`], ['Direction / alpha', `${persona.direction} / ${persona.alpha}`]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><details className={styles.publicationDetails}><summary>Creator-supplied examples · not evaluated ({character.personality.examples.length})</summary>{character.personality.examples.map((example, index) => <blockquote key={index}><strong>{example.prompt}</strong><p>{example.reply}</p></blockquote>)}</details></>}
      {character && <details className={styles.publicationDetails}><summary>Publication details</summary><dl><div><dt>Creator wallet</dt><dd><code>{character.creatorWallet}</code></dd></div><div><dt>Profile SHA-256</dt><dd><code>{character.metadataSha256}</code></dd></div></dl><p>This hash identifies the saved profile metadata, not a token or proof of model evaluation.</p></details>}
    </div>}{tab === 'Source DNA' && <div className={styles.detailContent}><h2>Where this personality started.</h2><dl className={styles.dnaGrid}>{[['Model inspiration', persona.model ?? 'Qwen3-8B'], ['Layer / neuron', `${persona.layer} / ${persona.neuron}`], ['Direction / alpha', `${persona.direction} / ${persona.alpha}`], ['Model revision', persona.modelRevision ?? 'Not published'], ['Recipe status', 'Imported · not validated'], ['Current chat', persona.imported ? 'Unavailable · no inference' : 'Fixed, reviewed scripts']].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><NeuronConcepts concepts={character?.personality?.associatedConcepts}/><p>This recipe is attribution, not evidence that activation steering or evaluation ran in this preview.</p></div>}{tab === 'Earnings' && <div className={styles.detailContent}><h2>Earnings start with real activity.</h2><p>No fees have accrued. Claims and buybacks are not active.</p><div className={styles.feePolicy}><div><span>65% launcher</span><span>35% REPOING reserve</span></div><div className={styles.splitBar}><span/></div><p>Proposed split of eligible creator fees only. Final trading fee rate is not configured. A reserve is not an executed buyback.</p></div><button className="button" disabled>Nothing to claim · preview only</button></div>}</section><section className={styles.tradePanel} aria-label="Trading unavailable"><div className={styles.tradeTabs}>{['Buy', 'Sell'].map(value => <button key={value} aria-pressed={side === value} onClick={() => { setSide(value); setAmount(value === 'Buy' ? '0.1' : '100') }}>{value}</button>)}</div><label>{side === 'Buy' ? 'You pay' : 'You sell'}<div className={styles.amountInput}><input aria-label={`${side} amount`} type="number" min="0" step="any" max="1000000000" value={amount} onChange={event => setAmount(event.target.value)}/><span>{side === 'Buy' ? 'SOL' : ticker}</span></div></label><div className={styles.quickAmounts}>{(side === 'Buy' ? ['0.1', '0.5', '1'] : ['100', '500', '1000']).map(value => <button key={value} onClick={() => setAmount(value)}>{value} {side === 'Buy' ? 'SOL' : ticker}</button>)}</div><div className={styles.quoteLine}><span>You receive</span><strong>No quote available</strong></div><button className="button primary" disabled><LockKeyhole size={15}/>{side === 'Buy' ? 'Buying' : 'Selling'} available after live launch</button><p>No mint or pool exists for this profile. This form cannot connect a wallet, request a signature, or submit a transaction.</p></section></div>
    <div className={styles.bottomNote}><ShieldCheck size={19}/><p>Real money needs real verification. Launching, trading, fee claims, and automatic buybacks stay disabled until their production integration is reviewed and verified.</p></div>
  </main>
}
