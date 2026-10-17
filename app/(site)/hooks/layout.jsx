import { AppHeader, Footer } from '../../components/ui'
import '../../direct-coins.css'
import './hooks.css'

export default function HooksLayout({ children }) {
  return <><a className="hooks-skip" href="#hooks-main">Skip to Hooks content</a><AppHeader active="hooks"/>
    <main id="hooks-main" tabIndex={-1} className="hooks-page">{children}</main><Footer/></>
}
