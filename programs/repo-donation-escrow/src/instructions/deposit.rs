use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::{
        ALLOWED_MINT_SEED, CONFIG_SEED, DEPOSIT_SEED, DEPOSIT_VAULT_SEED, REFUND_DELAY_SECS,
        REPO_SEED,
    },
    errors::EscrowError,
    events::DepositMade,
    mint_policy::evaluate_mint,
    state::{AllowedMint, Config, Deposit, RepoVault},
};

#[derive(Accounts)]
#[instruction(repo_id: u64, deposit_index: u64)]
pub struct MakeDeposit<'info> {
    #[account(mut)]
    pub donor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ALLOWED_MINT_SEED, mint.key().as_ref()],
        bump = allowed_mint.bump,
        has_one = mint,
        constraint = allowed_mint.token_program == token_program.key() @ EscrowError::TokenProgramMismatch,
    )]
    pub allowed_mint: Box<Account<'info, AllowedMint>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = donor,
        token::token_program = token_program,
    )]
    pub donor_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = donor,
        space = 8 + RepoVault::INIT_SPACE,
        seeds = [REPO_SEED, repo_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub repo_vault: Box<Account<'info, RepoVault>>,
    #[account(
        init,
        payer = donor,
        space = 8 + Deposit::INIT_SPACE,
        seeds = [DEPOSIT_SEED, repo_id.to_le_bytes().as_ref(), deposit_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub deposit: Box<Account<'info, Deposit>>,
    /// PDA token account: only this program can create it, so nobody can front-run
    /// its creation to block a deposit index.
    #[account(
        init,
        payer = donor,
        seeds = [DEPOSIT_VAULT_SEED, deposit.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = deposit,
        token::token_program = token_program,
    )]
    pub deposit_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn make_deposit(
    ctx: Context<MakeDeposit>,
    repo_id: u64,
    deposit_index: u64,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, EscrowError::ZeroAmount);
    let repo_vault = &mut ctx.accounts.repo_vault;
    // Idempotent for an existing vault: the PDA seeds already pin both values.
    repo_vault.repo_id = repo_id;
    repo_vault.bump = ctx.bumps.repo_vault;
    require!(
        deposit_index == repo_vault.deposit_count,
        EscrowError::DepositIndexMismatch
    );

    // Re-check live mint state: e.g. a dormant transfer hook may have been activated.
    let allowed = &ctx.accounts.allowed_mint;
    evaluate_mint(
        &ctx.accounts.mint.to_account_info(),
        allowed.allow_permanent_delegate,
    )?;

    let before = ctx.accounts.deposit_vault.amount;
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.donor_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.deposit_vault.to_account_info(),
                authority: ctx.accounts.donor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    ctx.accounts.deposit_vault.reload()?;
    let received = ctx
        .accounts
        .deposit_vault
        .amount
        .checked_sub(before)
        .ok_or(error!(EscrowError::MathOverflow))?;
    require!(
        received >= allowed.min_deposit,
        EscrowError::BelowMinimumDeposit
    );

    let now = Clock::get()?.unix_timestamp;
    let refund_after = now
        .checked_add(REFUND_DELAY_SECS)
        .ok_or(error!(EscrowError::MathOverflow))?;
    let deposit_key = ctx.accounts.deposit.key();
    let donor = ctx.accounts.donor.key();
    let mint = ctx.accounts.mint.key();
    let token_program = ctx.accounts.token_program.key();
    ctx.accounts.deposit.set_inner(Deposit {
        repo_id,
        index: deposit_index,
        donor,
        mint,
        token_program,
        vault: ctx.accounts.deposit_vault.key(),
        requested_amount: amount,
        amount: received,
        created_at: now,
        refund_after,
        verifier_epoch: ctx.accounts.config.verifier_epoch,
        bump: ctx.bumps.deposit,
        vault_bump: ctx.bumps.deposit_vault,
    });

    let repo_vault = &mut ctx.accounts.repo_vault;
    repo_vault.deposit_count = repo_vault
        .deposit_count
        .checked_add(1)
        .ok_or(error!(EscrowError::MathOverflow))?;
    repo_vault.open_deposits = repo_vault
        .open_deposits
        .checked_add(1)
        .ok_or(error!(EscrowError::MathOverflow))?;

    emit!(DepositMade {
        repo_id,
        index: deposit_index,
        deposit: deposit_key,
        donor,
        mint,
        token_program,
        requested_amount: amount,
        amount: received,
        created_at: now,
        refund_after,
    });
    Ok(())
}
