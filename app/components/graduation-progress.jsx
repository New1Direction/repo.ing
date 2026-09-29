import {formatUnits} from '../lib/format.mjs'
export function GraduationProgress({curve,error=false}){
  const exact=n=>formatUnits(n,9,9)
  const sol=n=>BigInt(n)>0n&&BigInt(n)<10000000n?'<0.01':Number(exact(n)).toLocaleString('en-US',{maximumFractionDigits:2})
  return <section className="inner-card bonding-card" aria-label="Graduation progress">
    <div className="card-heading"><h3>Graduation Progress</h3><span className="badge">{curve?.phase??'Checking'}</span></div>
    {curve?curve.phase==='GRADUATED'?<>
      <p className="positive">Graduated to Meteora</p><p className="graduation-explainer">Same token. Trading now continues in this repository’s verified DAMM pool.</p><div className="graduation-metrics"><span>DAMM liquidity <strong>{sol(curve.dammSolLamports)} SOL</strong><small>SOL side of the pool</small></span><span>24h DAMM volume <strong>{sol(curve.dammVolume24hLamports)} SOL</strong></span>{curve.protocolLiquidityAdded&&<span>Protocol liquidity added <strong>{sol(curve.protocolLiquidityAdded)} SOL</strong></span>}</div>
      <a className="button outline" href={curve.destination.url} target="_blank" rel="noopener noreferrer">View pool on Meteora ↗</a>
    </>:<><div className="graduation-numbers"><strong><small className="graduation-reserve-label">SOL held in the curve</small>{sol(curve.reserveLamports)} / {sol(curve.thresholdLamports)} SOL</strong><span>{curve.progressPercent.toFixed(2)}%</span></div>
      <div className="bonding-track" role="progressbar" aria-label="Progress to graduation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={curve.progressPercent}><span style={{width:`${curve.progressPercent}%`}}/></div>
      <div className="graduation-caption"><span>{sol(curve.remainingLamports)} SOL more in reserves to graduate</span><details><summary>Exact reserves</summary><p>{exact(curve.reserveLamports)} / {exact(curve.thresholdLamports)} SOL · {exact(curve.remainingLamports)} SOL remaining</p><small>Finalized on-chain reserves and this market’s configured target. Trading fees are separate. The remaining reserve is not a purchase quote.</small></details></div>
      <p className="graduation-explainer"><strong>Buys add SOL after fees. Sells reduce progress.</strong> Volume counts trading in both directions; graduation depends on the SOL that stays in the curve.</p>{curve.status==='migrating'&&<p role="status">Graduation in progress. The target is reached; trading resumes after the destination pool is verified.</p>}
    </>:<p role="status">{error?'Graduation progress is being verified. Retrying automatically.':'Checking finalized reserves…'}</p>}
  </section>
}
