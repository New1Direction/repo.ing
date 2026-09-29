import { AppHeader, Footer } from '../../../components/ui'

export default function Loading() {
  return <><AppHeader/><main className="section-wrap claim-page claim-page-loading" role="status" aria-live="polite"><span className="claim-spinner" aria-hidden="true"/><div><h1>Checking repository and fee state</h1><p>Loading current GitHub access, settled payouts, and available creator fees.</p></div></main><Footer/></>
}
