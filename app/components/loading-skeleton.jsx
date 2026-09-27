import { AppHeader, Footer } from './ui'

export function ContentSkeleton({ label = 'Loading…', rows = 4 }) {
  return <div className="content-skeleton" role="status" aria-busy="true"><span className="sr-only">{label}</span>{Array.from({ length: rows }, (_, i) => <div className="skeleton-row" key={i} aria-hidden="true"><span className="skeleton-avatar"/><div><span className="skeleton-line"/><span className="skeleton-line short"/></div><span className="skeleton-line metric"/></div>)}</div>
}
export function RouteSkeleton({ title = 'Loading page', active = '', market = false }) {
  return <><AppHeader active={active}/><main className="section-wrap route-loading"><span className="sr-only" role="status">{title}…</span><div className="skeleton-intro" aria-hidden="true"><span className="skeleton-line"/><span className="skeleton-line short"/></div>{market ? <div className="market-grid"><div className="inner-card market-loading-chart"><ContentSkeleton label="Loading chart" rows={3}/></div><div className="inner-card market-loading-trade"><ContentSkeleton label="Loading trade panel" rows={3}/></div></div> : <ContentSkeleton label={title}/>}</main><Footer/></>
}
