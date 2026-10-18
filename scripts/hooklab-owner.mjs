#!/usr/bin/env node
// Owner-run Hook Lab mainnet configuration + restricted-canary driver.
// plan/status are read-only. execute signs and sends exactly one reviewed message with keys read
// once from the given paths (named pipes from the owner's key tool). See src/hooklab-owner-driver/.
import { main } from '../src/hooklab-owner-driver/cli.mjs'

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(`hooklab-owner: ${error.message}`)
  process.exitCode = 1
}
