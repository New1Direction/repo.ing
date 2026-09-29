import { RootDocument } from './components/root-document'
import { NotFoundPage, notFoundMetadata } from './components/not-found-page'
import { siteMetadata } from './lib/site-metadata.mjs'

// With separate en/ja root layouts there is no single layout for unmatched URLs, so this renders the full document.
export const metadata = { ...siteMetadata, ...notFoundMetadata }
export default function GlobalNotFound() { return <RootDocument lang="en"><NotFoundPage/></RootDocument> }
