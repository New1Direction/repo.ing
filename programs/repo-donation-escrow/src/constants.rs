/// Seconds a donor must wait after depositing before an unreleased deposit can be refunded.
pub const REFUND_DELAY_SECS: i64 = 90 * 24 * 60 * 60;

/// Seconds between an admin proposing a new verifier and it becoming active.
/// Donors may refund early while a rotation is pending or after one took effect,
/// so a malicious admin cannot silently swap in a verifier it controls.
pub const VERIFIER_ROTATION_DELAY_SECS: i64 = 7 * 24 * 60 * 60;

/// Domain separator for release attestations. Versioned so the message layout
/// can change without old signatures ever being valid for a new layout.
pub const ATTESTATION_DOMAIN: &[u8] = b"repo.ing/donation-escrow/release/v1";

/// domain || program_id || repo_id (u64 LE) || recipient || expiry (i64 LE) || nonce (u64 LE)
pub const ATTESTATION_MESSAGE_LEN: usize = ATTESTATION_DOMAIN.len() + 32 + 8 + 32 + 8 + 8;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ALLOWED_MINT_SEED: &[u8] = b"allowed_mint";
pub const REPO_SEED: &[u8] = b"repo";
pub const DEPOSIT_SEED: &[u8] = b"deposit";
pub const DEPOSIT_VAULT_SEED: &[u8] = b"deposit_vault";
