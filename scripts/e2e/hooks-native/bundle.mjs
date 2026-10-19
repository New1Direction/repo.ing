// The operator bundle the PRODUCTION bootstrap (src/hooklab-production-bootstrap.mjs) loads, collected from the local
// validator instead of mainnet. It has the same shape and checks as collectProductionOperatorBundle
// (src/hooklab-production-operator-bundle.mjs), with three differences, each only valid under local acceptance:
//   - the profile and dossier use the local schemas and this validator's genesis (src/hooklab-local-acceptance.mjs);
//   - the profile pins the candidate native-SOL launch and swap builds (NATIVE_ELF, NATIVE_IDL_SHA256 and the vendored
//     native IDL bytes), which the production collector cannot do yet (it only knows the v3 artifacts);
//   - both providers are the two HTTPS proxies in front of one validator (topology single-local-validator-two-proxies).
// Collect it after every governance stage: the config and governance pins are exact (config counters aside).
import { readFileSync } from 'node:fs'
import { AddressLookupTableAccount, PublicKey } from '@solana/web3.js'
import { BorshCoder } from '@anchor-lang/core'
import { LOCAL_DOSSIER_SCHEMA, LOCAL_PROFILE_SCHEMA } from '../../../src/hooklab-local-acceptance.mjs'
import { NATIVE_ELF, NATIVE_IDL_SHA256 } from '../../../src/hooklab-native-pins.mjs'
import { sharedTradeAddresses } from '../../../src/hooklab-owner-launch-tables.mjs'
import { productionArtifacts, productionProfileJson } from '../../../src/hooklab-production-operator-bundle.mjs'
import { quoteMintSupplyBinding } from '../../../src/hooklab-production-observer.mjs'
import { DEFAULT_CREATOR_FEE_BPS } from '../../../src/hooklab-launch-menus.mjs'
import { REPO_ROOT, sha256 } from './common.mjs'

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111', TOKEN_ELF_LENGTH = 326504
const pk = value => new PublicKey(value)
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), pk(program))[0].toBase58()
const need = (ok, message) => { if (!ok) throw Error(`Local bundle refused: ${message}`) }
const vendor = file => readFileSync(`${REPO_ROOT}vendor/${file}`)

export async function collectLocalBundle({ connection, genesisHash, providers, tradeTable, reviewer, treasury }) {
  const { base, idls: v3Idls } = productionArtifacts()
  const idls = { launch: vendor('hooklab-native-candidate/bordrless_launch.json'), swap: vendor('hooklab-native-candidate/bordrless_swap.json'), gate: v3Idls.gate }
  need(sha256(idls.launch) === NATIVE_IDL_SHA256.launch && sha256(idls.swap) === NATIVE_IDL_SHA256.swap, 'vendored native IDLs differ from their pins')
  const profileJson = JSON.stringify({ ...JSON.parse(productionProfileJson(base)), schema: LOCAL_PROFILE_SCHEMA, profileId: `local-native-e2e-${genesisHash.slice(0, 16)}`, genesisHash,
    idlSha256: { ...base.idlSha256, ...NATIVE_IDL_SHA256 }, elfSha256: { ...base.elfSha256, launch: NATIVE_ELF.launch.sha256, swap: NATIVE_ELF.swap.sha256 } })
  const elfLengths = { launch: NATIVE_ELF.launch.length, swap: NATIVE_ELF.swap.length, gate: JSON.parse(vendor('hooklab-event-abi/inclusive-max-wallet-candidate/build-artifacts.json')).artifacts.gate.elfLength }
  const profile = { json: profileJson, expectedSha256: sha256(profileJson), providers: providers.map(p => p.provider),
    idls: Object.fromEntries(Object.entries(idls).map(([role, bytes]) => [role, bytes.toString('base64')])), elfLengths }
  const P = base.programs, programRoles = ['launch', 'swap', 'gate', 'token'], programData = programRoles.map(role => pda(LOADER, pk(P[role]).toBuffer()))
  const accountRoles = { 'launch-config': pda(P.launch, 'config'), 'swap-config': pda(P.swap, 'config'), 'creation-control': pda(P.launch, 'governance'),
    'swap-governance': pda(P.swap, 'governance'), 'quote-mint': base.quoteMint }
  const addresses = [...programData, ...Object.values(accountRoles), tradeTable]
  const { value: infos, context } = await connection.getMultipleAccountsInfoAndContext(addresses.map(pk), 'finalized')
  infos.forEach((info, i) => need(info, `${addresses[i]} is missing`))
  const elfPins = { launch: NATIVE_ELF.launch.sha256, swap: NATIVE_ELF.swap.sha256, gate: base.elfSha256.gate, token: base.dependencyObservation.tokenElfSha256 }
  const programs = programRoles.map((role, i) => {
    const bytes = Buffer.from(infos[i].data), length = role === 'token' ? TOKEN_ELF_LENGTH : elfLengths[role]
    need(infos[i].owner.toBase58() === LOADER && bytes.readUInt32LE(0) === 3 && bytes.length >= 45 + length, `${role} program data is not an upgradeable-loader program`)
    need(sha256(bytes.subarray(45, 45 + length)) === elfPins[role] && !bytes.subarray(45 + length).some(b => b !== 0), `${role} deployed code differs from its pin`)
    const upgradeAuthority = bytes[12] ? pk(bytes.subarray(13, 45)).toBase58() : null
    if (role === 'gate') need(upgradeAuthority === null, 'the gate is still upgradeable; run gate-finalize first')
    return { role, address: P[role], programData: programData[i], upgradeAuthority, deploySlot: Number(bytes.readBigUInt64LE(4)), programDataSha256: sha256(bytes), elfLength: length, elfSha256: elfPins[role] }
  })
  const accounts = Object.entries(accountRoles).map(([role, address], j) => {
    const info = infos[programRoles.length + j], data = Buffer.from(info.data)
    return { role, address, owner: info.owner.toBase58(), executable: info.executable, dataSha256: sha256(data), ...(['launch-config', 'swap-config'].includes(role)
      // The counter binding decodes with the v3 IDL (src/hooklab-production-observer.mjs); the Config layout is unchanged.
      ? { binding: 'config-counters-v1', approvedDataBase64: data.toString('base64'), idlSha256: sha256(v3Idls[role.split('-')[0]]) }
      : role === 'quote-mint' ? quoteMintSupplyBinding(data) : {}) }
  })
  const table = infos.at(-1), tableState = AddressLookupTableAccount.deserialize(Uint8Array.from(table.data))
  need(table.owner.toBase58() === 'AddressLookupTab1e1111111111111111111111111', 'trade table is not an address lookup table')
  need(!tableState.authority && tableState.deactivationSlot === 0xffffffffffffffffn, 'trade table is not frozen and active')
  need(JSON.stringify(tableState.addresses.map(a => a.toBase58())) === JSON.stringify(sharedTradeAddresses(JSON.parse(profileJson))), 'trade table addresses differ')
  const lc = new BorshCoder(JSON.parse(v3Idls.launch)).accounts.decode('Config', Buffer.from(accounts[0].approvedDataBase64, 'base64'))
  const sc = new BorshCoder(JSON.parse(v3Idls.swap)).accounts.decode('Config', Buffer.from(accounts[1].approvedDataBase64, 'base64'))
  need(lc.admin.toBase58() === reviewer && sc.admin.toBase58() === reviewer, 'config admin is not the disposable admin')
  need(sc.fee_collector.toBase58() === treasury && sc.treasury.toBase58() === treasury && lc.treasury.toBase58() === treasury, 'treasury differs')
  need(sc.launch_protocol_share_bps === 2500 && sc.protocol_fee_bps === 0, 'swap config is not the inclusive 25% split')
  const dossierJson = JSON.stringify({ schema: LOCAL_DOSSIER_SCHEMA, topology: 'single-local-validator-two-proxies', genesisHash,
    artifacts: { sourceCommit: base.sourceCommit, profileSha256: profile.expectedSha256, sdkSha256: sha256(vendor('hooklab-event-abi/inclusive-max-wallet-candidate/build-artifacts.json')),
      idlSha256: sha256(Buffer.concat([idls.launch, idls.swap, idls.gate])), provenanceSha256: sha256(JSON.stringify({ local: 'hooks-native e2e', genesisHash })) },
    providers: profile.providers, minSlot: context.slot, maxSlotLag: 5, maxAgeMs: 60000, programs, accounts })
  const config = { schema: 'repoing/inclusive-max-wallet-operator-config/1', feeModel: 2, enabled: true, approvalReference: 'DISPOSABLE-LOCAL-E2E-NOT-PRODUCTION',
    profileSha256: profile.expectedSha256, dossierSha256: sha256(dossierJson),
    providerTrustDomains: providers.map(({ provider, origin }) => ({ provider, trustDomain: 'single-local-validator', origin: `${new URL(origin).origin}/` })),
    economics: { creatorFeeBps: DEFAULT_CREATOR_FEE_BPS, authorShareBps: 0, lpFeeBps: lc.lp_fee_bps, maxCreatorFeeBps: lc.max_creator_fee_bps, protocolFeeBps: sc.protocol_fee_bps,
      launchProtocolShareBps: sc.launch_protocol_share_bps, launchFeeLamports: lc.launch_fee_lamports.toString(), poolCreationFeeLamports: sc.pool_creation_fee_lamports.toString() },
    reviewer, treasury, lookupTable: { address: tradeTable, sha256: sha256(Buffer.from(table.data)) }, lamportsPerSignature: '5000' }
  return { schema: 'repoing/production-operator-bundle/1', genesisHash, observedSlot: context.slot, profile, config, dossierJson }
}
