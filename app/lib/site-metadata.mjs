// Static file in public/ rather than the opengraph-image convention: every segment that sets openGraph
// (both root layouts, /ja) would replace convention-injected images anyway, so it is referenced explicitly.
export const siteImage = { url: '/opengraph-image.png', width: 1200, height: 630, alt: 'repo.ing — Launch open source markets. Every trade pays the builders.' }

// og/twitter titles and descriptions are left unset so Next fills them from each page's own title/description.
export const siteMetadata = {
  metadataBase: new URL('https://repo.ing'),
  title: 'repo.ing — Open source markets',
  description: 'The market layer for open source. Launch and trade tokens for public GitHub repositories — every trade pays the builders.',
  openGraph: { type: 'website', siteName: 'repo.ing', locale: 'en_US', images: [siteImage] },
  twitter: { card: 'summary_large_image', images: [siteImage] },
}
// viewport-fit=cover lets env(safe-area-inset-*) report the iPhone home bar and notch, so fixed bars (the mobile trade bar)
// and the page gutters stay clear of them.
export const siteViewport = { viewportFit: 'cover' }
