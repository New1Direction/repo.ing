import {formatUnits} from '../lib/format.mjs'
export function GraduationProgress({curve,error=false}){
  const exact=n=>formatUnits(n,9,9)
  const sol=n=>BigInt(n)>0n&&BigInt(n)<10000000n?'<0.01':Number(exact(n)).toLocaleString('en-US',{maximumFractionDigits:2})
  return <section className="inner-card bonding-card" aria-label="Graduation progress">
    <div className="card-heading"><h3>Graduation Progress</h3><span className="badge">{curve?.phase??'Checking'}</span></div>
    {curve?curve.phase==='GRADUATED'?<>
      <p className="positive">Graduated to Meteora</p><div className="graduation-metrics"><span>DAMM liquidity <strong>{sol(curve.dammSolLamports)} SOL</strong><small>SOL side of the pool</small></span><span>24h DAMM volume <strong>{sol(curve.dammVolume24hLamports)} SOL</strong></span>{curve.protocolLiquidityAdded&&<span>Protocol liquidity added <strong>{sol(curve.protocolLiquidityAdded)} SOL</strong></span>}</div>
      <a className="button outline" href={curve.destination.url} target="_blank" rel="noopener noreferrer">Open Meteora pool ↗</a>
    </>:<><div className="graduation-numbers"><strong>{sol(curve.reserveLamports)} / {sol(curve.thresholdLamports)} SOL</strong><span>{curve.progressPercent.toFixed(2)}%</span></div>
      <div className="bonding-track" role="progressbar" aria-label="Progress to graduation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={curve.progressPercent}><span style={{width:`${curve.progressPercent}%`}}/></div>
      <div className="graduation-caption"><span>{sol(curve.remainingLamports)} SOL remaining</span><details><summary>Exact reserves</summary><p>{exact(curve.reserveLamports)} / {exact(curve.thresholdLamports)} SOL · {exact(curve.remainingLamports)} SOL remaining</p><small>Finalized curve reserves. Buys increase progress; sells can reduce it.</small></details></div>{curve.status==='migrating'&&<p role="status">Target reached. Waiting for verified migration.</p>}
    </>:<p role="status">{error?'Graduation progress is being verified. Retrying automatically.':'Checking finalized reserves…'}</p>}
  </section>
}
