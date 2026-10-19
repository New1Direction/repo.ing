#!/usr/bin/env node
// Writes our stack's descriptor (stack.json, schema repoing/hooks-stack/1) from hook-lab's independent-stack build
// output, for the owner driver's --stack. Every pin is computed from the build's own files (src/hooklab-stack-build.mjs);
// --reviewed records the owner's statement that the ids file holds their final keys (refused while it says PLACEHOLDER).
// Read-only apart from --out; no RPC, keys or signing.
//   node scripts/hooklab-stack-descriptor.mjs --build-dir DIR [--reviewed] --out stack.json
import { existsSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { stackFromIndependentBuild } from '../src/hooklab-stack-build.mjs'

const die = message => { console.error(message); process.exit(2) }
const { values: opt } = parseArgs({ options: { 'build-dir': { type: 'string' }, reviewed: { type: 'boolean', default: false }, out: { type: 'string' } } })
if (!opt['build-dir'] || !opt.out) die('Required: --build-dir DIR --out FILE')
if (existsSync(opt.out)) die(`${opt.out} exists; refusing to overwrite`)
try {
  const { stack } = stackFromIndependentBuild(opt['build-dir'], { reviewed: opt.reviewed })
  writeFileSync(opt.out, `${JSON.stringify(stack, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
  console.log(JSON.stringify({ out: opt.out, status: stack.status, build: stack.build.name, programs: stack.programs, quoteMint: stack.quoteMint,
    upgradeAuthority: stack.upgradeAuthority, idls: `${opt['build-dir']}/idl` }, null, 2))
} catch (error) { die(`Stack descriptor not written: ${error.message}`) }
