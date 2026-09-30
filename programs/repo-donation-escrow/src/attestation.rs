//! Verification of the verifier's ed25519 release attestation.
//!
//! The client places an Ed25519SigVerify precompile instruction immediately before
//! `release`. The runtime has already rejected the transaction if that signature is
//! invalid; here we only need to prove the precompile checked *our* pubkey over
//! *our* expected message. The classic bug with this pattern is trusting offsets
//! that point into a different instruction, so every instruction-index field must be
//! u16::MAX ("this instruction") and there must be exactly one signature.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::constants::{ATTESTATION_DOMAIN, ATTESTATION_MESSAGE_LEN};
use crate::errors::EscrowError;

const SIGNATURE_OFFSETS_START: usize = 2;
const SIGNATURE_OFFSETS_LEN: usize = 14;
const PUBKEY_LEN: usize = 32;
const SIGNATURE_LEN: usize = 64;
const THIS_INSTRUCTION: u16 = u16::MAX;

/// Canonical attestation bytes. Off-chain signers must produce exactly this layout.
pub fn attestation_message(
    program_id: &Pubkey,
    repo_id: u64,
    recipient: &Pubkey,
    expiry: i64,
    nonce: u64,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(ATTESTATION_MESSAGE_LEN);
    msg.extend_from_slice(ATTESTATION_DOMAIN);
    msg.extend_from_slice(program_id.as_ref());
    msg.extend_from_slice(&repo_id.to_le_bytes());
    msg.extend_from_slice(recipient.as_ref());
    msg.extend_from_slice(&expiry.to_le_bytes());
    msg.extend_from_slice(&nonce.to_le_bytes());
    msg
}

fn read_u16(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data
        .get(at..at + 2)
        .ok_or(error!(EscrowError::MalformedAttestation))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn slice(data: &[u8], offset: u16, len: usize) -> Result<&[u8]> {
    let start = offset as usize;
    data.get(start..start + len)
        .ok_or(error!(EscrowError::MalformedAttestation))
}

/// Parses an Ed25519SigVerify instruction's data and returns (pubkey, message)
/// only if it carries exactly one self-contained signature.
pub fn parse_ed25519_instruction(data: &[u8]) -> Result<(&[u8], &[u8])> {
    require!(
        data.len() >= SIGNATURE_OFFSETS_START + SIGNATURE_OFFSETS_LEN,
        EscrowError::MalformedAttestation
    );
    require!(data[0] == 1, EscrowError::MalformedAttestation);

    let base = SIGNATURE_OFFSETS_START;
    let signature_offset = read_u16(data, base)?;
    let signature_ix = read_u16(data, base + 2)?;
    let pubkey_offset = read_u16(data, base + 4)?;
    let pubkey_ix = read_u16(data, base + 6)?;
    let message_offset = read_u16(data, base + 8)?;
    let message_size = read_u16(data, base + 10)?;
    let message_ix = read_u16(data, base + 12)?;

    require!(
        signature_ix == THIS_INSTRUCTION
            && pubkey_ix == THIS_INSTRUCTION
            && message_ix == THIS_INSTRUCTION,
        EscrowError::MalformedAttestation
    );
    slice(data, signature_offset, SIGNATURE_LEN)?;
    let pubkey = slice(data, pubkey_offset, PUBKEY_LEN)?;
    let message = slice(data, message_offset, message_size as usize)?;
    Ok((pubkey, message))
}

/// Requires that the instruction immediately preceding the current one is an
/// Ed25519SigVerify over `expected_message` by `verifier`.
pub fn verify_release_attestation(
    instructions_sysvar: &AccountInfo,
    verifier: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current = load_current_index_checked(instructions_sysvar)?;
    require!(current > 0, EscrowError::MissingAttestation);
    let ix = load_instruction_at_checked((current - 1) as usize, instructions_sysvar)?;
    require_keys_eq!(
        ix.program_id,
        solana_sdk_ids::ed25519_program::ID,
        EscrowError::MissingAttestation
    );
    require!(ix.accounts.is_empty(), EscrowError::MalformedAttestation);

    let (pubkey, message) = parse_ed25519_instruction(&ix.data)?;
    require!(
        pubkey == verifier.as_ref(),
        EscrowError::AttestationWrongSigner
    );
    require!(
        message == expected_message,
        EscrowError::AttestationMessageMismatch
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(indices: [u16; 3], num: u8, msg: &[u8]) -> Vec<u8> {
        let (pk_off, sig_off, msg_off) = (16u16, 48u16, 112u16);
        let mut d = vec![num, 0];
        for v in [
            sig_off,
            indices[0],
            pk_off,
            indices[1],
            msg_off,
            msg.len() as u16,
            indices[2],
        ] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(&[7u8; 32]);
        d.extend_from_slice(&[9u8; 64]);
        d.extend_from_slice(msg);
        d
    }

    #[test]
    fn parses_self_contained_signature() {
        let data = build([u16::MAX; 3], 1, b"hello");
        let (pk, msg) = parse_ed25519_instruction(&data).unwrap();
        assert_eq!(pk, &[7u8; 32]);
        assert_eq!(msg, b"hello");
    }

    #[test]
    fn rejects_offsets_into_other_instructions() {
        for i in 0..3 {
            let mut idx = [u16::MAX; 3];
            idx[i] = 0;
            assert!(parse_ed25519_instruction(&build(idx, 1, b"m")).is_err());
        }
    }

    #[test]
    fn rejects_multiple_or_zero_signatures_and_truncation() {
        assert!(parse_ed25519_instruction(&build([u16::MAX; 3], 2, b"m")).is_err());
        assert!(parse_ed25519_instruction(&build([u16::MAX; 3], 0, b"m")).is_err());
        let data = build([u16::MAX; 3], 1, b"message");
        assert!(parse_ed25519_instruction(&data[..data.len() - 1]).is_err());
        assert!(parse_ed25519_instruction(&data[..10]).is_err());
    }

    #[test]
    fn message_layout_is_fixed_and_binds_every_field() {
        let program = Pubkey::new_from_array([1; 32]);
        let recipient = Pubkey::new_from_array([2; 32]);
        let base = attestation_message(&program, 5, &recipient, 100, 7);
        assert_eq!(base.len(), ATTESTATION_MESSAGE_LEN);
        assert!(base.starts_with(ATTESTATION_DOMAIN));
        let variants = [
            attestation_message(&Pubkey::new_from_array([3; 32]), 5, &recipient, 100, 7),
            attestation_message(&program, 6, &recipient, 100, 7),
            attestation_message(&program, 5, &Pubkey::new_from_array([4; 32]), 100, 7),
            attestation_message(&program, 5, &recipient, 101, 7),
            attestation_message(&program, 5, &recipient, 100, 8),
        ];
        for v in variants {
            assert_ne!(v, base);
        }
    }
}
