import assert from 'node:assert/strict'
import test from 'node:test'
import { repositoryAssetDirectory, repositoryLogoFromAssets, repositoryLogoFromReadme, safeGithubImageUrl } from '../src/repo-logo.mjs'
import { claimProgressStream } from '../src/claim-progress.mjs'

test('repository mascot wins over README screenshots and badges', () => {
  const readme = `[![build](https://img.shields.io/build.svg)](https://github.com)
<img src="./brand/preview-dark.png" alt="App screenshot" />
<img src="./brand/kikka-chinchilla.svg" alt="Kikka, the coral chinchilla mascot" />`
  assert.equal(repositoryLogoFromReadme(readme,
    'https://raw.githubusercontent.com/New1Direction/ohiyo/main/README.md', 'ohiyo'),
  'https://raw.githubusercontent.com/New1Direction/ohiyo/main/brand/kikka-chinchilla.svg')
  assert.equal(repositoryLogoFromReadme('![build](https://img.shields.io/build.svg)',
    'https://raw.githubusercontent.com/owner/repo/main/README.md', 'repo'), null)
  assert.equal(repositoryLogoFromReadme('![logo](https://tracker.example/logo.png)',
    'https://raw.githubusercontent.com/owner/repo/main/README.md', 'repo'), null)
  assert.equal(safeGithubImageUrl('https://tracker.example/logo.png'), null)
})

test('OpenClaw banner and unrelated README images leave the square owner avatar in place', () => {
  const readme = `<img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-banner-dark.png" alt="OpenClaw personal assistant" />
<img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/sponsors/nvidia-dark.svg" alt="NVIDIA" />`
  assert.equal(repositoryLogoFromReadme(readme,
    'https://raw.githubusercontent.com/openclaw/openclaw/main/README.md', 'openclaw'), null)
})

test('laya chooses its square logo mark beside a README lockup', () => {
  const readme = { path: 'README.md', download_url: 'https://raw.githubusercontent.com/NandhaKishorM/laya/main/README.md' }
  const lockup = 'https://raw.githubusercontent.com/NandhaKishorM/laya/main/assets/logo-lockup.png'
  const mark = 'https://raw.githubusercontent.com/NandhaKishorM/laya/main/assets/logo-mark.png'
  assert.equal(repositoryAssetDirectory(lockup, readme), 'assets')
  assert.equal(repositoryLogoFromAssets([
    { type: 'file', name: 'logo-lockup.png', download_url: lockup },
    { type: 'file', name: 'logo-mark-ink.png', download_url: 'https://raw.githubusercontent.com/NandhaKishorM/laya/main/assets/logo-mark-ink.png' },
    { type: 'file', name: 'logo-mark.svg', download_url: 'https://raw.githubusercontent.com/NandhaKishorM/laya/main/assets/logo-mark.svg' },
    { type: 'file', name: 'logo-mark.png', download_url: mark },
    { type: 'file', name: 'logo-icon.png', download_url: 'https://tracker.example/logo-icon.png' },
  ]), mark)
})

test('claim progress stays visible until a safe receipt or error redirect', async () => {
  const destination = 'https://repo.ing/claim/123?claimed=signature'
  const html = await new Response(claimProgressStream(async report => {
    report('GitHub admin access verified')
    report('Payout submitted. Waiting for Solana finality…')
    return destination
  }, 'https://repo.ing/claim/123?error=claim-failed')).text()
  assert.match(html, /Processing your claim/)
  assert.match(html, /GitHub admin access verified/)
  assert.match(html, /Payout submitted\. Waiting for Solana finality/)
  assert.match(html, /location\.replace\("https:\/\/repo\.ing\/claim\/123\?claimed=signature"\)/)

  const failed = await new Response(claimProgressStream(async () => { throw new Error('RPC failed') },
    'https://repo.ing/claim/123?error=claim-failed')).text()
  assert.match(failed, /location\.replace\("https:\/\/repo\.ing\/claim\/123\?error=claim-failed"\)/)
})
