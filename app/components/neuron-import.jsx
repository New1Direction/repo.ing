'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronDown, Cpu, FileJson, Layers3, Upload, Zap } from 'lucide-react'
import { NeuronPublishAction } from './neuron-publishing'
import { NeuronConcepts } from './neuron-concepts'
import { parsePersonalityImport, PERSONALITY_IMPORT_BYTES, PERSONALITY_IMPORT_DRAFT_KEY, PERSONALITY_IMPORT_TEMPLATE } from '../lib/neuron-import.mjs'
import styles from './neurons-preview.module.css'
import forge from './neuron-import.module.css'

export function NeuronPersonalityImport({ publishing = null }) {
  const [raw, setRaw] = useState(''), [personality, setPersonality] = useState(null)
  const [error, setError] = useState(''), [submitted, setSubmitted] = useState(false), [busy, setBusy] = useState(false)
  const [recovered, setRecovered] = useState(null)
  const [publishReady, setPublishReady] = useState(false), [dragging, setDragging] = useState(false)
  const request = useRef(null), heading = useRef(null), fileEpoch = useRef(0)
  const fileInput = useRef(null)
  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(PERSONALITY_IMPORT_DRAFT_KEY))
      if (draft?.personality) setRecovered(parsePersonalityImport(JSON.stringify(draft.personality)))
    } catch {}
  }, [])
  useEffect(() => { if (personality) heading.current?.focus() }, [personality, publishReady])
  function load(value) {
    const next = parsePersonalityImport(value)
    try { localStorage.setItem(PERSONALITY_IMPORT_DRAFT_KEY, JSON.stringify({ personality: next })) } catch {}
    setPersonality(next); setRecovered(null); setPublishReady(false)
  }
  async function chooseFile(file) {
    const epoch = ++fileEpoch.current
    setError('')
    if (!file) return
    // Clear old contents so a failed replacement cannot accidentally submit the prior recipe.
    setRaw(''); setPersonality(null); setPublishReady(false)
    try {
      if (file.size > PERSONALITY_IMPORT_BYTES) throw Error('Choose a JSON file no larger than 8 KiB.')
      const value = await file.text()
      if (epoch !== fileEpoch.current) return
      setRaw(value)
      load(value)
    } catch (cause) { if (epoch === fileEpoch.current) setError(cause.message) }
  }
  function review(event) {
    event.preventDefault(); setError('')
    try {
      load(raw)
    } catch (cause) { setError(cause.message) }
  }
  const template = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(PERSONALITY_IMPORT_TEMPLATE, null, 2))}`
  const stage = personality ? publishReady ? 3 : 2 : 1
  return <main className={`${styles.main} ${forge.forge}`}>
    <div className={forge.topline}><Link href="/neurons"><ArrowLeft size={14}/>Library</Link><span>CHARACTER CREATION</span><span>Free · no transaction</span></div>
    <header className={forge.header}><h1>Character <span>forge.</span></h1><ol aria-label="Import progress">{['Load', 'Inspect', 'Publish'].map((label, index) => <li key={label} aria-current={stage === index + 1 ? 'step' : undefined} data-complete={stage > index + 1 || submitted}><span>{stage > index + 1 || submitted ? <Check size={13}/> : `0${index + 1}`}</span>{label}</li>)}</ol></header>
    <div className={forge.arena} data-loaded={!!personality}>
      <section className={forge.character} aria-label="Character preview">
        <div className={forge.characterLabel}><span>NEURO / {personality ? personality.ticker : 'EMPTY SLOT'}</span><span>{personality ? 'LOADED' : 'AWAITING IMPORT'}</span></div>
        <div className={forge.stage} aria-hidden="true"><div className={forge.halo}/><svg className={forge.sigil} viewBox="0 0 300 300" fill="none"><path d="M150 15 258 78V222L150 285 42 222V78Z"/><path d="M150 15V95M258 78 198 122M258 222 198 178M150 285V205M42 222 102 178M42 78 102 122M42 78 258 222M42 222 258 78"/><path d="m150 15 48 107 60 100-108-17-108 17 60-100Z"/><circle cx="150" cy="150" r="49"/><circle cx="150" cy="150" r="24"/>{[[150,15],[258,78],[258,222],[150,285],[42,222],[42,78]].map(([cx,cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4"/>)}</svg><div className={forge.platform}/></div>
        <div className={forge.characterName}><span>{personality ? `$${personality.ticker}` : 'YOUR NEXT CHARACTER'}</span><h2>{personality?.name ?? 'An empty canvas.'}</h2><p>{personality?.story ?? 'Bring a personality. Make it yours.'}</p></div>
        <div className={forge.status}><i/>{personality ? 'Unverified recipe' : 'No character loaded'}<span>Chat offline</span></div>
      </section>
      <section className={forge.console} aria-label="Personality controls">
        <div className={forge.panelTitle}><span>0{stage} / {['IMPORT', 'LOADOUT', 'PUBLICATION'][stage - 1]}</span><FileJson size={17}/></div>
        <h2 ref={heading} tabIndex={-1}>{personality ? publishReady ? 'Ready for the library.' : 'Meet your character.' : 'Load a personality.'}</h2>
        {!personality ? <>
          {recovered && <button className={forge.resume} type="button" onClick={() => { fileEpoch.current++; const value = JSON.stringify(recovered, null, 2); setRaw(value); setRecovered(null); setError(''); load(value) }}><span>CONTINUE SAVED CHARACTER<strong>{recovered.name}</strong></span><ArrowRight size={18}/></button>}
          <div className={forge.dropzone} data-dragging={dragging} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]) }}>
            <Upload size={27}/><strong>Drop your personality here</strong><span>Qwen3-8B · JSON · up to 8 KiB</span><button type="button" className="button primary" onClick={() => fileInput.current?.click()}>Choose file<ArrowRight size={16}/></button><input ref={fileInput} className={forge.fileInput} aria-label="Personality JSON file" type="file" accept=".json,application/json" onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = '' }}/>
          </div>
          <details className={forge.drawer} open={raw ? true : undefined}><summary>Paste or edit JSON<ChevronDown size={15}/></summary><form onSubmit={review}><textarea aria-label="Personality JSON" rows={7} maxLength={PERSONALITY_IMPORT_BYTES} spellCheck={false} value={raw} placeholder="Paste personality JSON…" onChange={event => { fileEpoch.current++; setRaw(event.target.value); setError('') }}/><button className="button primary" type="submit" disabled={!raw.trim()}>Load character<ArrowRight size={15}/></button></form></details>
          {error && <p className={forge.error} role="alert">{error}</p>}
          <a className={forge.template} href={template} download="personality-template.json">Need the format? Get the template ↗</a>
        </> : <>
          {!publishReady && <><div className={forge.slots} aria-label="Recipe loadout"><div><Cpu size={19}/><span>MODEL<strong>Qwen3-8B</strong></span></div><div><Layers3 size={19}/><span>LAYER / NEURON<strong>{personality.steering.layer} / {personality.steering.neuron}</strong></span></div><div><Zap size={19}/><span>STEERING<strong>{personality.steering.direction === 'up' ? '↑ Up' : '↓ Down'} · α {personality.steering.alpha}</strong></span></div></div>
            <NeuronConcepts concepts={personality.associatedConcepts}/>
            {personality.examples.length > 0 && <details className={forge.drawer}><summary>Personality samples<span>{personality.examples.length}<ChevronDown size={15}/></span></summary><small>Creator-supplied · not evaluated</small>{personality.examples.map((example, index) => <blockquote key={index}><strong>{example.prompt}</strong><p>{example.reply}</p></blockquote>)}</details>}
          </>}
          <details className={forge.drawer}><summary>Recipe & attribution<ChevronDown size={15}/></summary><dl><div><dt>Model</dt><dd>{personality.model.id}</dd></div><div><dt>Pinned revision</dt><dd><code>{personality.model.revision}</code></dd></div><div><dt>Attribution</dt><dd>{personality.attribution.author}<a href={personality.attribution.url} target="_blank" rel="noreferrer">View source ↗</a></dd></div></dl></details>
          {publishReady ? <div className={forge.publish}>{publishing ? <NeuronPublishAction draft={{ personality }} genesisHash={publishing.genesisHash} botSiteKey={publishing.botSiteKey} request={request} draftStorageKey={PERSONALITY_IMPORT_DRAFT_KEY} onSubmitted={() => setSubmitted(true)} onBusyChange={setBusy}/> : <p className={forge.offline}>Publishing is off. Your browser draft is ready.</p>}</div> : <button className={`button primary ${forge.continue}`} type="button" onClick={() => setPublishReady(true)}>Continue to publish<ArrowRight size={17}/></button>}
          {!submitted && <button type="button" className={forge.back} disabled={busy} onClick={() => { if (publishReady) setPublishReady(false); else setPersonality(null); setError('') }}><ArrowLeft size={14}/>{publishReady ? 'Back to character' : 'Change recipe'}</button>}
        </>}
        <details className={`${forge.drawer} ${forge.fineprint}`}><summary>Before you publish<ChevronDown size={14}/></summary><p>Recipes and examples are unverified. Content review is required before sharing. No live chat, tokens, trading, paid calls, or deployment. Never include secrets. Changes need a new submission.</p>{!personality && <p>The template needs your model’s exact 40-character commit SHA.</p>}</details>
      </section>
    </div>
  </main>
}
