'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, MessageCircle } from 'lucide-react'
import { HookWalletSignIn, useHookWalletSession } from './hooklab-wallet-signin'
import { NeuronBotCheck } from './neuron-bot-check'
import styles from './neurons-preview.module.css'

export function NeuronRecipeChat({ characterId, name, genesisHash, botSiteKey = null }) {
  const session = useHookWalletSession(genesisHash)
  const [text, setText] = useState(''), [messages, setMessages] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const log = useRef(null), input = useRef(null), bot = useRef(null), request = useRef(null), controller = useRef(null), epoch = useRef(0), working = useRef(false)
  useEffect(() => {
    epoch.current++; controller.current?.abort(); working.current = false; request.current = null
    setMessages([]); setText(''); setError(''); setBusy(false)
    return () => { epoch.current++; controller.current?.abort() }
  }, [characterId, session.identity?.wallet, session.signedIn])
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [messages, busy])
  useEffect(() => { if (messages.length > 0 && messages.length < 3 && !busy && session.signedIn) input.current?.focus() }, [messages, busy, session.signedIn])
  async function send(event) {
    event.preventDefault()
    const message = text.trim(), current = epoch.current
    if (!message || !session.signedIn || working.current || messages.length >= 3) return
    working.current = true; setBusy(true); setError('')
    if (!request.current) request.current = { conversationId: crypto.randomUUID() }
    if (request.current.message !== message) Object.assign(request.current, { message, requestId: crypto.randomUUID() })
    controller.current = new AbortController()
    try {
      if (botSiteKey && !bot.current) throw Error('Security check is loading. Please try again.')
      const token = botSiteKey ? await bot.current() : null
      if (current !== epoch.current) return
      const response = await fetch('/api/neuron-chat', { method: 'POST', credentials: 'same-origin',
        signal: AbortSignal.any([controller.current.signal, AbortSignal.timeout(35000)]),
        headers: { 'Content-Type': 'application/json', ...(token ? { 'x-neuron-bot-token': token } : {}) },
        body: JSON.stringify({ ...request.current, characterId }) })
      const value = await response.json()
      if (current !== epoch.current) return
      if (!response.ok) {
        request.current.message = null // A definitive failure starts a new, quota-counted attempt.
        throw Error(value.error || 'Chat could not complete. Try later.')
      }
      if (value.mode !== 'mock' || value.liveInference !== false || typeof value.reply !== 'string' || value.reply.length > 4000) throw Error('Unexpected chat response.')
      setMessages(previous => [...previous, { text: message, reply: value.reply }]); setText(''); request.current.message = null
      input.current?.focus()
    } catch (cause) { if (current === epoch.current) setError(cause.name === 'TimeoutError' || cause.name === 'AbortError' ? 'Chat timed out. Retry the same message to check its result.' : cause.message || 'Connection interrupted. Retry the same message.') }
    finally { if (current === epoch.current) { working.current = false; setBusy(false) } }
  }
  return <section className={styles.chatPanel} aria-label={`Mock chat with ${name}`}>
    <div className={styles.chatHeading}><MessageCircle size={22}/><div><strong>{name}</strong><span>Mock connection · no live AI or neuron steering</span></div></div>
    <div className={styles.recipeChatIdentity}><HookWalletSignIn genesisHash={genesisHash} session={session} title="Try the chat connection">Free wallet-message sign-in. No transaction. Replies are deterministic test fixtures.</HookWalletSignIn></div>
    <div className={styles.chatLog} ref={log} role="log" aria-label="Mock conversation" aria-live="polite">
      <div className={styles.chatDate}>CONNECTION TEST · NOT A PERSONALITY DEMO</div>
      {messages.length === 0 && <p className={styles.help}>Send a message to test recipe routing and saved conversation context. No model will run.</p>}
      {messages.map((message, index) => <div className={styles.messagePair} key={index}><div className={styles.userBubble}>{message.text}</div><div className={styles.assistantBubble}>{message.reply}</div><span className={styles.replyLabel}>Mock reply · fixture moderation only</span></div>)}
      {busy && <p className={styles.help} role="status"><LoaderCircle size={15} className={styles.spinner}/> Checking mock reply…</p>}
    </div>
    <div className={styles.composerArea}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <form className={styles.composer} onSubmit={send}><textarea ref={input} aria-label={`Message ${name}`} rows={1} maxLength={500} value={text} disabled={!session.signedIn || busy || messages.length >= 3} placeholder={!session.signedIn ? 'Sign in above to try mock chat' : messages.length >= 3 ? 'Daily preview limit reached' : `Message ${name}…`} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit() } }}/><button type="submit" aria-label="Send mock message" disabled={!session.signedIn || busy || !text.trim() || messages.length >= 3}><ArrowUp size={20}/></button></form>
      <div className={styles.composerNote}>3 attempts per wallet per UTC day · errors count · no paid calls</div>
      <NeuronBotCheck siteKey={botSiteKey} action="neuron-chat" checkRef={bot}/>
    </div>
  </section>
}
