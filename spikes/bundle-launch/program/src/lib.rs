//! SPIKE ONLY, never for mainnet: the smallest program that answers the Bundle launch mode's on-chain unknowns on
//! Meteora's mainnet programs (a local validator).
//!
//! - A bundle account holds the raise (escrow). `release` pays part of it to the launch signer only when a later
//!   instruction of the same transaction is this program's `settle` for the same bundle; `settle` refuses unless the
//!   vault's token account holds at least the quoted tokens. Between them, DBC creates the pool and the launch signer
//!   makes the first swap at top level (the only way DBC charges the first swap its minimum fee), with the vault as the
//!   receiver.
//! - `vault_invoke` / `router_invoke`: the vault PDA (per bundle) or the router PDA (the bundle config's fee claimer)
//!   signs one call to DBC or DAMM v2, so the spike can try swaps and fee claims by CPI. The real program has typed
//!   instructions with limits instead of a pass-through.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_lang::Discriminator;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

declare_id!("7Yx7Ueyu2tsLWZUzDZVET3Dm3Q45HjQthKYwpQkhTvQj");

pub const DBC: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DAMM_V2: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const SPL_TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const INSTRUCTIONS_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
pub const BUNDLE_SEED: &[u8] = b"bundle";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ROUTER_SEED: &[u8] = b"router";

#[program]
pub mod bundle_vault_spike {
    use super::*;

    pub fn create_bundle(ctx: Context<CreateBundle>, id: u64, launch_signer: Pubkey) -> Result<()> {
        let key = ctx.accounts.bundle.key();
        let bundle = &mut ctx.accounts.bundle;
        bundle.id = id;
        bundle.admin = ctx.accounts.admin.key();
        bundle.launch_signer = launch_signer;
        bundle.bump = ctx.bumps.bundle;
        bundle.vault_bump = Pubkey::find_program_address(&[VAULT_SEED, key.as_ref()], &crate::ID).1;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, lamports: u64) -> Result<()> {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer { from: ctx.accounts.backer.to_account_info(), to: ctx.accounts.bundle.to_account_info() },
            ),
            lamports,
        )?;
        let bundle = &mut ctx.accounts.bundle;
        bundle.raised = bundle.raised.checked_add(lamports).ok_or(SpikeError::Math)?;
        Ok(())
    }

    pub fn release(ctx: Context<Release>, lamports: u64) -> Result<()> {
        let sysvar = ctx.accounts.instructions.to_account_info();
        let current = load_current_index_checked(&sysvar)? as usize;
        let key = ctx.accounts.bundle.key();
        let mut settled = false;
        let mut index = current + 1;
        while let Ok(ix) = load_instruction_at_checked(index, &sysvar) {
            if ix.program_id == crate::ID
                && ix.data.starts_with(instruction::Settle::DISCRIMINATOR)
                && ix.accounts.first().map(|meta| meta.pubkey) == Some(key)
            {
                settled = true;
                break;
            }
            index += 1;
        }
        require!(settled, SpikeError::NoSettle);
        let bundle = &mut ctx.accounts.bundle;
        let left = bundle.raised.checked_sub(bundle.released).ok_or(SpikeError::Math)?;
        require!(lamports > 0 && lamports <= left, SpikeError::TooMuch);
        bundle.released = bundle.released.checked_add(lamports).ok_or(SpikeError::Math)?;
        let from = bundle.to_account_info();
        **from.try_borrow_mut_lamports()? = from.lamports().checked_sub(lamports).ok_or(SpikeError::Math)?;
        let to = ctx.accounts.launch_signer.to_account_info();
        **to.try_borrow_mut_lamports()? = to.lamports().checked_add(lamports).ok_or(SpikeError::Math)?;
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>, min_tokens: u64) -> Result<()> {
        let key = ctx.accounts.bundle.key();
        let vault = Pubkey::create_program_address(&[VAULT_SEED, key.as_ref(), &[ctx.accounts.bundle.vault_bump]], &crate::ID)
            .map_err(|_| SpikeError::BadVault)?;
        let account = ctx.accounts.vault_tokens.to_account_info();
        require_keys_eq!(*account.owner, SPL_TOKEN, SpikeError::BadVault);
        let data = account.try_borrow_data()?;
        require!(data.len() >= 72, SpikeError::BadVault);
        require!(data[32..64] == vault.to_bytes(), SpikeError::BadVault);
        let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
        drop(data);
        require!(amount >= min_tokens && amount > 0, SpikeError::TooFew);
        ctx.accounts.bundle.vault_tokens = amount;
        Ok(())
    }

    pub fn vault_invoke<'info>(ctx: Context<'info, VaultInvoke<'info>>, data: Vec<u8>) -> Result<()> {
        require_keys_eq!(ctx.accounts.operator.key(), ctx.accounts.bundle.admin, SpikeError::NotOperator);
        let key = ctx.accounts.bundle.key();
        let bump = [ctx.accounts.bundle.vault_bump];
        let seeds: &[&[u8]] = &[VAULT_SEED, key.as_ref(), &bump];
        let signer = Pubkey::create_program_address(seeds, &crate::ID).map_err(|_| SpikeError::BadVault)?;
        signed_call(&ctx.accounts.target, ctx.remaining_accounts, data, signer, seeds)
    }

    /// Spike only: anyone may call it. The real fee router checks its caller and splits what it claims.
    pub fn router_invoke<'info>(ctx: Context<'info, RouterInvoke<'info>>, data: Vec<u8>) -> Result<()> {
        let (signer, bump) = Pubkey::find_program_address(&[ROUTER_SEED], &crate::ID);
        let bump = [bump];
        let seeds: &[&[u8]] = &[ROUTER_SEED, &bump];
        signed_call(&ctx.accounts.target, ctx.remaining_accounts, data, signer, seeds)
    }
}

fn signed_call<'info>(
    target: &UncheckedAccount<'info>,
    accounts: &[AccountInfo<'info>],
    data: Vec<u8>,
    signer: Pubkey,
    seeds: &[&[u8]],
) -> Result<()> {
    require!(target.key() == DBC || target.key() == DAMM_V2, SpikeError::BadTarget);
    let metas = accounts
        .iter()
        .map(|account| AccountMeta { pubkey: *account.key, is_signer: account.is_signer || *account.key == signer, is_writable: account.is_writable })
        .collect();
    let mut infos = accounts.to_vec();
    infos.push(target.to_account_info());
    invoke_signed(&Instruction { program_id: target.key(), accounts: metas, data }, &infos, &[seeds])?;
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Bundle {
    pub id: u64,
    pub admin: Pubkey,
    pub launch_signer: Pubkey,
    pub raised: u64,
    pub released: u64,
    pub vault_tokens: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateBundle<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Bundle::INIT_SPACE, seeds = [BUNDLE_SEED, id.to_le_bytes().as_ref()], bump)]
    pub bundle: Account<'info, Bundle>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub backer: Signer<'info>,
    #[account(mut)]
    pub bundle: Account<'info, Bundle>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, has_one = launch_signer @ SpikeError::NotLaunchSigner)]
    pub bundle: Account<'info, Bundle>,
    #[account(mut)]
    pub launch_signer: Signer<'info>,
    /// CHECK: the instructions sysvar (address checked)
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, has_one = launch_signer @ SpikeError::NotLaunchSigner)]
    pub bundle: Account<'info, Bundle>,
    pub launch_signer: Signer<'info>,
    /// CHECK: the vault's SPL token account (program owner, token owner and amount checked in `settle`)
    pub vault_tokens: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VaultInvoke<'info> {
    pub operator: Signer<'info>,
    pub bundle: Account<'info, Bundle>,
    /// CHECK: DBC or DAMM v2 only (checked in `signed_call`)
    pub target: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RouterInvoke<'info> {
    pub caller: Signer<'info>,
    /// CHECK: DBC or DAMM v2 only (checked in `signed_call`)
    pub target: UncheckedAccount<'info>,
}

#[error_code]
pub enum SpikeError {
    #[msg("no settle for this bundle later in the transaction")]
    NoSettle,
    #[msg("more than the raise holds")]
    TooMuch,
    #[msg("the vault received fewer tokens than the quote")]
    TooFew,
    #[msg("not the vault's token account")]
    BadVault,
    #[msg("only DBC or DAMM v2")]
    BadTarget,
    #[msg("not the operator")]
    NotOperator,
    #[msg("not the launch signer")]
    NotLaunchSigner,
    #[msg("arithmetic overflow")]
    Math,
}
