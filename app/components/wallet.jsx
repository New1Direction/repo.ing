'use client'

import Link from 'next/link'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { getWallets } from '@wallet-standard/app'
import { ArrowRight, ChevronDown, LogOut, Wallet, X } from 'lucide-react'
import { CopyAddress } from './copy-address'
import { createWalletProvider, listSolanaWallets } from '../lib/solana-wallet.mjs'

const WalletContext = createContext(null)
const registry = getWallets()
const STORAGE_KEY = 'repo.ing.selected-wallet'
const walletDownloads = [
  { name: 'Phantom', url: 'https://phantom.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/download' },
  { name: 'MetaMask', url: 'https://metamask.io/download' },
]

function rememberedWallet() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return typeof value?.id === 'string' && typeof value?.name === 'string' ? value : null
  } catch { return null }
}

function saveWallet(choice) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: choice.id, name: choice.name })) } catch {}
}

function forgetWallet() {
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
}

let metamaskLoading
function loadMetaMask() {
  if (!metamaskLoading) metamaskLoading = import('@metamask/connect-solana').then(async ({ createSolanaClient }) => {
    const client = await createSolanaClient({ dapp: { name: 'repo.ing', url: window.location.origin } })
    await client.registerWallet()
  }).catch(error => { metamaskLoading = null; throw error })
  return metamaskLoading
}

export function WalletProvider({ children }) {
  const [wallet, setWallet] = useState(null)
  const [walletName, setWalletName] = useState('')
  const [walletIcon, setWalletIcon] = useState(null)
  const [error, setError] = useState('')
  const [choices, setChoices] = useState([])
  const [choosing, setChoosing] = useState(false)
  const [loadingWallets, setLoadingWallets] = useState(false)
  const [connectingId, setConnectingId] = useState(null)
  const [restoring, setRestoring] = useState(true)
  const selectedProvider = useRef(null)
  const selectedChoice = useRef(null)
  const unsubscribe = useRef(null)
  const pendingChoice = useRef(null)
  const generation = useRef(0)
  const restoreAttempted = useRef(false)
  const connecting = useRef(false)
  const dialog = useRef(null)

  function attach(provider, choice, address) {
    unsubscribe.current?.()
    selectedProvider.current = provider
    selectedChoice.current = choice
    setWallet(address)
    setWalletName(choice.name)
    setWalletIcon(choice.icon ?? null)
    setError('')
    saveWallet(choice)
    unsubscribe.current = provider.subscribe?.(nextAddress => {
      if (selectedProvider.current !== provider) return
      if (nextAddress) setWallet(nextAddress)
      else {
        unsubscribe.current?.()
        unsubscribe.current = null
        selectedProvider.current = null
        selectedChoice.current = null
        setWallet(null)
        setWalletName('')
        setWalletIcon(null)
        setError('Wallet disconnected. Connect again to continue.')
      }
    }) ?? null
  }

  useEffect(() => {
    let active = true
    const remembered = rememberedWallet()
    const refresh = () => {
      if (!active) return
      const available = listSolanaWallets(registry.get(), window)
      setChoices(available)
      if (restoreAttempted.current) return
      if (!remembered || selectedProvider.current) {
        setRestoring(false)
        return
      }
      const choice = available.find(item => item.id === remembered.id) ??
        available.find(item => item.name === remembered.name)
      if (!choice) { setRestoring(false); return }
      restoreAttempted.current = true
      const attempt = generation.current
      const feedbackTimer = window.setTimeout(() => { if (active) setRestoring(false) }, 2000)
      void (async () => {
        try {
          const provider = createWalletProvider(choice)
          const result = await provider.connect({ silent: true })
          const address = result?.publicKey?.toBase58?.()
          if (active && generation.current === attempt && !selectedProvider.current && address) attach(provider, choice, address)
        } catch { /* Silent reconnect may fail when a wallet is locked or no longer authorized. */ }
        finally {
          window.clearTimeout(feedbackTimer)
          if (active) setRestoring(false)
        }
      })()
    }
    refresh()
    const offRegister = registry.on('register', refresh)
    const offUnregister = registry.on('unregister', refresh)
    if (remembered?.name.toLowerCase().includes('metamask')) void loadMetaMask().catch(refresh)
    return () => {
      active = false
      offRegister()
      offUnregister()
      restoreAttempted.current = false
      unsubscribe.current?.()
      unsubscribe.current = null
      pendingChoice.current?.reject(new Error('Wallet selection closed'))
      pendingChoice.current = null
    }
  }, [])

  useEffect(() => {
    if (!choosing) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.querySelector('button')?.focus()
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); cancelChoice() }
      if (event.key !== 'Tab') return
      const elements = [...dialog.current.querySelectorAll('button, a[href]')]
      const first = elements[0], last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKeyDown) }
  }, [choosing])

  function openChooser() {
    if (pendingChoice.current) return pendingChoice.current.promise
    generation.current++
    setRestoring(false)
    setChoices(listSolanaWallets(registry.get(), window))
    setError('')
    setChoosing(true)
    setLoadingWallets(true)
    void loadMetaMask().catch(() => { /* Other installed wallets remain available. */ }).finally(() => setLoadingWallets(false))
    const promise = new Promise((resolve, reject) => { pendingChoice.current = { resolve, reject } })
    pendingChoice.current.promise = promise
    return promise
  }

  function connect() {
    if (wallet && selectedProvider.current) return Promise.resolve(wallet)
    return openChooser()
  }

  function changeWallet() { return openChooser() }

  async function selectWallet(choice) {
    if (connecting.current) return
    if (selectedChoice.current?.id === choice.id && wallet) {
      setChoosing(false)
      pendingChoice.current?.resolve(wallet)
      pendingChoice.current = null
      return wallet
    }
    const attempt = ++generation.current
    connecting.current = true
    setConnectingId(choice.id)
    setError('')
    try {
      const provider = createWalletProvider(choice)
      const result = await provider.connect()
      const address = (result?.publicKey ?? provider.publicKey)?.toBase58?.()
      if (!address) throw new Error(`${choice.name} did not return a Solana address`)
      if (generation.current !== attempt) return null
      attach(provider, choice, address)
      setChoosing(false)
      pendingChoice.current?.resolve(address)
      pendingChoice.current = null
      return address
    } catch (cause) {
      if (generation.current === attempt) setError(cause?.message || 'Wallet connection failed. Try another wallet.')
      return null
    } finally {
      if (generation.current === attempt) {
        connecting.current = false
        setConnectingId(null)
      }
    }
  }

  function cancelChoice() {
    generation.current++
    connecting.current = false
    setChoosing(false)
    setConnectingId(null)
    setError('')
    pendingChoice.current?.reject(new Error('Wallet selection cancelled'))
    pendingChoice.current = null
  }

  async function disconnect() {
    generation.current++
    const provider = selectedProvider.current
    unsubscribe.current?.()
    unsubscribe.current = null
    selectedProvider.current = null
    selectedChoice.current = null
    forgetWallet()
    setWallet(null)
    setWalletName('')
    setWalletIcon(null)
    setError('')
    try { await provider?.disconnect?.() } catch { /* The site connection is cleared even if the extension refuses. */ }
  }

  return <WalletContext.Provider value={{ wallet, walletName, walletIcon, error, restoring,
    connect, changeWallet, disconnect, provider: () => selectedProvider.current }}>
    {children}
    {choosing && <div className="wallet-overlay" onMouseDown={event => { if (event.target === event.currentTarget) cancelChoice() }}>
      <div ref={dialog} className="wallet-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title">
        <div className="wallet-dialog-heading"><div><span>Solana mainnet</span><h2 id="wallet-dialog-title">Connect a wallet</h2></div><button type="button" aria-label="Close wallet chooser" onClick={cancelChoice}><X size={21}/></button></div>
        <p>Choose a wallet to trade and claim. You approve every transaction in your wallet.</p>
        <div className="wallet-list-label">Available wallets <span>{choices.length ? `${choices.length} option${choices.length === 1 ? '' : 's'}` : loadingWallets ? 'Checking…' : 'None found'}</span></div>
        <div className="wallet-options">{choices.map(choice => <button type="button" key={choice.id} disabled={Boolean(connectingId)} onClick={() => { void selectWallet(choice) }}>
          {choice.icon ? <img src={choice.icon} alt=""/> : <span className="wallet-option-icon"><Wallet size={20}/></span>}
          <span className="wallet-option-name">{choice.name}</span><span className="wallet-option-state">{connectingId === choice.id ? 'Connecting…' : 'Connect'}</span><ArrowRight size={17} aria-hidden="true"/>
        </button>)}</div>
        {!choices.length && <p className="wallet-empty" role="status">{loadingWallets ? 'Checking supported wallets…' : 'Install a Solana wallet, then return here to connect.'}</p>}
        {error && <p className="wallet-dialog-error" role="alert">{error}</p>}
        <div className="wallet-downloads"><span>Need a wallet?</span>{walletDownloads.map(item => <a key={item.name} href={item.url} target="_blank" rel="noopener noreferrer">{item.name} ↗</a>)}</div>
      </div>
    </div>}
  </WalletContext.Provider>
}

export function useWallet() { return useContext(WalletContext) }

export function WalletButton() {
  const { wallet, walletName, walletIcon, error, restoring, connect, changeWallet, disconnect } = useWallet()
  const [open, setOpen] = useState(false)
  const control = useRef(null)

  useEffect(() => {
    if (!open) return
    const closeOutside = event => { if (!control.current?.contains(event.target)) setOpen(false) }
    const closeEscape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [open])

  useEffect(() => { if (!wallet) setOpen(false) }, [wallet])

  return <div ref={control} className="wallet-control">
    <button type="button" className={`button outline wallet-button${wallet ? ' connected' : ''}`} aria-expanded={wallet ? open : undefined}
      aria-label={wallet ? `Wallet ${wallet.slice(0, 4)}…${wallet.slice(-4)}; open account menu` : 'Connect wallet'}
      onClick={() => wallet ? setOpen(value => !value) : connect().catch(() => {})}>
      {wallet ? <>{walletIcon ? <img src={walletIcon} alt=""/> : <Wallet size={17}/>}<span>{wallet.slice(0, 4)}…{wallet.slice(-4)}</span><ChevronDown size={16}/></> : restoring ? 'Connecting…' : 'Connect wallet'}
    </button>
    {wallet && open && <div className="wallet-account-menu">
      <div className="wallet-account-heading">{walletIcon ? <img src={walletIcon} alt=""/> : <Wallet size={22}/>}<div><strong>{walletName || 'Solana wallet'}</strong><span>Connected · Solana mainnet</span></div></div>
      <CopyAddress address={wallet} compact label="wallet address"/>
      <Link className="wallet-menu-action" href="/wallet" onClick={() => setOpen(false)}>My holdings & rewards<ArrowRight size={16}/></Link>
      <button type="button" className="wallet-menu-action" onClick={() => { setOpen(false); changeWallet().catch(() => {}) }}>Change wallet<ArrowRight size={16}/></button>
      <button type="button" className="wallet-menu-action" onClick={() => { setOpen(false); void disconnect() }}>Disconnect<LogOut size={16}/></button>
    </div>}
    {error && !wallet && <span className="wallet-error" role="alert">{error}</span>}
  </div>
}
