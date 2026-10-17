'use client'
import { useRef, useState } from 'react'
import { HOOK_LAB_TEMPLATES, HOOK_LAB_BLOCKS, hookLabTemplateDraftSchema, exportHookLabTemplate } from '../../src/hook-lab-templates.mjs'
import { HooksUnavailable } from './hooks-ui'

// Presentation only: the existing recipe planner owns lossless storage and account revisions.
export function HooksDraftSteps({ envelope, change, disabled, initialTemplate, startTemplate }) {
  const [step, setStep] = useState(0)
  const heading = useRef(null)
  const { recipe } = envelope
  const draft = { templateId: envelope.template, coin: recipe.coin, blocks: recipe.blocks }
  const template = HOOK_LAB_TEMPLATES.find(item => item.id === envelope.template)
  // Check structure separately so an out-of-range edit never locks its own input.
  const editable = hookLabTemplateDraftSchema.safeParse({ ...draft, blocks: recipe.blocks.map(block => ({ ...block,
    ...Object.fromEntries(Object.entries(HOOK_LAB_BLOCKS[block.type]?.fields ?? {}).filter(([, field]) => field.fixed === undefined).map(([key]) => [key, null])),
  })) }).success
  let issues = []
  try { exportHookLabTemplate(draft) } catch (error) { issues = error.issues?.map(issue => `${issue.path.join(' · ')}: ${issue.message}`) ?? ['This recipe needs SDK review.'] }
  function move(next) { setStep(next); requestAnimationFrame(() => heading.current?.focus()) }
  function coin(key, value) { change({ ...envelope, recipe: { ...recipe, coin: { ...recipe.coin, [key]: value } } }) }
  function blocks(next) { change({ ...envelope, recipe: { ...recipe, blocks: next } }) }
  return <div className="hooks-builder">
    <ol className="hooks-steps" aria-label="Draft creation steps">{['Identity', 'Rules', 'Review', 'Launch'].map((label, index) => <li key={label}><button type="button" aria-current={step === index ? 'step' : undefined} onClick={() => move(index)}><span>{index + 1}</span>{label}</button></li>)}</ol>
    <div className="hooks-between"><span className="badge">{template?.title || 'Imported recipe'} · draft only</span><button className="button" disabled={disabled} onClick={() => startTemplate(initialTemplate)}>Start new {HOOK_LAB_TEMPLATES.find(item => item.id === initialTemplate)?.title} draft</button></div>
    {envelope.template !== initialTemplate && <p className="coin-note">Your existing device recipe is preserved. To use the requested template instead, export this recipe first, then explicitly start a new draft above.</p>}
    <h2 ref={heading} tabIndex={-1}>{['Give your coin an identity', 'Make every rule explicit', 'Review your recipe', 'Launch is not enabled'][step]}</h2>
    {!editable && <p className="coin-error" role="alert">This imported recipe contains fields or rules outside the guided editor. All fields are preserved. Export it for SDK review, or explicitly start a new draft.</p>}
    {step === 0 && <fieldset className="coin-fields" disabled={disabled}><legend className="sr-only">Coin identity</legend>
      <label>Coin name<input value={recipe.coin.name} onChange={event => coin('name', event.target.value)} aria-describedby="hooks-name-help"/><small id="hooks-name-help">Up to 32 UTF-8 bytes. No token is created by saving.</small></label>
      <label>Ticker<input value={recipe.coin.ticker} onChange={event => coin('ticker', event.target.value)} aria-describedby="hooks-ticker-help"/><small id="hooks-ticker-help">1–10 ASCII letters or digits. Case is retained in your backup.</small></label>
    </fieldset>}
    {step === 1 && <fieldset className="coin-fields" disabled={disabled || !editable}><legend className="sr-only">Recipe rules</legend>
      <p className="coin-note">Whole basis points (100 bps = 1%) and whole seconds. Blank is not zero. Protocol fees apply in addition to these rules.</p>
      {recipe.blocks.length === 0 && <p>No optional rules selected. This is not a fee-free launch.</p>}
      {editable && recipe.blocks.map((block, index) => <section className="coin-rule" key={block.type}><h3>{HOOK_LAB_BLOCKS[block.type].title}</h3>
        {Object.entries(HOOK_LAB_BLOCKS[block.type].fields).map(([key, field]) => <label key={key}>{field.label}<input type="number" min="0" max={field.unit === 'bps' ? 10000 : 4294967295} step="1" inputMode="numeric" value={block[key] ?? ''} readOnly={field.fixed !== undefined} aria-describedby={`hooks-${index}-${key}`} onChange={event => blocks(recipe.blocks.map((item, i) => i === index ? { ...item, [key]: event.target.value === '' ? null : Number(event.target.value) } : item))}/><small id={`hooks-${index}-${key}`}>{field.fixed !== undefined ? 'Fixed program constant. ' : ''}{field.help}{field.unit === 'bps' && block[key] !== null ? ` (${block[key] / 100}%)` : ''}</small></label>)}
        {template.optionalBlocks.includes(block.type) && <button className="button" onClick={() => blocks(recipe.blocks.filter((_, i) => i !== index))}>Remove {HOOK_LAB_BLOCKS[block.type].title}</button>}
      </section>)}
      {editable && <div className="coin-actions">{template.optionalBlocks.filter(type => !recipe.blocks.some(block => block.type === type)).map(type => <button className="button" key={type} onClick={() => blocks([...recipe.blocks, { type, ...Object.fromEntries(Object.entries(HOOK_LAB_BLOCKS[type].fields).map(([key, field]) => [key, field.fixed ?? null])) }])}>Add {HOOK_LAB_BLOCKS[type].title}</button>)}</div>}
    </fieldset>}
    {step === 2 && <><p className="coin-note">{issues.length ? 'This draft is incomplete or needs SDK review. You can still save and export it.' : 'Field format is complete. This is not a validated quote or launch approval.'}</p>
      {issues.length > 0 && <ul className="hooks-issues">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      <dl className="coin-terms"><div><dt>Identity</dt><dd>{recipe.coin.name || 'Name missing'} · {recipe.coin.ticker || 'Ticker missing'}</dd></div><div><dt>Rules</dt><dd>{recipe.blocks.length ? recipe.blocks.map(block => HOOK_LAB_BLOCKS[block.type]?.title || block.type).join(', ') : 'No optional rules'}</dd></div><div><dt>Total debit / minimum received</dt><dd>Unknown · not zero. No quote or simulation.</dd></div></dl><details><summary>Complete recipe · all retained fields</summary><pre>{JSON.stringify(recipe, null, 2)}</pre></details></>}
    {step === 3 && <><HooksUnavailable/><p>No transaction has been prepared, signed or submitted by this builder. Wallet connection cannot unlock launch.</p><p>Keep this draft or inspect existing operations in <a href="/hooks/mine">My coins</a>. A missing receipt never authorizes a new mint or a retry.</p><button className="button primary" disabled>Sign and launch — unavailable</button></>}
    <div className="hooks-step-actions"><button className="button" disabled={step === 0} onClick={() => move(step - 1)}>Back</button>{step < 3 && <button className="button primary" onClick={() => move(step + 1)}>{['Continue to rules', 'Review draft', 'View launch availability'][step]}</button>}</div>
  </div>
}
