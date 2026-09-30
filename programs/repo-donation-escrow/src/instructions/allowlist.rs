use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::{
    constants::{ALLOWED_MINT_SEED, CONFIG_SEED},
    errors::EscrowError,
    events::{MintAllowed, MintRemoved},
    mint_policy::evaluate_mint,
    state::{AllowedMint, Config},
};

#[derive(Accounts)]
pub struct AddAllowedMint<'info> {
    #[account(mut)]
    pub allowlist_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = allowlist_authority @ EscrowError::NotAllowlistAuthority,
    )]
    pub config: Account<'info, Config>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = allowlist_authority,
        space = 8 + AllowedMint::INIT_SPACE,
        seeds = [ALLOWED_MINT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub allowed_mint: Account<'info, AllowedMint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn add_allowed_mint(
    ctx: Context<AddAllowedMint>,
    min_deposit: u64,
    allow_permanent_delegate: bool,
) -> Result<()> {
    require!(min_deposit > 0, EscrowError::InvalidMinDeposit);
    let mint_info = ctx.accounts.mint.to_account_info();
    let profile = evaluate_mint(&mint_info, allow_permanent_delegate)?;
    let mint_key = ctx.accounts.mint.key();
    let token_program = ctx.accounts.token_program.key();
    ctx.accounts.allowed_mint.set_inner(AllowedMint {
        mint: mint_key,
        token_program,
        decimals: ctx.accounts.mint.decimals,
        min_deposit,
        allow_permanent_delegate,
        has_transfer_fee: profile.has_transfer_fee,
        has_permanent_delegate: profile.has_permanent_delegate,
        has_freeze_authority: profile.has_freeze_authority,
        added_at: Clock::get()?.unix_timestamp,
        bump: ctx.bumps.allowed_mint,
    });
    emit!(MintAllowed {
        mint: mint_key,
        token_program,
        min_deposit,
        has_transfer_fee: profile.has_transfer_fee,
        has_permanent_delegate: profile.has_permanent_delegate,
        has_freeze_authority: profile.has_freeze_authority,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RemoveAllowedMint<'info> {
    #[account(mut)]
    pub allowlist_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = allowlist_authority @ EscrowError::NotAllowlistAuthority,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = allowlist_authority,
        seeds = [ALLOWED_MINT_SEED, allowed_mint.mint.as_ref()],
        bump = allowed_mint.bump,
    )]
    pub allowed_mint: Account<'info, AllowedMint>,
}

/// Stops new deposits of this mint. Existing deposits can still be released or
/// refunded: neither path reads the allowlist.
pub fn remove_allowed_mint(ctx: Context<RemoveAllowedMint>) -> Result<()> {
    emit!(MintRemoved {
        mint: ctx.accounts.allowed_mint.mint
    });
    Ok(())
}
