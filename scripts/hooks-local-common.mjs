import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { BorshCoder } from '@anchor-lang/core'
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
export const sha = value => createHash('sha256').update(value).digest('hex')
export const localKey = role => Keypair.fromSeed(createHash('sha256').update(`repo.ing hooks local acceptance ${role} v1`).digest())
export const pk = value => new PublicKey(value)
export const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
export const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[0].toBase58()
export const stateDirectory = () => {
  const path = process.env.HOOK_LOCAL_ACCEPTANCE_STATE
  if (!path?.startsWith('/') || process.env.NODE_ENV === 'production') throw Error('Explicit local state directory required')
  return path
}
export async function localArtifacts() {
  const base = new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/', import.meta.url)
  const read = async name => await readFile(new URL(name, base), 'utf8')
  const profile = JSON.parse(await read('offline-builder-profile.json'))
  const artifacts = JSON.parse(await read('build-artifacts.json'))
  const idls = Object.fromEntries(await Promise.all([['launch','bordrless_launch'],['swap','bordrless_swap'],['gate','hook_max_wallet']].map(async ([role,name]) => [role, await read(`${name}.json`)])))
  for (const role of Object.keys(idls)) if (sha(idls[role]) !== artifacts.artifacts[role].idlSha256) throw Error('Pinned IDL differs')
  const tokenIdl = await readFile(new URL('../vendor/hooklab-production-candidate/idl/bordrless_token.json', import.meta.url), 'utf8')
  if (sha(tokenIdl) !== '93aaa54d2e0c22e444793ac84387c357d73b745d482becada32d7d6e23d2c506') throw Error('Pinned external token ABI differs')
  return { profile, artifacts, idls, tokenIdl, coders: { ...Object.fromEntries(Object.entries(idls).map(([role,json]) => [role, new BorshCoder(JSON.parse(json))])), token: new BorshCoder(JSON.parse(tokenIdl)) } }
}
export function localInstruction(bundle, role, name, args, values) {
  const idl = JSON.parse(role === 'token' ? bundle.tokenIdl : bundle.idls[role]), definition = idl.instructions.find(ix => ix.name === name)
  if (!definition) throw Error(`Missing local ABI instruction ${name}`)
  const program = bundle.profile.programs[role]
  const accounts = { system_program: '11111111111111111111111111111111', program,
    event_authority: pda(program, '__event_authority'), config: pda(program, 'config'), governance: pda(program, 'governance'),
    program_data: pda(loader, pk(program).toBuffer()), ...values }
  return new TransactionInstruction({ programId: pk(program), data: bundle.coders[role].instruction.encode(name, args),
    keys: definition.accounts.map(account => {
      const address = accounts[account.name] ?? account.address
      if (!address || (account.address && address !== account.address)) throw Error(`Missing local account ${name}.${account.name}`)
      return { pubkey: pk(address), isSigner: !!account.signer, isWritable: !!account.writable }
    }) })
}
export function localConnection() { return new Connection('http://127.0.0.1:18999', { commitment: 'finalized', disableRetryOnRateLimit: true }) }
export async function assertLocalChain(connection, expectedGenesis) {
  const endpoint = new URL(connection.rpcEndpoint)
  if (endpoint.origin !== 'http://127.0.0.1:18999' || process.env.NODE_ENV === 'production') throw Error('Only the isolated local validator is permitted')
  const genesis = await connection.getGenesisHash()
  if (genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' || (expectedGenesis && genesis !== expectedGenesis)) throw Error('Local validator genesis differs')
  return genesis
}
export async function sendLocal(connection, instructions, signers, expectedGenesis) {
  await assertLocalChain(connection, expectedGenesis)
  const latest = await connection.getLatestBlockhash('finalized')
  const message = new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: latest.blockhash, instructions }).compileToV0Message()
  const tx = new VersionedTransaction(message); tx.sign(signers)
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 0, skipPreflight: false })
  const result = await connection.confirmTransaction({ signature, ...latest }, 'finalized')
  if (result.value.err) throw Error(`Local initialization failed: ${JSON.stringify(result.value.err)}`)
  return signature
}
