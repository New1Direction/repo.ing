// Icon-pack illustrations in public/art: transparent WebP cutouts of the owner's originals (never the originals
// themselves), trimmed and centred on a square canvas with uniform padding. size is the exported edge in px.
export const ART = {
  'earnings-wallet': { size: 480 },
  'maintainer-card': { size: 360 },
  'repo-coin-01': { size: 320 },
  'repository-launch': { size: 480 },
  'repository-search': { size: 400 },
  'rocket': { size: 320 },
  'verified-shield-02': { size: 320 },
}

export const artSource = name => `/art/${name}.webp`
