'use client'
import { useEffect, useState } from 'react'
export function Participation({repoId}) {
  const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{let active=true;fetch(`/api/participation/${repoId}`,{cache:'no-store'}).then(r=>r.json()).then(d=>{if(active)setData(d)}).catch(()=>{});return()=>{active=false}},[repoId])
  async function update() {
    setBusy(true);setError('')
    try {
      const response=await fetch(`/api/participation/${repoId}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({review:data.review,enabled:!data.enabled})})
      const result=await response.json();if(!response.ok)throw Error(result.error)
      setData(current=>({...current,enabled:result.enabled}))
    }catch(cause){setError(cause.message)}finally{setBusy(false)}
  }
  if(!data?.signedIn)return null
  return <section className="inner-card participation-setting"><h3>Show you’ve joined</h3><p>Optionally show “Maintainer joined” on this market with your GitHub username. This is separate from claiming and does not endorse the token.</p>
    <button className="button outline" disabled={busy} onClick={update}>{busy?'Saving…':data.enabled?'Remove participation badge':'Show maintainer badge'}</button>
    {data.enabled&&!busy&&<small role="status">Your participation badge is visible.</small>}{error&&<p className="inline-error" role="alert">{error}</p>}
  </section>
}
