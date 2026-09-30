use anchor_lang::prelude::*;

/// Global singleton. Holds roles only; it never has authority over any token account.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Can rotate roles and pause releases. Has NO path to move deposits.
    pub admin: Pubkey,
    /// Two-step admin handover: the proposed admin must sign `accept_admin`.
    pub pending_admin: Option<Pubkey>,
    /// Ed25519 key whose attestation is the only way to release a deposit.
    pub verifier: Pubkey,
    /// Incremented every time a new verifier becomes active.
    pub verifier_epoch: u64,
    /// Proposed verifier, active only after `pending_verifier_ready_at`.
    pub pending_verifier: Option<Pubkey>,
    pub pending_verifier_ready_at: i64,
    /// Adds and removes mints from the deposit allowlist.
    pub allowlist_authority: Pubkey,
    /// Emergency brake on releases (e.g. suspected verifier compromise). Refunds are never paused.
    pub releases_paused: bool,
    pub bump: u8,
}

/// One per allowlisted mint. Closing it stops new deposits; existing deposits are unaffected.
#[account]
#[derive(InitSpace)]
pub struct AllowedMint {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    /// Minimum amount (raw base units) the vault must actually receive per deposit.
    pub min_deposit: u64,
    /// Admission of a mint with a permanent delegate is an explicit decision: the issuer can seize vault funds.
    pub allow_permanent_delegate: bool,
    pub has_transfer_fee: bool,
    pub has_permanent_delegate: bool,
    pub has_freeze_authority: bool,
    pub added_at: i64,
    pub bump: u8,
}

/// Logical per-repository vault keyed by the numeric GitHub repository id.
/// Tokens are held in per-deposit token accounts so one deposit can never
/// be paid out of another's balance.
#[account]
#[derive(InitSpace)]
pub struct RepoVault {
    pub repo_id: u64,
    pub deposit_count: u64,
    pub open_deposits: u64,
    /// Release attestation nonces must strictly increase per repo (replay protection).
    pub last_release_nonce: u64,
    pub bump: u8,
}

/// An open deposit. Settlement (release or refund) closes both this record and its
/// vault in the same instruction, returning all rent to the donor. Its PDA index
/// comes from `RepoVault.deposit_count`, which only increases, so a closed deposit
/// address can never be re-initialised.
#[account]
#[derive(InitSpace)]
pub struct Deposit {
    pub repo_id: u64,
    pub index: u64,
    pub donor: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    /// PDA token account holding this deposit, authority = this Deposit account.
    pub vault: Pubkey,
    /// Amount the donor asked to send.
    pub requested_amount: u64,
    /// Amount the vault actually received (balance delta; excludes transfer fees).
    pub amount: u64,
    pub created_at: i64,
    pub refund_after: i64,
    /// Verifier epoch at deposit time; a later verifier change unlocks early refund.
    pub verifier_epoch: u64,
    pub bump: u8,
    pub vault_bump: u8,
}
