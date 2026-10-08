import { RootDocument } from '../components/root-document'
import { siteMetadata, siteViewport } from '../lib/site-metadata.mjs'
export const metadata = { ...siteMetadata, openGraph: { ...siteMetadata.openGraph, locale: 'ja_JP' } }
export const viewport = siteViewport
export default function JaLayout({ children }) { return <RootDocument lang="ja">{children}</RootDocument> }
