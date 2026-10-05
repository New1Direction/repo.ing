//! repo.ing contributor early access: a Token-2022 transfer hook (docs/EARLY_ACCESS.md).
//!
//! Until `early_access_end`, a transfer of the token is refused unless it goes to
//! - the Meteora DBC pool (a sell), or
//! - an associated token account (ImmutableOwner) whose owner is on the mint's allow list.
//! After `early_access_end` the hook allows every transfer. A transfer of 0 tokens is always allowed.
//!
//! The extra accounts are derived from the mint alone (config and allow list), so a client that
//! resolves them without the real source or destination (the Meteora DBC SDK does) still gets them right.
//! The hook never writes to any account, so calling it directly does nothing.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_token_2022_interface::extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions};
use spl_token_2022_interface::state::Account as TokenAccountState;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("Ew1wqkFkxDADJi7iQnBTqy8fELDDotEeE8uzvg7TL6ep");

pub const PLATFORM_SEED: &[u8] = b"platform";
pub const CONFIG_SEED: &[u8] = b"config";
pub const ALLOW_SEED: &[u8] = b"allow";
/// Fixed by the SPL transfer hook interface. Token-2022 looks here.
pub const EXTRA_METAS_SEED: &[u8] = b"extra-account-metas";

/// Meteora DBC's pool authority PDA (["pool_authority"] under dbcij3LW…). It owns every pool's
/// base vault, so a transfer to an account it owns is a sell into the curve.
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");

/// Early access lasts 24 hours at most, so a bad timestamp (milliseconds, say) cannot close a token for good.
pub const MAX_EARLY_ACCESS_SECS: i64 = 24 * 60 * 60;
/// One add or remove call changes at most this many wallets (transaction size bounds it anyway).
pub const MAX_WALLETS_PER_CALL: usize = 24;
/// An allow list holds at most this many wallets (32 KiB of keys). Lists are changed in place, never
/// copied to the heap, so this is the real limit.
pub const MAX_ALLOW_LIST: usize = 1024;

/// Allow-list account layout: discriminator, mint, count (u32 LE), then `count` sorted 32-byte keys.
pub const ALLOW_LIST_DISCRIMINATOR: [u8; 8] = *b"ea-allow";
const ALLOW_HEADER: usize = 8 + 32 + 4;

const EXTRA_METAS_LEN: usize = 2;

#[program]
pub mod early_access_hook {
    use super::*;

    /// One time. Only the program's upgrade authority may call it, so nobody can take the admin
    /// role between the deploy and this call.
    pub fn init_platform(ctx: Context<InitPlatform>, admin: Pubkey, oracle: Pubkey) -> Result<()> {
        require_real_keys(&admin, &oracle)?;
        let platform = &mut ctx.accounts.platform;
        platform.admin = admin;
        platform.oracle = oracle;
        platform.bump = ctx.bumps.platform;
        Ok(())
    }

    /// Change the admin or oracle key. Admin only.
    pub fn set_platform(ctx: Context<SetPlatform>, admin: Pubkey, oracle: Pubkey) -> Result<()> {
        require_real_keys(&admin, &oracle)?;
        let platform = &mut ctx.accounts.platform;
        platform.admin = admin;
        platform.oracle = oracle;
        Ok(())
    }

    /// Set one token's window and first wallets. The admin authorizes it, once per mint, before the first
    /// trade (repo.ing puts it in the launch transaction, ahead of the pool's creation); `payer` pays the
    /// rent and gets its share back when the allow list is closed. The mint need not exist yet. The window
    /// must end in the future, within 24 hours; no instruction changes it later.
    pub fn init_mint(ctx: Context<InitMint>, repo_id: u64, early_access_end: i64, wallets: Vec<Pubkey>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(early_access_end > now, HookError::BadWindow);
        require!(early_access_end - now <= MAX_EARLY_ACCESS_SECS, HookError::BadWindow);
        require!(wallets.len() <= MAX_WALLETS_PER_CALL, HookError::TooManyWallets);

        let mint = ctx.accounts.mint.key();
        let keys = sorted_unique(wallets);
        let deposit = create_allow_list(
            &ctx.accounts.allow_list,
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.system_program,
            &mint,
            ctx.bumps.allow_list,
            &keys,
        )?;
        let config = &mut ctx.accounts.config;
        config.mint = mint;
        config.repo_id = repo_id;
        config.early_access_end = early_access_end;
        config.rent_receiver = ctx.accounts.payer.key();
        config.list_deposit = deposit;
        config.allow_bump = ctx.bumps.allow_list;
        config.bump = ctx.bumps.config;

        // Indexes 0-4 are source, mint, destination, owner and this list; 5 is the config, 6 the allow list.
        let metas = [
            ExtraAccountMeta::new_with_seeds(
                &[Seed::Literal { bytes: CONFIG_SEED.to_vec() }, Seed::AccountKey { index: 1 }],
                false,
                false,
            )?,
            ExtraAccountMeta::new_with_seeds(
                &[Seed::Literal { bytes: ALLOW_SEED.to_vec() }, Seed::AccountKey { index: 1 }],
                false,
                false,
            )?,
        ];
        let list = ctx.accounts.extra_account_meta_list.to_account_info();
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut list.try_borrow_mut_data()?, &metas)?;

        emit!(MintConfigured { mint, repo_id, early_access_end, wallets: keys.len() as u32 });
        Ok(())
    }

    /// Put wallets on a token's allow list. Oracle only, while the window is open; the oracle pays for
    /// the larger list and gets that back when it is closed.
    pub fn add_wallets(ctx: Context<AddWallets>, wallets: Vec<Pubkey>) -> Result<()> {
        require!(wallets.len() <= MAX_WALLETS_PER_CALL, HookError::TooManyWallets);
        let config = &ctx.accounts.config;
        require!(Clock::get()?.unix_timestamp < config.early_access_end, HookError::WindowClosed);

        let list = ctx.accounts.allow_list.to_account_info();
        let mut new_keys = sorted_unique(wallets);
        let count = {
            let data = list.try_borrow_data()?;
            let entries = allow_list_entries(&data, &config.mint)?;
            new_keys.retain(|key| find(entries, key).is_err());
            entries.len() / 32
        };
        if new_keys.is_empty() {
            return Ok(());
        }
        let total = count + new_keys.len();
        require!(total <= MAX_ALLOW_LIST, HookError::TooManyWallets);
        let size = ALLOW_HEADER + total * 32;
        let short = Rent::get()?.minimum_balance(size).saturating_sub(list.lamports());
        if short > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer { from: ctx.accounts.oracle.to_account_info(), to: list.clone() },
                ),
                short,
            )?;
        }
        list.resize(size)?;
        {
            // Merge from the back, so every old key moves at most once and nothing is copied to the heap.
            let mut data = list.try_borrow_mut_data()?;
            let keys = &mut data[ALLOW_HEADER..];
            let (mut old, mut new, mut slot) = (count, new_keys.len(), total);
            while new > 0 {
                slot -= 1;
                if old > 0 && keys[(old - 1) * 32..old * 32].cmp(new_keys[new - 1].as_ref()) == std::cmp::Ordering::Greater {
                    keys.copy_within((old - 1) * 32..old * 32, slot * 32);
                    old -= 1;
                } else {
                    keys[slot * 32..slot * 32 + 32].copy_from_slice(new_keys[new - 1].as_ref());
                    new -= 1;
                }
            }
            data[40..44].copy_from_slice(&(total as u32).to_le_bytes());
        }
        emit!(WalletsChanged { mint: config.mint, wallets: total as u32 });
        Ok(())
    }

    /// Take wallets off a token's allow list. Oracle or admin, any time. repo.ing's launch transaction
    /// uses it (signed by the admin) to take a non-contributor launcher off right after the first buy.
    pub fn remove_wallets(ctx: Context<RemoveWallets>, wallets: Vec<Pubkey>) -> Result<()> {
        require!(wallets.len() <= MAX_WALLETS_PER_CALL, HookError::TooManyWallets);
        let config = &ctx.accounts.config;
        let list = ctx.accounts.allow_list.to_account_info();
        let gone = sorted_unique(wallets);
        let kept = {
            let mut data = list.try_borrow_mut_data()?;
            let count = allow_list_entries(&data, &config.mint)?.len() / 32;
            let keys = &mut data[ALLOW_HEADER..];
            let mut kept = 0;
            for index in 0..count {
                let key = &keys[index * 32..index * 32 + 32];
                if gone.binary_search_by(|wallet| wallet.as_ref().cmp(key)).is_ok() {
                    continue;
                }
                if kept != index {
                    keys.copy_within(index * 32..index * 32 + 32, kept * 32);
                }
                kept += 1;
            }
            data[40..44].copy_from_slice(&(kept as u32).to_le_bytes());
            kept
        };
        list.resize(ALLOW_HEADER + kept * 32)?;
        emit!(WalletsChanged { mint: config.mint, wallets: kept as u32 });
        Ok(())
    }

    /// After the window, anyone may close the allow list. The launch payer gets back what it paid at
    /// setup and the oracle the rest (its payments for a larger list). The hook no longer reads it then.
    pub fn close_allow_list(ctx: Context<CloseAllowList>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(Clock::get()?.unix_timestamp >= config.early_access_end, HookError::WindowOpen);
        let list = ctx.accounts.allow_list.to_account_info();
        let lamports = list.lamports();
        let to_payer = lamports.min(config.list_deposit);
        let to_oracle = lamports - to_payer;
        for (receiver, amount) in [(ctx.accounts.rent_receiver.to_account_info(), to_payer), (ctx.accounts.oracle.to_account_info(), to_oracle)] {
            **receiver.try_borrow_mut_lamports()? = receiver.lamports().checked_add(amount).ok_or(HookError::MathOverflow)?;
        }
        **list.try_borrow_mut_lamports()? = 0;
        list.resize(0)?;
        list.assign(&system_program::ID);
        Ok(())
    }

    /// Token-2022 calls this on every transfer, after balances have moved. An error cancels the transfer.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        if amount == 0 || Clock::get()?.unix_timestamp >= config.early_access_end {
            return Ok(());
        }
        let destination = ctx.accounts.destination_token.to_account_info();
        let data = destination.try_borrow_data()?;
        let state = StateWithExtensions::<TokenAccountState>::unpack(&data).map_err(|_| HookError::BadDestination)?;
        require_keys_eq!(state.base.mint, ctx.accounts.mint.key(), HookError::BadDestination);
        let receiver = state.base.owner;
        if receiver == DBC_POOL_AUTHORITY {
            return Ok(());
        }
        let immutable = state
            .get_extension_types()
            .map_err(|_| HookError::BadDestination)?
            .contains(&ExtensionType::ImmutableOwner);
        require!(immutable, HookError::NotAssociatedAccount);
        let list = ctx.accounts.allow_list.to_account_info();
        let listed = *list.owner == crate::ID && {
            let data = list.try_borrow_data()?;
            find(allow_list_entries(&data, &config.mint)?, &receiver).is_ok()
        };
        require!(listed, HookError::NotContributor);
        Ok(())
    }
}

// ------------------------------------------------------------ allow list

fn require_real_keys(admin: &Pubkey, oracle: &Pubkey) -> Result<()> {
    require!(*admin != Pubkey::default() && *oracle != Pubkey::default(), HookError::BadKey);
    Ok(())
}

fn sorted_unique(mut keys: Vec<Pubkey>) -> Vec<Pubkey> {
    keys.sort();
    keys.dedup();
    keys
}

/// Creates the allow list with `keys` (sorted, unique) and returns the lamports the payer put in.
fn create_allow_list<'info>(
    list: &UncheckedAccount<'info>,
    payer: &AccountInfo<'info>,
    system: &Program<'info, System>,
    mint: &Pubkey,
    bump: u8,
    keys: &[Pubkey],
) -> Result<u64> {
    let size = ALLOW_HEADER + keys.len() * 32;
    let rent = Rent::get()?.minimum_balance(size);
    let seeds: &[&[u8]] = &[ALLOW_SEED, mint.as_ref(), &[bump]];
    let account = list.to_account_info();
    let existing = account.lamports();
    let paid = rent.saturating_sub(existing);
    if existing == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                system.key(),
                system_program::CreateAccount { from: payer.clone(), to: account.clone() },
                &[seeds],
            ),
            rent,
            size as u64,
            &crate::ID,
        )?;
    } else {
        // Someone sent lamports to the address first: top up, allocate and assign, as Anchor's `init` does.
        if paid > 0 {
            system_program::transfer(
                CpiContext::new(system.key(), system_program::Transfer { from: payer.clone(), to: account.clone() }),
                paid,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(system.key(), system_program::Allocate { account_to_allocate: account.clone() }, &[seeds]),
            size as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(system.key(), system_program::Assign { account_to_assign: account.clone() }, &[seeds]),
            &crate::ID,
        )?;
    }
    let mut data = account.try_borrow_mut_data()?;
    data[..8].copy_from_slice(&ALLOW_LIST_DISCRIMINATOR);
    data[8..40].copy_from_slice(mint.as_ref());
    data[40..44].copy_from_slice(&(keys.len() as u32).to_le_bytes());
    for (index, key) in keys.iter().enumerate() {
        data[ALLOW_HEADER + index * 32..ALLOW_HEADER + index * 32 + 32].copy_from_slice(key.as_ref());
    }
    Ok(paid)
}

/// The sorted keys of an allow list, checked against its layout and mint.
fn allow_list_entries<'a>(data: &'a [u8], mint: &Pubkey) -> Result<&'a [u8]> {
    require!(data.len() >= ALLOW_HEADER && data[..8] == ALLOW_LIST_DISCRIMINATOR, HookError::BadAllowList);
    require!(&data[8..40] == mint.as_ref(), HookError::BadAllowList);
    let count = u32::from_le_bytes(data[40..44].try_into().unwrap()) as usize;
    let end = ALLOW_HEADER + count.checked_mul(32).ok_or(HookError::BadAllowList)?;
    require!(data.len() >= end, HookError::BadAllowList);
    Ok(&data[ALLOW_HEADER..end])
}

/// Binary search over sorted 32-byte keys: Ok(index) when present, Err(insertion point) when not.
fn find(entries: &[u8], wallet: &Pubkey) -> std::result::Result<usize, usize> {
    let target = wallet.as_ref();
    let (mut low, mut high) = (0usize, entries.len() / 32);
    while low < high {
        let middle = (low + high) / 2;
        match entries[middle * 32..middle * 32 + 32].cmp(target) {
            std::cmp::Ordering::Equal => return Ok(middle),
            std::cmp::Ordering::Less => low = middle + 1,
            std::cmp::Ordering::Greater => high = middle,
        }
    }
    Err(low)
}

// ---------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Platform {
    /// Sets up tokens (repo.ing's launch co-signer). May also remove wallets.
    pub admin: Pubkey,
    /// Adds and removes wallets as contributors link them.
    pub oracle: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MintConfig {
    pub mint: Pubkey,
    /// GitHub numeric repository id, so anyone can check the list against GitHub.
    pub repo_id: u64,
    /// Unix time the window ends.
    pub early_access_end: i64,
    /// Paid for the setup; gets `list_deposit` back when the allow list is closed.
    pub rent_receiver: Pubkey,
    /// Lamports `rent_receiver` put into the allow list.
    pub list_deposit: u64,
    pub allow_bump: u8,
    pub bump: u8,
}

// ------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitPlatform<'info> {
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(init, payer = upgrade_authority, space = 8 + Platform::INIT_SPACE, seeds = [PLATFORM_SEED], bump)]
    pub platform: Account<'info, Platform>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ HookError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::EarlyAccessHook>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ HookError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPlatform<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump, has_one = admin @ HookError::NotAdmin)]
    pub platform: Account<'info, Platform>,
}

#[derive(Accounts)]
pub struct InitMint<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, has_one = admin @ HookError::NotAdmin)]
    pub platform: Account<'info, Platform>,
    /// CHECK: only the address is used. The mint may not exist yet.
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + MintConfig::INIT_SPACE, seeds = [CONFIG_SEED, mint.key().as_ref()], bump)]
    pub config: Account<'info, MintConfig>,
    /// CHECK: created here with the allow-list layout.
    #[account(mut, seeds = [ALLOW_SEED, mint.key().as_ref()], bump)]
    pub allow_list: UncheckedAccount<'info>,
    /// CHECK: created here, filled by `ExtraAccountMetaList::init`.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(EXTRA_METAS_LEN)?,
        seeds = [EXTRA_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddWallets<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, has_one = oracle @ HookError::NotOracle)]
    pub platform: Account<'info, Platform>,
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, MintConfig>,
    /// CHECK: address checked here, owner checked here, layout checked when read.
    #[account(mut, seeds = [ALLOW_SEED, config.mint.as_ref()], bump = config.allow_bump, owner = crate::ID @ HookError::BadAllowList)]
    pub allow_list: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveWallets<'info> {
    #[account(constraint = authority.key() == platform.oracle || authority.key() == platform.admin @ HookError::NotOracle)]
    pub authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Account<'info, Platform>,
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, MintConfig>,
    /// CHECK: address checked here, owner checked here, layout checked when read.
    #[account(mut, seeds = [ALLOW_SEED, config.mint.as_ref()], bump = config.allow_bump, owner = crate::ID @ HookError::BadAllowList)]
    pub allow_list: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseAllowList<'info> {
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump, has_one = rent_receiver @ HookError::BadAllowList)]
    pub config: Account<'info, MintConfig>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump, has_one = oracle @ HookError::NotOracle)]
    pub platform: Account<'info, Platform>,
    /// CHECK: address checked here; must still be this program's.
    #[account(mut, seeds = [ALLOW_SEED, config.mint.as_ref()], bump = config.allow_bump, owner = crate::ID @ HookError::BadAllowList)]
    pub allow_list: UncheckedAccount<'info>,
    /// CHECK: must equal `config.rent_receiver`.
    #[account(mut)]
    pub rent_receiver: UncheckedAccount<'info>,
    /// CHECK: must equal `platform.oracle`.
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
}

/// Account order is fixed by the SPL transfer hook interface.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// CHECK: not read.
    pub source_token: UncheckedAccount<'info>,
    /// CHECK: only its address is compared with the destination's mint.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: owned by Token-2022; unpacked in the handler.
    #[account(owner = spl_token_2022_interface::ID @ HookError::BadDestination)]
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: not read.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: Token-2022 reads it to find the accounts below.
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, MintConfig>,
    /// CHECK: address checked here; read only while the window is open.
    #[account(seeds = [ALLOW_SEED, mint.key().as_ref()], bump = config.allow_bump)]
    pub allow_list: UncheckedAccount<'info>,
}

// --------------------------------------------------------------- events

#[event]
pub struct MintConfigured {
    pub mint: Pubkey,
    pub repo_id: u64,
    pub early_access_end: i64,
    pub wallets: u32,
}

#[event]
pub struct WalletsChanged {
    pub mint: Pubkey,
    pub wallets: u32,
}

// --------------------------------------------------------------- errors

#[error_code]
pub enum HookError {
    #[msg("Only the program's upgrade authority can do this")]
    NotUpgradeAuthority,
    #[msg("Only the platform admin can do this")]
    NotAdmin,
    #[msg("Only the platform oracle can do this")]
    NotOracle,
    #[msg("Early access must end in the future and within 24 hours")]
    BadWindow,
    #[msg("Too many wallets")]
    TooManyWallets,
    #[msg("The early access window is closed")]
    WindowClosed,
    #[msg("The early access window is still open")]
    WindowOpen,
    #[msg("Bad allow list account")]
    BadAllowList,
    #[msg("Bad destination token account")]
    BadDestination,
    #[msg("Early access: tokens can go only to an associated token account right now")]
    NotAssociatedAccount,
    #[msg("Early access: only repo contributors can receive this token right now")]
    NotContributor,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("The admin and oracle keys must be real keys")]
    BadKey,
}
