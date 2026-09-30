//! repo.ing donation escrow.
//!
//! Anyone can donate allowlisted tokens to a GitHub repository (keyed by its numeric
//! repo id). A deposit leaves escrow in exactly one of two ways:
//! - `release`: to the wallet named in an ed25519 attestation from the configured
//!   verifier for that repo (repo.ing signs after verifying GitHub ownership), or
//! - `refund`: back to the donor, after 90 days (or earlier if the verifier changed).
//!
//! The admin can rotate roles and pause releases but has no instruction that moves funds.
//! DEVNET / LOCALNET ONLY until audited.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod attestation;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod mint_policy;
pub mod state;
pub mod token_ops;

use instructions::*;

declare_id!("EYWsnGsXdyozWYuTY2CxYjCrPxyDFHvhxarn2Qcwzv51");

#[program]
pub mod repo_donation_escrow {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        admin: Pubkey,
        verifier: Pubkey,
        allowlist_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin::initialize_config(ctx, admin, verifier, allowlist_authority)
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::accept_admin(ctx)
    }

    pub fn set_allowlist_authority(ctx: Context<AdminOnly>, authority: Pubkey) -> Result<()> {
        instructions::admin::set_allowlist_authority(ctx, authority)
    }

    pub fn propose_verifier(ctx: Context<AdminOnly>, new_verifier: Pubkey) -> Result<()> {
        instructions::admin::propose_verifier(ctx, new_verifier)
    }

    pub fn cancel_verifier_rotation(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::admin::cancel_verifier_rotation(ctx)
    }

    pub fn activate_verifier(ctx: Context<ActivateVerifier>) -> Result<()> {
        instructions::admin::activate_verifier(ctx)
    }

    pub fn set_releases_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::admin::set_releases_paused(ctx, paused)
    }

    pub fn add_allowed_mint(
        ctx: Context<AddAllowedMint>,
        min_deposit: u64,
        allow_permanent_delegate: bool,
    ) -> Result<()> {
        instructions::allowlist::add_allowed_mint(ctx, min_deposit, allow_permanent_delegate)
    }

    pub fn remove_allowed_mint(ctx: Context<RemoveAllowedMint>) -> Result<()> {
        instructions::allowlist::remove_allowed_mint(ctx)
    }

    pub fn deposit(
        ctx: Context<MakeDeposit>,
        repo_id: u64,
        deposit_index: u64,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit::make_deposit(ctx, repo_id, deposit_index, amount)
    }

    pub fn release(ctx: Context<Release>, repo_id: u64, expiry: i64, nonce: u64) -> Result<()> {
        instructions::release::release(ctx, repo_id, expiry, nonce)
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::refund::refund(ctx)
    }
}
