import { AppHeader, Footer } from '../../components/ui'
import { ContentSkeleton } from '../../components/loading-skeleton'
import { PartsHeader, PartsReadme } from '../../components/parts-browse'

export default function Loading() {
  return <><AppHeader active="parts"/><main className="section-wrap parts-browse"><PartsHeader/>
    <div className="parts-browse-grid"><ContentSkeleton label="Loading parts lists" rows={3}/><PartsReadme/></div></main><Footer/></>
}
