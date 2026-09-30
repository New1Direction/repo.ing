use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub verifier: Pubkey,
    pub allowlist_authority: Pubkey,
}

#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminAccepted {
    pub previous_admin: Pubkey,
    pub admin: Pubkey,
}

#[event]
pub struct AllowlistAuthoritySet {
    pub allowlist_authority: Pubkey,
}

#[event]
pub struct VerifierRotationProposed {
    pub current_verifier: Pubkey,
    pub pending_verifier: Pubkey,
    pub ready_at: i64,
}

#[event]
pub struct VerifierRotationCancelled {
    pub cancelled_verifier: Pubkey,
}

#[event]
pub struct VerifierRotated {
    pub previous_verifier: Pubkey,
    pub verifier: Pubkey,
    pub verifier_epoch: u64,
}

#[event]
pub struct ReleasesPausedSet {
    pub paused: bool,
}

#[event]
pub struct MintAllowed {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub min_deposit: u64,
    pub has_transfer_fee: bool,
    pub has_permanent_delegate: bool,
    pub has_freeze_authority: bool,
}

#[event]
pub struct MintRemoved {
    pub mint: Pubkey,
}

#[event]
pub struct DepositMade {
    pub repo_id: u64,
    pub index: u64,
    pub deposit: Pubkey,
    pub donor: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub requested_amount: u64,
    pub amount: u64,
    pub created_at: i64,
    pub refund_after: i64,
}

#[event]
pub struct DepositReleased {
    pub repo_id: u64,
    pub index: u64,
    pub deposit: Pubkey,
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}

#[event]
pub struct DepositRefunded {
    pub repo_id: u64,
    pub index: u64,
    pub deposit: Pubkey,
    pub mint: Pubkey,
    pub donor: Pubkey,
    pub amount: u64,
    pub early: bool,
}
