// The tests' handle on the local stack: its public state (stack.json), the owner control API (the tests act as the owner
// through it), a direct connection to the validator for chain assertions, and the disposable database.
import { readFileSync } from 'node:fs'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import pg from 'pg'

export interface StackState {
  root: string; origin: string; genesisHash: string; validator: { url: string; faucetPort: number }
  database: { url: string; name: string }; rpc: { provider: string; origin: string }[]; control: { url: string; token: string }
  tls: { cert: string; spki: string }; roles: Record<string, string>; tradeTable: string; bundle: { sha256: string; profileSha256: string }; solUsd: string
  mode?: 'native' | 'legacy' | 'self-serve' | 'selected-hook'; programSet?: string; programs?: { launch: string; swap: string; gate: string; token: string }; quoteMint?: string; launchTable?: string | null
  selectedHook?: { pin: { program: string; elfSha256: string; elfLength: number }; flags: number; source: string } | null
  legacyPrograms?: Record<string, string> | null; ownTradeTable?: string | null; idlDir?: string | null
}

export const stack: StackState = JSON.parse(readFileSync(process.env.HOOKS_E2E_STACK as string, 'utf8'))
export const connection = new Connection(stack.validator.url, { commitment: 'finalized' })
export const db = new pg.Pool({ connectionString: stack.database.url, max: 2 })

export async function control<T = any>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(route, stack.control.url), { method, headers: { authorization: `Bearer ${stack.control.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000) })
  const json = await response.json()
  if (!response.ok) throw new Error(`control ${route}: ${json.error ?? response.status}`)
  return json as T
}

/** Polls until `probe` returns a truthy value. Deterministic waits on conditions, never fixed sleeps. */
export async function until<T>(label: string, probe: () => Promise<T | null | undefined | false>, { timeoutMs = 120_000, intervalMs = 500 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try { const value = await probe(); if (value) return value } catch (error) { if ((error as { fatal?: boolean }).fatal) throw error; last = error }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/** A fresh disposable keypair, funded by the local validator's faucet and confirmed finalized. */
export async function freshWallet(sol: number): Promise<Keypair> {
  const wallet = Keypair.generate()
  const signature = await connection.requestAirdrop(wallet.publicKey, Math.round(sol * LAMPORTS_PER_SOL))
  await until(`airdrop to ${wallet.publicKey.toBase58()}`, async () => (await connection.getSignatureStatuses([signature])).value[0]?.confirmationStatus === 'finalized')
  return wallet
}

/** The owner types a command into the owner agent; resolves with the agent's line after it that matches `expect`, and
 * fails at once on a line that says the command failed or was refused. */
export async function ownerAgent(line: string, expect: RegExp, timeoutMs = 120_000): Promise<string> {
  const { at } = await control<{ at: number }>('POST', '/owner/agent', { line })
  const failed = /^(Failed: |REFUSED |Creator grant not usable)/
  return until(`owner agent output ${expect} after "${line}"`, async () => {
    const { lines } = await control<{ lines: string[] }>('GET', `/owner/agent/log?from=${at}`)
    const refusal = lines.find(text => failed.test(text))
    if (refusal) throw Object.assign(new Error(`owner agent: ${refusal}`), { fatal: true })
    return lines.find(text => expect.test(text))
  }, { timeoutMs })
}
export async function ownerAgentLogSince(from: number): Promise<{ lines: string[]; next: number }> {
  return control('GET', `/owner/agent/log?from=${from}`)
}

export const pk = (value: string) => new PublicKey(value)
