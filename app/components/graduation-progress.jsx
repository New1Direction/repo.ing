import {formatUnits} from '../lib/format.mjs'
export function GraduationProgress({curve,error=false}){
  const sol=n=>formatUnits(n,9,9)
  return <section className="inner-card bonding-card" aria-label="Graduation progress">
    <div className="card-heading"><h3>Graduation Progress</h3><span className="badge">{curve?.phase??'Checking'}</span></div>
    {curve?curve.phase==='GRADUATED'?<>
      <p className="positive">Graduated to Meteora</p><div className="graduation-metrics"><span>DAMM liquidity <strong>{sol(curve.dammSolLamports)} SOL</strong><small>SOL side of the pool</small></span><span>24h DAMM volume <strong>{sol(curve.dammVolume24hLamports)} SOL</strong></span>{curve.protocolLiquidityAdded&&<span>Protocol liquidity added <strong>{sol(curve.protocolLiquidityAdded)} SOL</strong></span>}</div>
      <a className="button outline" href={curve.destination.url} target="_blank" rel="noopener noreferrer">Open Meteora pool ↗</a>
    </>:<><div className="graduation-numbers"><strong>{sol(curve.reserveLamports)} / {sol(curve.thresholdLamports)} SOL</strong><span>{curve.progressPercent.toFixed(2)}%</span></div>
      <div className="bonding-track" role="progressbar" aria-label="Progress to graduation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={curve.progressPercent}><span style={{width:`${curve.progressPercent}%`}}/></div>
      <p>{sol(curve.remainingLamports)} SOL remaining</p>{curve.status==='migrating'?<p role="status">Target reached. Waiting for verified migration.</p>:<small>Based on finalized curve reserves. Buys increase progress; sells can reduce it.</small>}
    </>:<p role="status">{error?'Graduation progress is being verified. Retrying automatically.':'Checking finalized reserves…'}</p>}
  </section>
}
