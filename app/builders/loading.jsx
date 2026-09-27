import { AppHeader, Footer } from '../components/ui'
export default function Loading() {
  return <><AppHeader active="builders"/><main className="section-wrap builders-page"><div className="builders-intro"><h1>Builder dashboard</h1><p role="status">Loading your repositories…</p></div></main><Footer/></>
}
