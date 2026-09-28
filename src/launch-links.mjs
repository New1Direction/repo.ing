// Shared by the README helper and MCP. These links only open a review.
export function launchRepositoryUrl(input) {
  let value = String(input ?? '').trim()
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = `https://github.com/${value}`
  if (value.startsWith('github.com/')) value = `https://${value}`
  const url = new URL(value)
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password ||
      url.search || url.hash || parts.length !== 2 || parts.some(p => !/^[\w.-]+$/.test(p) || /^\.+$/.test(p))) {
    throw Error('Use a public GitHub repository URL: github.com/owner/repository.')
  }
  const name = parts[1].replace(/\.git$/i, '')
  if (!name || /^\.+$/.test(name)) throw Error('Invalid GitHub repository name.')
  return `https://github.com/${parts[0]}/${name}`
}

export function launchReadmeMarkdown(input) {
  const repo = launchRepositoryUrl(input)
  return `[![Launch on repo.ing](https://repo.ing/launch-on-repoing.svg)](https://repo.ing/launch?repo=${encodeURIComponent(repo)})`
}

// Runs only when the user clicks their saved bookmark; never submits a launch.
export const launchBookmarklet = "javascript:(()=>{const u=new URL(location.href);const p=u.pathname.split('/').filter(Boolean);if(u.hostname!=='github.com'||p.length!==2){alert('Open a GitHub repository home page first.');return;}location.href='https://repo.ing/launch?repo='+encodeURIComponent('https://github.com/'+p.join('/'));})()"
