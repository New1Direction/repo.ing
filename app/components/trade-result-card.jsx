'use client'
import { CheckCircle2, CircleAlert, Clock3, ExternalLink, RefreshCw, X } from 'lucide-react'
import { formatSolDisplay, formatUnits } from '../lib/format.mjs'

export function TradeResultCard({ result, symbol, onClose, onCheck }) {
  if (!result) return null
  const { state, direction, signature } = result
  const action = direction === 'buy' ? 'Buy' : 'Sell'
  const confirmed = state === 'confirmed'
  const onChain = confirmed || state === 'chainConfirmed'
  const checking = state === 'pending' || state === 'chainConfirmed'
  const title = confirmed ? `${action} confirmed` : state === 'chainConfirmed' ? 'Confirmed on Solana' :
    state === 'pending' ? `Checking your ${direction}` : state === 'expired' ? `${action} expired` :
      signature ? `${action} failed on Solana` : `${action} was not submitted`
  const message = confirmed
    ? direction === 'buy'
      ? `Received ${formatUnits(result.tokenDelta, 6, 4)} ${symbol}.`
      : `Your wallet gained ${formatSolDisplay(result.solDelta)} SOL after transaction costs.`
    : state === 'chainConfirmed' ? 'The transaction succeeded on Solana. Market details and balances may take a moment to update.'
      : state === 'pending' ? 'The signed transaction has no final result yet. Please wait before trying the same trade again.'
        : state === 'expired' ? 'The transaction was not confirmed before its blockhash expired. No swap was recorded.'
          : result.message || 'The transaction did not complete.'
  return <aside className={`trade-result-card ${confirmed ? 'confirmed' : checking ? 'checking' : 'failed'}`}
    role={checking || confirmed ? 'status' : 'alert'} aria-live={checking || confirmed ? 'polite' : 'assertive'}>
    <div className="trade-result-icon">{onChain ? <CheckCircle2 size={25}/> : checking ? <Clock3 size={25}/> : <CircleAlert size={25}/>}</div>
    <div className="trade-result-content">
      <div className="trade-result-heading"><strong>{title}</strong><button type="button" onClick={onClose} aria-label="Dismiss trade confirmation"><X size={18}/></button></div>
      <p>{message}</p>
      {confirmed && result.feeIndexing !== 'recorded' && <small>Repository fee indexing is still catching up.</small>}
      <div className="trade-result-actions">
        {signature && <a href={`https://explorer.solana.com/tx/${signature}?cluster=mainnet-beta`} target="_blank" rel="noopener noreferrer">
          View transaction <ExternalLink size={14}/>
        </a>}
        {checking && <button type="button" onClick={onCheck}><RefreshCw size={14}/> Check status</button>}
      </div>
    </div>
  </aside>
}
