use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("Signer is not the pending admin")]
    NotPendingAdmin,
    #[msg("No admin handover is pending")]
    NoPendingAdmin,
    #[msg("Signer is not the allowlist authority")]
    NotAllowlistAuthority,
    #[msg("Only the program upgrade authority can initialize the config")]
    NotUpgradeAuthority,
    #[msg("No verifier rotation is pending")]
    NoPendingVerifier,
    #[msg("Verifier rotation delay has not elapsed")]
    VerifierRotationNotReady,
    #[msg("Role key must not be the default pubkey")]
    InvalidRoleKey,
    #[msg("Minimum deposit must be greater than zero")]
    InvalidMinDeposit,
    #[msg("Mint has an extension this escrow does not support")]
    UnsupportedMintExtension,
    #[msg("Mint has an active transfer hook; not supported")]
    TransferHookNotSupported,
    #[msg("Mint has a permanent delegate and was not admitted with allow_permanent_delegate")]
    PermanentDelegateNotAllowed,
    #[msg("Mint is non-transferable")]
    NonTransferableMint,
    #[msg("Token program does not match the allowlisted token program for this mint")]
    TokenProgramMismatch,
    #[msg("Deposit index does not match the repo vault's next index")]
    DepositIndexMismatch,
    #[msg("Deposit amount must be greater than zero")]
    ZeroAmount,
    #[msg("Received amount is below the minimum deposit for this mint")]
    BelowMinimumDeposit,
    #[msg("Releases are paused")]
    ReleasesPaused,
    #[msg("Attestation has expired")]
    AttestationExpired,
    #[msg("Attestation nonce has already been used or is stale")]
    AttestationNonceReplayed,
    #[msg("Missing ed25519 attestation instruction immediately before release")]
    MissingAttestation,
    #[msg("Malformed ed25519 attestation instruction")]
    MalformedAttestation,
    #[msg("Attestation was not signed by the configured verifier")]
    AttestationWrongSigner,
    #[msg("Attestation message does not match this release")]
    AttestationMessageMismatch,
    #[msg("Refund is not yet available for this deposit")]
    RefundNotYetAvailable,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
