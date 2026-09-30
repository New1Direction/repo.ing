// Icon-pack illustrations in public/art: WebP derivatives of the owner's originals (never the originals themselves).
// size is the exported edge in px; background is the art's own studio background, used for its tile.
export const ART = {
  'earnings-wallet': { size: 480, background: '#fefefc' },
  'maintainer-card': { size: 360, background: '#edeae6' },
  'repo-coin-01': { size: 320, background: '#fefefc' },
  'repository-launch': { size: 480, background: '#fefefc' },
  'repository-search': { size: 400, background: '#fefefc' },
  'rocket': { size: 320, background: '#f2efeb' },
  'verified-shield-02': { size: 320, background: '#fefefc' },
}

export const artSource = name => `/art/${name}.webp`
