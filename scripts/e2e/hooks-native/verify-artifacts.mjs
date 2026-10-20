#!/usr/bin/env node
// CI gate for the private artifacts the native e2e suite needs (downloaded from the private hook-lab release
// e2e-native-e357fdf): the directory must hold exactly these four ELFs, each matching its pin in code, or the job fails.
//   node scripts/e2e/hooks-native/verify-artifacts.mjs DIR
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { NATIVE_ELF } from '../../../src/hooklab-native-pins.mjs'
import { ELF } from '../../../src/hooklab-owner-driver/artifacts.mjs'
import { sha256 } from './common.mjs'

export const PRIVATE_ARTIFACTS = Object.freeze({
  'bordrless_launch.so': NATIVE_ELF.launch, // candidate native-SOL launch (hook-lab feat/native-sol e357fdf)
  'bordrless_swap.so': NATIVE_ELF.swap, // candidate native-SOL swap (same build)
  'hook_max_wallet.so': ELF.gate, // the unchanged max-wallet gate
  'bordrless_token.so': ELF.token, // the unchanged token program
})

export function verifyArtifacts(dir) {
  const present = readdirSync(dir).filter(name => !name.startsWith('.')).sort(), expected = Object.keys(PRIVATE_ARTIFACTS).sort()
  if (JSON.stringify(present) !== JSON.stringify(expected)) throw Error(`expected exactly ${expected.join(', ')}; found ${present.join(', ') || 'nothing'}`)
  return expected.map(name => {
    const file = path.join(dir, name), bytes = readFileSync(file), pin = PRIVATE_ARTIFACTS[name]
    if (!statSync(file).isFile() || bytes.length !== pin.length || sha256(bytes) !== pin.sha256) throw Error(`${name} does not match its pin (sha256 ${pin.sha256}, ${pin.length} bytes)`)
    return `${name} ${pin.sha256} ${pin.length}`
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { for (const line of verifyArtifacts(process.argv[2])) console.log(`ok ${line}`) }
  catch (error) { console.error(`private artifacts refused: ${error.message}`); process.exit(1) }
}
