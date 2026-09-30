#!/usr/bin/env node
// Required pre-merge check: every tests/*.test.mjs except those listed in scripts/ci/needs-services.txt, with no
// database or validator. Database-backed cases inside quick files skip themselves when their env is absent.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const services = new Set(readFileSync('scripts/ci/needs-services.txt', 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')))
const files = readdirSync('tests').filter(name => name.endsWith('.test.mjs') && !services.has(name.replace(/\.test\.mjs$/, ''))).sort().map(name => `tests/${name}`)
console.log(`quick tests: ${files.length} files (${services.size} need services and run after merge)`)
const env = { ...process.env }
for (const key of Object.keys(env)) if (/DATABASE_URL$|^SOLANA_RPC_URL$/.test(key)) delete env[key]
const { status } = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], { stdio: 'inherit', env })
process.exit(status ?? 1)
