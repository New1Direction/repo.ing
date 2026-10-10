#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
  AI_CREDITS_OFF,
  HELP,
  VERSION,
  aiCreditsOn,
  normalizeGithubRepository,
  parseArgs,
  requestLaunchDraft,
  safeBrowserUrl,
} from '../src/core.mjs'
import { claimHelp, parseClaimArgs, runClaim } from '../src/claim.mjs'
import { CREDITS_HELP, parseCreditsArgs, runCredits } from '../src/credits.mjs'

function currentGitRemote() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new Error('No GitHub origin found. Run this inside a GitHub repository or pass owner/repo.')
  }
}

// Only ever called with a link safeBrowserUrl accepted. On Windows not `cmd /c start`, which would also run shell syntax in it.
function openUrl(url) {
  const platform = process.platform
  let child
  if (platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' })
  else if (platform === 'win32') child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
  else child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

function printHuman(repository, result, opened) {
  const short = repository.replace('https://github.com/', '')
  console.log(`\nrepo.ing  ${short}`)

  if (result.live && result.marketUrl) {
    console.log('✓ canonical market already live')
    console.log(`→ ${result.marketUrl}`)
    if (opened) console.log('  opened in browser')
    return
  }

  if (!result.draftCreated || !result.reviewUrl) {
    console.log(`• ${result.reason || 'No launch draft created.'}`)
    if (result.reviewUrl) console.log(`→ ${result.reviewUrl}`)
    return
  }

  console.log(`✓ canonical repo #${result.repoId}`)
  console.log(`✓ ${result.tokenName} (${result.tokenSymbol})`)
  console.log(`✓ initial buy ${Number(result.initialBuyPercent || 0)}%`)
  console.log('→ review current costs + approve in wallet')
  console.log(result.reviewUrl)
  if (opened) console.log('  opened in browser')
  if (result.expiresAt) console.log(`  review expires ${result.expiresAt}`)
}

// The terminal for `repoing claim` and `repoing credits key`.
async function interactive(options, run) {
  const repository = normalizeGithubRepository(options.repository || currentGitRemote())
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await run(options, { repository, io: {
      print: line => console.log(line),
      ask: question => prompt.question(question),
      // Only links on the repo.ing origin are opened; anything else is printed.
      open: async url => { const target = safeBrowserUrl(url, options.origin); if (target) openUrl(target); return Boolean(target) },
    } })
  } finally { prompt.close() }
}

async function claim(argv) {
  const options = parseClaimArgs(argv)
  if (options.command === 'claim-help') { console.log(claimHelp(options.aiCredits)); return }
  await interactive(options, runClaim)
}

async function credits(argv) {
  if (!aiCreditsOn()) throw new Error(AI_CREDITS_OFF)
  const options = parseCreditsArgs(argv)
  if (options.command === 'credits-help') { console.log(CREDITS_HELP); return }
  await interactive(options, runCredits)
}

async function main() {
  if (process.argv[2] === 'claim') return claim(process.argv.slice(3))
  if (process.argv[2] === 'credits') return credits(process.argv.slice(3))
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help') {
    console.log(HELP)
    return
  }
  if (options.command === 'version') {
    console.log(VERSION)
    return
  }

  const repository = normalizeGithubRepository(options.repository || currentGitRemote())
  const result = await requestLaunchDraft({
    origin: options.origin,
    repository,
    tokenName: options.tokenName,
    tokenSymbol: options.tokenSymbol,
    initialBuy: options.initialBuy,
  })

  const link = result.live && result.marketUrl ? result.marketUrl : result.reviewUrl
  const target = safeBrowserUrl(link, options.origin)
  const opened = Boolean(options.open && target)
  if (opened) openUrl(target)
  else if (options.open && link) console.error('repoing: not opening a link outside the repo.ing origin; it is printed below.')

  if (options.json) console.log(JSON.stringify({ repository, ...result }, null, 2))
  else printHuman(repository, result, opened)
}

main().catch(error => {
  console.error(`repoing: ${error?.message || 'launch failed'}`)
  process.exitCode = 1
})
