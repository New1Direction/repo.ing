import { RootDocument } from '../components/root-document'
import { siteMetadata } from '../lib/site-metadata.mjs'
export const metadata = siteMetadata
export default function RootLayout({ children }) { return <RootDocument lang="en">{children}</RootDocument> }
