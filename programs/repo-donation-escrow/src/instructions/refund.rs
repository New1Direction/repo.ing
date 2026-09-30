use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{CONFIG_SEED, DEPOSIT_SEED, DEPOSIT_VAULT_SEED, REPO_SEED},
    errors::EscrowError,
    events::DepositRefunded,
    state::{Config, Deposit, RepoVault},
    token_ops::{pay_out_and_close, Payout},
};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub donor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [REPO_SEED, deposit.repo_id.to_le_bytes().as_ref()],
        bump = repo_vault.bump,
    )]
    pub repo_vault: Box<Account<'info, RepoVault>>,
    #[account(
        mut,
        has_one = donor,
        close = donor,
        seeds = [DEPOSIT_SEED, deposit.repo_id.to_le_bytes().as_ref(), deposit.index.to_le_bytes().as_ref()],
        bump = deposit.bump,
    )]
    pub deposit: Box<Account<'info, Deposit>>,
    #[account(
        mut,
        address = deposit.vault,
        seeds = [DEPOSIT_VAULT_SEED, deposit.key().as_ref()],
        bump = deposit.vault_bump,
    )]
    pub deposit_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = deposit.mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = donor,
        associated_token::mint = mint,
        associated_token::authority = donor,
        associated_token::token_program = token_program,
    )]
    pub donor_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = deposit.token_program @ EscrowError::TokenProgramMismatch)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Refund is available to the donor once `refund_after` has passed, or earlier if the
/// verifier set has changed (or a change is pending) since the deposit was made, so
/// donors never have to trust a verifier they did not deposit under.
pub fn refund(ctx: Context<Refund>) -> Result<()> {
    let deposit = &ctx.accounts.deposit;
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    let matured = now >= deposit.refund_after;
    let verifier_changed =
        config.verifier_epoch != deposit.verifier_epoch || config.pending_verifier.is_some();
    require!(
        matured || verifier_changed,
        EscrowError::RefundNotYetAvailable
    );

    let settled_amount = pay_out_and_close(Payout {
        deposit: &ctx.accounts.deposit,
        vault: ctx.accounts.deposit_vault.to_account_info(),
        vault_balance: ctx.accounts.deposit_vault.amount,
        mint: ctx.accounts.mint.to_account_info(),
        decimals: ctx.accounts.mint.decimals,
        destination: ctx.accounts.donor_token_account.to_account_info(),
        rent_destination: ctx.accounts.donor.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    })?;

    let repo_vault = &mut ctx.accounts.repo_vault;
    repo_vault.open_deposits = repo_vault
        .open_deposits
        .checked_sub(1)
        .ok_or(error!(EscrowError::MathOverflow))?;

    let donor = ctx.accounts.donor.key();
    let deposit = &ctx.accounts.deposit;

    emit!(DepositRefunded {
        repo_id: deposit.repo_id,
        index: deposit.index,
        deposit: deposit.key(),
        mint: deposit.mint,
        donor,
        amount: settled_amount,
        early: !matured,
    });
    Ok(())
}
