import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { inspectProductionEvidence, parseExecutionDossier } from './hooklab-production-observer.mjs'

// Server-owned read adapters only. Neither the dossier digest nor provider identities may come
// from an HTTP request. Account matching is not policy approval, adoption or operation acceptance.
// No RPC defaults, signing, sending, supply-byte exceptions or split-bank snapshots.
// idls: the envelope's own IDLs, for a stack bundle (src/hooklab-production-observer.mjs configCodec).
export async function readProductionEvidence({ dossierJson, expectedSha256, providers, now = Date.now, timeoutMs = 8000, idls = null } = {}) {
  const unavailable = inspectProductionEvidence()
  let dossier, addresses
  try {
    if (typeof dossierJson !== 'string' || Buffer.byteLength(dossierJson) > 65536
      || createHash('sha256').update(dossierJson).digest('hex') !== expectedSha256) throw Error()
    dossier = parseExecutionDossier(JSON.parse(dossierJson))
    addresses = [...dossier.programs.flatMap(p => [p.address, p.programData]), ...dossier.accounts.map(a => a.address)]
    const roles = [...dossier.programs, ...dossier.accounts].map(a => a.role)
    if (addresses.length > 100 || new Set(addresses).size !== addresses.length || new Set(roles).size !== roles.length
      || !['launch', 'swap', 'token'].every(role => dossier.programs.some(p => p.role === role))
      || !['launch-config', 'swap-config', 'quote-mint', 'creation-control'].every(role => dossier.accounts.some(a => a.role === role))
      || !Array.isArray(providers) || providers.length !== 2 || new Set(dossier.providers).size !== 2
      || new Set(providers.map(p => p.provider)).size !== 2 || providers.some(p => !dossier.providers.includes(p.provider) || !p.connection)
      || providers[0].connection === providers[1].connection
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw Error()
  } catch {
    return { ...unavailable, status: 'mismatch', reason: 'Reviewed dossier or configured provider binding is invalid', observations: [] }
  }
  let timer
  try {
    const observations = await Promise.race([
      Promise.all(providers.map(async ({ provider, connection }) => {
        const genesisHash = await connection.getGenesisHash()
        if (genesisHash !== dossier.genesisHash) throw Error()
        const snapshot = await connection.getMultipleAccountsInfoAndContext(addresses.map(a => new PublicKey(a)),
          { commitment: 'finalized', minContextSlot: dossier.minSlot })
        if (snapshot.value.length !== addresses.length || snapshot.value.some(a => !a)) throw Error()
        return { provider, genesisHash, commitment: 'finalized', slot: snapshot.context.slot, observedAtMs: now(),
          accounts: snapshot.value.map((a, i) => ({ address: addresses[i], owner: a.owner.toBase58(),
            executable: a.executable, dataBase64: Buffer.from(a.data).toString('base64') })) }
      })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error()), timeoutMs) }),
    ])
    const inspection = inspectProductionEvidence({ dossierJson, expectedSha256, observations, nowMs: now(), idls })
    return { ...inspection, observations }
  } catch {
    return { ...unavailable, reason: 'Finalized production observations unavailable; retain existing evidence', observations: [] }
  } finally { clearTimeout(timer) }
}
