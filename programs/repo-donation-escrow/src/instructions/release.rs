use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    attestation::{attestation_message, verify_release_attestation},
    constants::{CONFIG_SEED, DEPOSIT_SEED, DEPOSIT_VAULT_SEED, REPO_SEED},
    errors::EscrowError,
    events::DepositReleased,
    state::{Config, Deposit, RepoVault},
    token_ops::{pay_out_and_close, Payout},
};

#[derive(Accounts)]
#[instruction(repo_id: u64)]
pub struct Release<'info> {
    /// Anyone may submit (the maintainer or a relayer); funds can only go to `recipient`.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [REPO_SEED, repo_id.to_le_bytes().as_ref()], bump = repo_vault.bump)]
    pub repo_vault: Box<Account<'info, RepoVault>>,
    /// Closed at the end of the instruction; all of its rent goes to the donor.
    #[account(
        mut,
        close = donor,
        seeds = [DEPOSIT_SEED, repo_id.to_le_bytes().as_ref(), deposit.index.to_le_bytes().as_ref()],
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
    /// Writable because Token-2022 fee harvesting credits withheld fees to the mint.
    #[account(mut, address = deposit.mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: bound by the verifier's attestation; only used as the ATA owner.
    pub recipient: UncheckedAccount<'info>,
    /// Must be the recipient's canonical ATA, so funds cannot be routed to an
    /// arbitrary token account even by a correctly attested release.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the vault's and the deposit record's rent; pinned to the depositor.
    #[account(mut, address = deposit.donor)]
    pub donor: UncheckedAccount<'info>,
    /// CHECK: address-constrained to the instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(address = deposit.token_program @ EscrowError::TokenProgramMismatch)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn release(ctx: Context<Release>, repo_id: u64, expiry: i64, nonce: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.releases_paused, EscrowError::ReleasesPaused);
    let now = Clock::get()?.unix_timestamp;
    require!(now < expiry, EscrowError::AttestationExpired);
    require!(
        nonce > ctx.accounts.repo_vault.last_release_nonce,
        EscrowError::AttestationNonceReplayed
    );

    let recipient = ctx.accounts.recipient.key();
    let expected = attestation_message(ctx.program_id, repo_id, &recipient, expiry, nonce);
    verify_release_attestation(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &config.verifier,
        &expected,
    )?;

    let settled_amount = pay_out_and_close(Payout {
        deposit: &ctx.accounts.deposit,
        vault: ctx.accounts.deposit_vault.to_account_info(),
        vault_balance: ctx.accounts.deposit_vault.amount,
        mint: ctx.accounts.mint.to_account_info(),
        decimals: ctx.accounts.mint.decimals,
        destination: ctx.accounts.recipient_token_account.to_account_info(),
        rent_destination: ctx.accounts.donor.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    })?;

    let repo_vault = &mut ctx.accounts.repo_vault;
    repo_vault.last_release_nonce = nonce;
    repo_vault.open_deposits = repo_vault
        .open_deposits
        .checked_sub(1)
        .ok_or(error!(EscrowError::MathOverflow))?;

    let deposit = &ctx.accounts.deposit;
    emit!(DepositReleased {
        repo_id,
        index: deposit.index,
        deposit: deposit.key(),
        mint: deposit.mint,
        recipient,
        amount: settled_amount,
        nonce,
    });
    Ok(())
}
