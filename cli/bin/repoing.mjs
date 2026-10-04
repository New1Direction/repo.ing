#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import process from 'node:process'
import {
  HELP,
  VERSION,
  normalizeGithubRepository,
  parseArgs,
  requestLaunchDraft,
} from '../src/core.mjs'

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

function openUrl(url) {
  const platform = process.platform
  let child
  if (platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' })
  else if (platform === 'win32') child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
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

async function main() {
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

  const target = result.live && result.marketUrl ? result.marketUrl : result.reviewUrl
  const opened = Boolean(options.open && target)
  if (opened) openUrl(target)

  if (options.json) console.log(JSON.stringify({ repository, ...result }, null, 2))
  else printHuman(repository, result, opened)
}

main().catch(error => {
  console.error(`repoing: ${error?.message || 'launch failed'}`)
  process.exitCode = 1
})
