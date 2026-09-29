'use client'
import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AppHeader, Footer } from '../components/ui'
export default function PageError({ reset }) {
  const router = useRouter(), [pending, startTransition] = useTransition()
  return <><AppHeader/><main className="section-wrap route-loading"><div className="state-card" role="alert"><h1>This page couldn’t load</h1><p>Please try again. Check any pending wallet transaction before submitting another.</p><button className="button primary" disabled={pending} onClick={() => startTransition(() => { router.refresh(); reset() })}>{pending ? 'Retrying…' : 'Try again'}</button></div></main><Footer/></>
}
