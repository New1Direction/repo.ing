'use client'
import { useState } from 'react'
import { CUSTOM_POLICY_PREVIEW_PIN, previewCustomOwnerRule } from '../../src/hooklab-custom-policy-preview.mjs'

export function HookCustomPolicyPreview({ contract }) {
  const [owners, setOwners] = useState({ blockedOwner: '', sourceOwner: '', destinationOwner: '' })
  const [result, setResult] = useState(null), [error, setError] = useState('')
  const labels = { blockedOwner: 'Owner selected for rejection', sourceOwner: 'Transfer source owner', destinationOwner: 'Transfer destination owner' }
  function edit(key, value) { setOwners({ ...owners, [key]: value }); setResult(null); setError('') }
  function preview() {
    try { setResult(previewCustomOwnerRule({ schema: 'repoing/custom-policy-preview/1', ...owners })); setError('') }
    catch { setResult(null); setError('Enter three canonical public addresses. The selected owner cannot be the all-zero system address.') }
  }
  return <div className="hooks-creator-grid">
    <section className="hooks-card" aria-labelledby="custom-policy-title">
      <span className="badge">Local review only</span>
      <h2 id="custom-policy-title">One immutable owner-rejection rule</h2>
      <p>The candidate checks a native token transfer before it runs. It rejects the transfer when either its source owner or destination owner matches one selected public address.</p>
      <p>This policy has no update or close instruction. Buy, sell and graduation transfers can also be rejected. It does not provide burns, fee splitting, wallet limits, locks or the six Playground modules.</p>
      <fieldset className="coin-fields"><legend>Preview the rule with public addresses</legend>
        {Object.entries(labels).map(([key, label]) => <label key={key} htmlFor={`custom-${key}`}>{label}
          <input id={`custom-${key}`} value={owners[key]} onChange={event => edit(key, event.target.value)} maxLength={44} autoComplete="off" spellCheck={false} aria-describedby="custom-preview-help"/>
        </label>)}
      </fieldset>
      <p id="custom-preview-help" className="hooks-fine">Addresses stay in this page’s memory. Nothing is saved or sent by this preview. No wallet, mint, policy account or transaction is created.</p>
      <button className="button" type="button" onClick={preview}>Preview this rule</button>
      {error && <p className="coin-error" role="alert">{error}</p>}
      <div aria-live="polite" aria-atomic="true">
        {result ? <><h3>{result.result === 'rejected-by-this-rule' ? 'This rule would reject this transfer' : 'This rule would not reject this transfer'}</h3>
          <p>{result.sourceBlocked && result.destinationBlocked ? 'Both owners match the selected address.' : result.sourceBlocked ? 'The source owner matches the selected address.' : result.destinationBlocked ? 'The destination owner matches the selected address.' : 'Neither owner matches the selected address.'}</p>
          <p className="hooks-fine">This is a local address comparison, not an onchain simulation or permission to trade. Other policy checks, pauses and liquidity can still prevent a transfer or exit.</p></> : <p className="hooks-fine">No preview yet. Enter all three addresses explicitly.</p>}
      </div>
    </section>
    <aside className="hooks-card" aria-labelledby="custom-lifecycle-title">
      <h2 id="custom-lifecycle-title">Release status</h2>
      <dl className="coin-terms">
        <div><dt>Deployment adoption</dt><dd>{contract.activeProfile === null ? 'Not adopted by this app' : 'Requires independent review'}</dd></div>
        <div><dt>Onchain state</dt><dd>Unverified; not queried</dd></div>
        <div><dt>Candidate initialization</dt><dd>Creation and trading initially paused; creator grants disabled</dd></div>
        <div><dt>Custom execution</dt><dd>{contract.capabilities.customHook === false ? 'Unavailable' : 'Not enabled by this preview'}</dd></div>
        <div><dt>Accepted operation receipts</dt><dd>None provided to this preview</dd></div>
      </dl>
      <p className="hooks-fine">Preparation requires the future mint’s signature and one-time canonical policy and registry accounts. Creation also requires reviewed immutable callback code, current admin co-signing and an approved creator grant.</p>
      <button className="button primary" disabled>Prepare unavailable</button>
      <button className="button" disabled>Sign and launch unavailable</button>
      <details><summary>Exact candidate pins</summary>
        <p className="hooks-address">Hook program<code>{CUSTOM_POLICY_PREVIEW_PIN.program}</code></p>
        <p className="hooks-address">Source commit<code>{CUSTOM_POLICY_PREVIEW_PIN.sourceCommit}</code></p>
        <p className="hooks-address">Callback IDL SHA-256<code>{CUSTOM_POLICY_PREVIEW_PIN.idlSha256}</code></p>
        <p className="hooks-address">Candidate profile SHA-256<code>{CUSTOM_POLICY_PREVIEW_PIN.profileSha256}</code></p>
        <p className="hooks-fine">These are local source/ABI pins. They are not finalized deployment, ownership or spending approval.</p>
      </details>
    </aside>
  </div>
}
