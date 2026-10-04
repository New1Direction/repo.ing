import {formatUnits} from '../lib/format.mjs'
import {stockAmountLabel,stockDisplayUnits} from '../lib/stock-display.mjs'
import {shownUnits} from '../lib/trade-units.mjs'

// A stock pair's bar (the curve route's stock answer, app/lib/stock-market-stats.mjs): its reserve and target are in the
// stock, shown as wallets show it once its units load (units: the metrics route's `quote`); the percent never needs them.
function StockGraduationProgress({curve,units}){
  const shown=units&&units.assetId===curve.quote.assetId&&units.decimals===curve.quote.decimals?stockDisplayUnits(units):null
  const symbol=curve.quote.symbol, amount=raw=>stockAmountLabel(raw,shown)
  const exact=raw=>shown?`${formatUnits(shownUnits(raw,shown),shown.decimals,shown.decimals)} ${symbol}`:'—'
  const graduated=curve.phase==='GRADUATED'
  return <section className="graduation-bar" aria-label="Graduation progress">
    <div className="graduation-row"><h3>Graduation</h3>
      {graduated?<a className="graduation-pool" href={curve.destination.url} target="_blank" rel="noopener noreferrer">Graduated → Meteora pool ↗</a>
      :<><div className="bonding-track" role="progressbar" aria-label="Progress to graduation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={curve.progressPercent}><span style={{width:`${curve.progressPercent}%`}}/></div>
        <strong className="graduation-percent">{curve.progressPercent.toFixed(2)}%</strong>{shown&&<span className="graduation-to-go">{amount(curve.remaining)} to go</span>}</>}
      <details className="graduation-details"><summary>{graduated?'Pool details':'Exact reserves'}</summary><div>
        {graduated?<p>Same token. Trading now continues in this repository’s verified DAMM pool.</p>
        :<>{shown?<><p>{symbol} held in the curve: {amount(curve.reserve)} / {amount(curve.threshold)}</p><p>{exact(curve.reserve)} / {exact(curve.threshold)} · {exact(curve.remaining)} remaining</p></>
            :<p>{symbol} amounts appear once its current display units load.</p>}
          <small>Finalized on-chain reserves and this market’s configured target, in {symbol} as wallets show it. Trading fees are separate. The remaining reserve is not a purchase quote. <strong>Buys add {symbol} after fees. Sells reduce progress.</strong> Volume counts trading in both directions; graduation depends on the {symbol} that stays in the curve.</small></>}
      </div></details>
    </div>
    {curve.status==='migrating'&&!graduated&&<p className="graduation-migrating" role="status">Graduation in progress. The target is reached; trading resumes after the destination pool is verified.</p>}
  </section>
}

// One slim row above the chart; exact reserves and pool details stay one click away.
export function GraduationProgress({curve,error=false,units=null}){
  if(curve?.quote)return <StockGraduationProgress curve={curve} units={units}/>
  const exact=n=>formatUnits(n,9,9)
  // Divide the raw lamports; formatUnits output has thousands separators that Number() cannot parse.
  const sol=n=>BigInt(n)>0n&&BigInt(n)<10000000n?'<0.01':(Number(BigInt(n))/1e9).toLocaleString('en-US',{maximumFractionDigits:2})
  const graduated=curve?.phase==='GRADUATED'
  return <section className="graduation-bar" aria-label="Graduation progress">
    <div className="graduation-row"><h3>Graduation</h3>
      {!curve?<p className="graduation-pending" role="status">{error?'Being verified. Retrying automatically.':'Checking finalized reserves…'}</p>
      :graduated?<><a className="graduation-pool" href={curve.destination.url} target="_blank" rel="noopener noreferrer">Graduated → Meteora pool ↗</a></>
      :<><div className="bonding-track" role="progressbar" aria-label="Progress to graduation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={curve.progressPercent}><span style={{width:`${curve.progressPercent}%`}}/></div>
        <strong className="graduation-percent">{curve.progressPercent.toFixed(2)}%</strong><span className="graduation-to-go">{sol(curve.remainingLamports)} SOL to go</span></>}
      {curve&&<details className="graduation-details"><summary>{graduated?'Pool details':'Exact reserves'}</summary><div>
        {graduated?<><p>Same token. Trading now continues in this repository’s verified DAMM pool.</p>
          <dl><div><dt>DAMM liquidity (SOL side)</dt><dd>{sol(curve.dammSolLamports)} SOL</dd></div><div><dt>24h DAMM volume</dt><dd>{sol(curve.dammVolume24hLamports)} SOL</dd></div>{curve.protocolLiquidityAdded&&<div><dt>Protocol liquidity added</dt><dd>{sol(curve.protocolLiquidityAdded)} SOL</dd></div>}</dl></>
        :<><p>SOL held in the curve: {sol(curve.reserveLamports)} / {sol(curve.thresholdLamports)} SOL</p><p>{exact(curve.reserveLamports)} / {exact(curve.thresholdLamports)} SOL · {exact(curve.remainingLamports)} SOL remaining</p>
          <small>Finalized on-chain reserves and this market’s configured target. Trading fees are separate. The remaining reserve is not a purchase quote. <strong>Buys add SOL after fees. Sells reduce progress.</strong> Volume counts trading in both directions; graduation depends on the SOL that stays in the curve.</small></>}
      </div></details>}
    </div>
    {curve?.status==='migrating'&&!graduated&&<p className="graduation-migrating" role="status">Graduation in progress. The target is reached; trading resumes after the destination pool is verified.</p>}
  </section>
}
