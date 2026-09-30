//! Role management. Nothing in this module touches a token account: the admin
//! can rotate roles and pause releases, but has no instruction that moves funds.

use anchor_lang::prelude::*;

use crate::{
    constants::{CONFIG_SEED, VERIFIER_ROTATION_DELAY_SECS},
    errors::EscrowError,
    events::*,
    program::RepoDonationEscrow,
    state::Config,
};

fn require_role_key(key: &Pubkey) -> Result<()> {
    require!(*key != Pubkey::default(), EscrowError::InvalidRoleKey);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    /// Only the upgrade authority may initialize, so a front-runner cannot seize the
    /// config between deploy and init.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, RepoDonationEscrow>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(payer.key())
            @ EscrowError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    admin: Pubkey,
    verifier: Pubkey,
    allowlist_authority: Pubkey,
) -> Result<()> {
    require_role_key(&admin)?;
    require_role_key(&verifier)?;
    require_role_key(&allowlist_authority)?;
    let config = &mut ctx.accounts.config;
    config.set_inner(Config {
        admin,
        pending_admin: None,
        verifier,
        verifier_epoch: 0,
        pending_verifier: None,
        pending_verifier_ready_at: 0,
        allowlist_authority,
        releases_paused: false,
        bump: ctx.bumps.config,
    });
    emit!(ConfigInitialized {
        admin,
        verifier,
        allowlist_authority
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ EscrowError::NotAdmin,
    )]
    pub config: Account<'info, Config>,
}

pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    require_role_key(&new_admin)?;
    let config = &mut ctx.accounts.config;
    config.pending_admin = Some(new_admin);
    emit!(AdminProposed {
        admin: config.admin,
        pending_admin: new_admin
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let pending = config
        .pending_admin
        .ok_or(error!(EscrowError::NoPendingAdmin))?;
    require_keys_eq!(
        pending,
        ctx.accounts.new_admin.key(),
        EscrowError::NotPendingAdmin
    );
    let previous_admin = config.admin;
    config.admin = pending;
    config.pending_admin = None;
    emit!(AdminAccepted {
        previous_admin,
        admin: pending
    });
    Ok(())
}

pub fn set_allowlist_authority(ctx: Context<AdminOnly>, authority: Pubkey) -> Result<()> {
    require_role_key(&authority)?;
    ctx.accounts.config.allowlist_authority = authority;
    emit!(AllowlistAuthoritySet {
        allowlist_authority: authority
    });
    Ok(())
}

pub fn propose_verifier(ctx: Context<AdminOnly>, new_verifier: Pubkey) -> Result<()> {
    require_role_key(&new_verifier)?;
    let now = Clock::get()?.unix_timestamp;
    let ready_at = now
        .checked_add(VERIFIER_ROTATION_DELAY_SECS)
        .ok_or(error!(EscrowError::MathOverflow))?;
    let config = &mut ctx.accounts.config;
    config.pending_verifier = Some(new_verifier);
    config.pending_verifier_ready_at = ready_at;
    emit!(VerifierRotationProposed {
        current_verifier: config.verifier,
        pending_verifier: new_verifier,
        ready_at
    });
    Ok(())
}

pub fn cancel_verifier_rotation(ctx: Context<AdminOnly>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let cancelled = config
        .pending_verifier
        .ok_or(error!(EscrowError::NoPendingVerifier))?;
    config.pending_verifier = None;
    config.pending_verifier_ready_at = 0;
    emit!(VerifierRotationCancelled {
        cancelled_verifier: cancelled
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ActivateVerifier<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Permissionless once the delay has elapsed, so activation cannot be withheld
/// to keep donors' early-refund window open indefinitely (or vice versa).
pub fn activate_verifier(ctx: Context<ActivateVerifier>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    let pending = config
        .pending_verifier
        .ok_or(error!(EscrowError::NoPendingVerifier))?;
    require!(
        now >= config.pending_verifier_ready_at,
        EscrowError::VerifierRotationNotReady
    );
    let previous_verifier = config.verifier;
    config.verifier = pending;
    config.verifier_epoch = config
        .verifier_epoch
        .checked_add(1)
        .ok_or(error!(EscrowError::MathOverflow))?;
    config.pending_verifier = None;
    config.pending_verifier_ready_at = 0;
    emit!(VerifierRotated {
        previous_verifier,
        verifier: pending,
        verifier_epoch: config.verifier_epoch
    });
    Ok(())
}

pub fn set_releases_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.releases_paused = paused;
    emit!(ReleasesPausedSet { paused });
    Ok(())
}
