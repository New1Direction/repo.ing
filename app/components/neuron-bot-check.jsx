'use client'
import Script from 'next/script'
import { useEffect, useRef, useState } from 'react'

// Imperative execution asks for a fresh single-use token only when needed.
// interaction-only keeps normal sign-in uncluttered but permits an accessible challenge.
export function NeuronBotCheck({ siteKey, action, checkRef }) {
  const container = useRef(null), widget = useRef(null), pending = useRef(null)
  const [loaded, setLoaded] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    if (!siteKey) { checkRef.current = async () => null; return () => { checkRef.current = null } }
    const finish = (error, token) => {
      if (!pending.current) return
      const job = pending.current; pending.current = null; clearTimeout(job.timer)
      // The submitting form displays execution failures; keep widget errors for startup only.
      if (error) job.reject(error); else job.resolve(token)
    }
    checkRef.current = () => new Promise((resolve, reject) => {
      if (!loaded || !window.turnstile || widget.current === null) { reject(Error('Security check is loading. Please try again.')); return }
      if (pending.current) { reject(Error('A security check is already running.')); return }
      setError('')
      pending.current = { resolve, reject, timer: setTimeout(() => finish(Error('Security check timed out. Please try again.')), 120000) }
      try { window.turnstile.reset(widget.current); window.turnstile.execute(widget.current) }
      catch { finish(Error('Security check unavailable. Please try again.')) }
    })
    if (loaded && window.turnstile) try { widget.current = window.turnstile.render(container.current, {
      sitekey: siteKey, action, execution: 'execute', appearance: 'interaction-only', size: 'flexible',
      'response-field': false, callback: token => finish(null, token),
      'error-callback': () => finish(Error('Security check failed. Please try again.')),
      'expired-callback': () => finish(Error('Security check expired. Please try again.')),
      'timeout-callback': () => finish(Error('Security check timed out. Please try again.')),
    }) } catch { setError('Security check could not start. Please reload and try again.') }
    return () => {
      if (pending.current) {
        clearTimeout(pending.current.timer)
        pending.current.reject(Error('Security check cancelled. Please try again.')); pending.current = null
      }
      if (widget.current !== null) window.turnstile?.remove(widget.current)
      widget.current = null; checkRef.current = null
    }
  }, [siteKey, action, loaded, checkRef])
  if (!siteKey) return null
  return <div>
    <Script id="neuron-turnstile" src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" onReady={() => setLoaded(true)} onError={() => setError('Security check could not load. Allow challenges.cloudflare.com and retry.')}/>
    <div ref={container} aria-label="Security verification"/>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>
}
