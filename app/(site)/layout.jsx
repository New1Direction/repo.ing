import { RootDocument } from '../components/root-document'
import { siteMetadata, siteViewport } from '../lib/site-metadata.mjs'
export const metadata = siteMetadata
export const viewport = siteViewport
export default function RootLayout({ children }) { return <RootDocument lang="en">{children}</RootDocument> }
