// The production operator bundle for our own stack (src/hooklab-stack.mjs): new coins' open launches, native-SOL trading
// and creator claims. Bundle 2's reviewed base profile with the stack's programs, quote marker, ELF and IDL pins and no
// bridge; the collector then re-checks everything exactly as for bundle 2: every deployed program (token included)
// against its pin, the gate immutable, both configs carrying the approved economics, and the two frozen shared tables
// (trades, and open launches when the build has them). The legacy bundle 2 stays as deployed for the canary and the
// bridged flows. Read-only: no keys, signing or sending.
import { createHash } from 'node:crypto'
import { parseStack, stackElfLengths, stackProfile } from './hooklab-stack.mjs'
import { PRODUCTION_NETWORK, collectProductionOperatorBundle, productionArtifacts } from './hooklab-production-operator-bundle.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const refuse = message => { throw Object.assign(Error(`Production bundle refused: ${message}`), { code: 'PRODUCTION_BUNDLE_REFUSED' }) }

// idls: { launch, swap, gate } bytes of the stack build (each must match its pin and name the stack's program).
export function stackProductionArtifacts(stackInput, idls, inclusive = productionArtifacts()) {
  const stack = parseStack(stackInput), bytes = Object.fromEntries(['launch', 'swap', 'gate'].map(role => [role, Buffer.from(idls?.[role] ?? '')]))
  const base = stackProfile(inclusive.base, stack, bytes)
  // The stack's "SDK" is its build: the descriptor (programs, marker, kit, pins) and the IDL bytes it names.
  return { base, idls: bytes, elfLengths: stackElfLengths(stack), sdkSha256: sha(JSON.stringify({ stack, idlSha256: base.idlSha256 })),
    build: stack.build.name, open: stack.build.open, stack }
}

// options: as collectProductionOperatorBundle (connections, trustDomains, lookupTable, launchTable, reviewer, treasury,
// approvalReference). A placeholder stack (program IDs not final) is for local validators only.
export async function collectStackProductionBundle({ stack, idls, network = PRODUCTION_NETWORK, ...options }) {
  const parsed = parseStack(stack)
  if (!network.local && parsed.status !== 'reviewed') refuse('the stack is a placeholder (final program IDs not set); build it on a local validator only')
  return collectProductionOperatorBundle({ ...options, network, artifacts: stackProductionArtifacts(parsed, idls) })
}
