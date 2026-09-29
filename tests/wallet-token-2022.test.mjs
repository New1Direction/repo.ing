import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, AccountState, ExtensionType, TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token'
import { TOKEN_2022_ACCOUNT_SLICE, walletTokenBalances } from '../app/lib/wallet-overview.mjs'

const owner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey

function base(amount, holder = owner, tokenMint = mint) {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode({ mint: tokenMint, owner: holder, amount, delegateOption: 0, delegate: holder, state: AccountState.Initialized,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: holder }, data)
  return data
}
// Token-2022 account with the ImmutableOwner and TransferHookAccount extensions: account-type byte 2, then TLV entries.
function withExtensions(amount, holder) {
  const tlv = Buffer.alloc(4 + 4 + 1)
  tlv.writeUInt16LE(ExtensionType.ImmutableOwner, 0); tlv.writeUInt16LE(0, 2)
  tlv.writeUInt16LE(ExtensionType.TransferHookAccount, 4); tlv.writeUInt16LE(1, 6); tlv[8] = 0
  return Buffer.concat([base(amount, holder), Buffer.from([2]), tlv])
}
const sliced = data => ({ account: { data: data.subarray(0, TOKEN_2022_ACCOUNT_SLICE.length) } })

test('Token-2022 accounts with extensions parse at the SPL offsets, matching spl-token', () => {
  const full = withExtensions(123_456_789n)
  const reference = unpackAccount(Keypair.generate().publicKey, { data: full, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false }, TOKEN_2022_PROGRAM_ID)
  const balances = walletTokenBalances([], owner.toBase58(), [{ account: { data: full } }, sliced(full)])
  assert.equal(balances.get(reference.mint.toBase58()), reference.amount * 2n)
  // A plain 165-byte Token-2022 account has no account-type byte at all.
  assert.equal(walletTokenBalances([], owner.toBase58(), [{ account: { data: base(5n) } }]).get(mint.toBase58()), 5n)
})

test('Token-2022 owner mismatch and malformed data are rejected', () => {
  assert.throws(() => walletTokenBalances([], owner.toBase58(), [sliced(withExtensions(1n, Keypair.generate().publicKey))]), /owner mismatch/)
  const wrongType = withExtensions(1n); wrongType[ACCOUNT_SIZE] = 1
  assert.throws(() => walletTokenBalances([], owner.toBase58(), [sliced(wrongType)]), /Invalid token account data/)
  // Longer-than-base data is only valid for Token-2022.
  assert.throws(() => walletTokenBalances([sliced(withExtensions(1n))], owner.toBase58()), /Invalid token account data/)
})

test('SPL Token and Token-2022 balances of the same mint are summed', () => {
  const spl = { account: { data: base(7n).subarray(0, 72) } }
  const other = Keypair.generate().publicKey
  const balances = walletTokenBalances([spl], owner.toBase58(), [sliced(withExtensions(9_007_199_254_740_993n)), { account: { data: base(3n, owner, other) } }])
  assert.equal(balances.get(mint.toBase58()), 9_007_199_254_741_000n)
  assert.equal(balances.get(other.toBase58()), 3n)
})
