//! repo.ing Bundle launches (docs/BUNDLE_LAUNCH.md).
//!
//! - Raise: backers deposit SOL into a bundle until its target. Each lamport is one share. A raise that misses its target
//!   by the deadline, that the admin cancels, or that is full but not launched within the grace period fails, and every
//!   backer takes back exactly what it put in.
//! - Launch (one transaction): `release` pays the operations share to the operations wallet and the rest to repo.ing's
//!   launch signer, only when this program's `settle` for the same bundle comes later in the transaction. Between them DBC
//!   creates the pool and the launch signer makes the first swap at top level (the only way DBC charges a first swap its
//!   minimum fee), with the vault as the receiver. `settle` refuses unless the vault holds at least the quoted tokens of
//!   a pool on the bundle config.
//! - Vault: a PDA with no withdraw instruction. Only platform operators trade it, only on its own market (DBC before
//!   graduation, DAMM v2 after), not before the launch fee ends, and within the bundle's policy: trade size, daily buys
//!   and sells, a sell floor at the vault's average cost, and a gap between a buy and a sell. The admin can only tighten
//!   a policy or pause a vault.
//! - Fees: the bundle config's fee claimer is this program's router PDA. Routing a claim pays back to the vault the
//!   partner fees its own trades generated (measured on the pool's counters around each vault trade), then splits the
//!   rest: `backer_bps` to the backers (pro rata to shares, claimed by each backer), the remainder to repo.ing's treasury.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::system_program;
use anchor_lang::Discriminator;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

declare_id!("5feqSRaVwGcAdR6Fzf73K8sxunV8cTC9pjEBhfbRxHCw");

// Meteora programs and their fixed accounts (as on mainnet; the chain test loads the same programs).
pub const DBC: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
pub const DAMM: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const DAMM_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
pub const SPL_TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const INSTRUCTIONS_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");

// Instruction and account discriminators of the Meteora programs (their IDLs, @meteora-ag SDKs).
const DBC_SWAP: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
const DBC_CLAIM_TRADING_FEE: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];
const DAMM_SWAP: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
const DAMM_CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];
const DBC_POOL_DISC: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
const DAMM_POOL_DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
const DAMM_POSITION_DISC: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
const DBC_CONFIG_DISC: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];

// Byte offsets in those accounts (discriminator included), from the same IDLs.
const DBC_POOL_CONFIG: usize = 72;
const DBC_POOL_BASE_MINT: usize = 136;
const DBC_POOL_BASE_VAULT: usize = 168;
const DBC_POOL_QUOTE_RESERVE: usize = 240;
const DBC_POOL_PARTNER_QUOTE_FEE: usize = 272;
const DBC_POOL_IS_MIGRATED: usize = 305;
const DBC_CONFIG_QUOTE_MINT: usize = 8;
const DBC_CONFIG_FEE_CLAIMER: usize = 40;
const DBC_CONFIG_COLLECT_FEE_MODE: usize = 232; // 0 = quote token
const DBC_CONFIG_TOKEN_TYPE: usize = 237; // 0 = SPL Token
const DAMM_POOL_TOKEN_A_MINT: usize = 168;
const DAMM_POOL_TOKEN_B_MINT: usize = 200;
const DAMM_POOL_COLLECT_FEE_MODE: usize = 484; // 1 = token B (SOL) only
const DAMM_POOL_FEE_B_PER_LIQUIDITY: usize = 520;
const DAMM_POSITION_POOL: usize = 8;
const DAMM_POSITION_NFT_MINT: usize = 40;
const DAMM_POSITION_LIQUIDITY: [usize; 3] = [152, 168, 184]; // unlocked, vested, permanent locked
const DAMM_POSITION_PERMANENT_LOCKED: usize = 184;

pub const PLATFORM_SEED: &[u8] = b"platform";
pub const BUNDLE_SEED: &[u8] = b"bundle";
pub const BACKER_SEED: &[u8] = b"backer";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ROUTER_SEED: &[u8] = b"router";

pub const BPS: u64 = 10_000;
/// Fixed point of `Bundle::acc_per_share` (backer income per share). At 1e18 a routing loses less than raised / 1e18 lamports
/// to rounding, and shares × acc_per_share (at most all backer income × 1e18) stays far inside u128.
pub const ACC_SCALE: u128 = 1_000_000_000_000_000_000;
/// The launch fee of repo.ing's launch-fee config lasts 180 s (docs/LAUNCH_FEE.md): no vault trade before it ends.
pub const MIN_LAUNCH_COOLDOWN_SECS: u32 = 180;
pub const MIN_LAUNCH_GRACE_SECS: u32 = 60;
pub const MAX_OPS_BPS: u16 = 2_000;
pub const MIN_TARGET: u64 = 1_000_000_000;
pub const MAX_TARGET: u64 = 10_000_000_000_000;
pub const MIN_DEPOSIT_FLOOR: u64 = 1_000_000;
pub const MAX_RAISE_SECS: i64 = 30 * DAY;
pub const MAX_FLOOR_BPS: u16 = 50_000;
pub const DAY: i64 = 86_400;
/// At settle the new pool must hold at least this share of the released SOL (the first swap pays 1.75%).
pub const LAUNCH_SPEND_BPS: u64 = 9_800;
/// The launch buy's partner fee is about 0.41% of it; settle refuses a pool whose partner fees exceed this share.
pub const MAX_LAUNCH_PARTNER_FEE_BPS: u64 = 100;
/// SPL Token mint: supply after the 36-byte mint authority option.
const MINT_SUPPLY: usize = 36;
/// Token account `state` byte (1 = initialized).
const TOKEN_STATE: usize = 108;
/// Top-level instructions run at stack height 1.
const TOP_LEVEL: usize = 1;
pub const MAX_OPERATORS: usize = 4;

pub const STATUS_RAISING: u8 = 0;
pub const STATUS_LAUNCHED: u8 = 1;
pub const STATUS_FAILED: u8 = 2;

#[program]
pub mod bundle_vault {
    use super::*;

    /// Once, by the program's upgrade authority.
    pub fn init_platform(ctx: Context<InitPlatform>, args: PlatformArgs) -> Result<()> {
        let bump = ctx.bumps.platform;
        let router = ctx.accounts.router.key();
        let a = &ctx.accounts;
        let checked = (a.treasury.to_account_info(), a.router_sol.to_account_info(), a.curve_config.to_account_info());
        apply_platform(&mut ctx.accounts.platform, &args, &checked, &router)?;
        ctx.accounts.platform.bump = bump;
        Ok(())
    }

    pub fn set_platform(ctx: Context<SetPlatform>, args: PlatformArgs) -> Result<()> {
        let router = ctx.accounts.router.key();
        let a = &ctx.accounts;
        let checked = (a.treasury.to_account_info(), a.router_sol.to_account_info(), a.curve_config.to_account_info());
        apply_platform(&mut ctx.accounts.platform, &args, &checked, &router)
    }

    /// Opens a raise. The launcher pays; repo.ing's admin co-signs (it checked the repository).
    pub fn create_bundle(ctx: Context<CreateBundle>, args: CreateBundleArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(args.target >= MIN_TARGET && args.target <= MAX_TARGET, BundleError::BadRaise);
        require!(args.min_deposit >= MIN_DEPOSIT_FLOOR && args.min_deposit <= args.target, BundleError::BadRaise);
        require!(args.deadline > now && args.deadline <= now + MAX_RAISE_SECS, BundleError::BadRaise);
        validate_policy(&args.policy)?;
        require!(tighter_or_equal(&args.policy, &ctx.accounts.platform.limits), BundleError::PolicyTooLoose);
        let key = ctx.accounts.bundle.key();
        let bundle = &mut ctx.accounts.bundle;
        bundle.id = args.id;
        bundle.repo_id = args.repo_id;
        bundle.creator = ctx.accounts.creator.key();
        bundle.status = STATUS_RAISING;
        bundle.bump = ctx.bumps.bundle;
        bundle.vault_bump = Pubkey::find_program_address(&[VAULT_SEED, key.as_ref()], &crate::ID).1;
        bundle.target = args.target;
        bundle.min_deposit = args.min_deposit;
        bundle.deadline = args.deadline;
        bundle.policy = args.policy;
        // The terms backers sign up for: later platform changes do not touch this bundle.
        let platform = &ctx.accounts.platform;
        bundle.curve_config = platform.curve_config;
        bundle.damm_config = platform.damm_config;
        bundle.backer_bps = platform.backer_bps;
        bundle.ops_bps = platform.ops_bps;
        bundle.launch_cooldown_secs = platform.launch_cooldown_secs;
        bundle.launch_grace_secs = platform.launch_grace_secs;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, lamports: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let bundle = &ctx.accounts.bundle;
        require!(bundle.status == STATUS_RAISING, BundleError::NotRaising);
        require!(now <= bundle.deadline, BundleError::RaiseClosed);
        let raised = bundle.raised.checked_add(lamports).ok_or(BundleError::MathOverflow)?;
        require!(lamports > 0 && raised <= bundle.target, BundleError::OverTarget);
        // The last deposit may be smaller than the minimum, so that a raise can always be filled exactly.
        require!(lamports >= bundle.min_deposit || raised == bundle.target, BundleError::BelowMinimum);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer { from: ctx.accounts.wallet.to_account_info(), to: ctx.accounts.bundle.to_account_info() },
            ),
            lamports,
        )?;
        let bundle_key = ctx.accounts.bundle.key();
        let backer = &mut ctx.accounts.backer;
        if backer.wallet == Pubkey::default() {
            backer.bundle = bundle_key;
            backer.wallet = ctx.accounts.wallet.key();
            backer.bump = ctx.bumps.backer;
        }
        backer.shares = backer.shares.checked_add(lamports).ok_or(BundleError::MathOverflow)?;
        ctx.accounts.bundle.raised = raised;
        Ok(())
    }

    /// The admin stops a raise (for example, the maintainer opted out). Backers then take their SOL back.
    pub fn cancel_bundle(ctx: Context<AdminBundle>) -> Result<()> {
        let bundle = &mut ctx.accounts.bundle;
        require!(bundle.status == STATUS_RAISING && bundle.released == 0, BundleError::NotRaising);
        bundle.status = STATUS_FAILED;
        Ok(())
    }

    /// Anyone: a raise below its target after the deadline, or a full raise not launched within the grace period, fails.
    pub fn fail_raise(ctx: Context<FailRaise>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let bundle = &mut ctx.accounts.bundle;
        let grace = bundle.launch_grace_secs as i64;
        require!(bundle.status == STATUS_RAISING && bundle.released == 0, BundleError::NotRaising);
        let missed = now > bundle.deadline && bundle.raised < bundle.target;
        let stale = now > bundle.deadline.checked_add(grace).ok_or(BundleError::MathOverflow)?;
        require!(missed || stale, BundleError::RaiseOpen);
        bundle.status = STATUS_FAILED;
        Ok(())
    }

    /// A backer of a failed raise takes back its deposit; its backer account closes (rent back to it).
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        require!(ctx.accounts.bundle.status == STATUS_FAILED, BundleError::NotFailed);
        let shares = ctx.accounts.backer.shares;
        move_lamports(&ctx.accounts.bundle.to_account_info(), &ctx.accounts.wallet.to_account_info(), shares)?;
        let bundle = &mut ctx.accounts.bundle;
        bundle.refunded = bundle.refunded.checked_add(shares).ok_or(BundleError::MathOverflow)?;
        Ok(())
    }

    /// Launch, step 1 of 2 (see the module comment). Only with this bundle's `settle` later in the same transaction.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let bundle = &ctx.accounts.bundle;
        require!(bundle.status == STATUS_RAISING && bundle.released == 0, BundleError::NotRaising);
        require!(bundle.raised == bundle.target, BundleError::RaiseNotFull);
        let last = bundle.deadline.checked_add(bundle.launch_grace_secs as i64).ok_or(BundleError::MathOverflow)?;
        require!(now <= last, BundleError::RaiseClosed);
        require!(get_stack_height() == TOP_LEVEL, BundleError::NotTopLevel);
        require!(settles_later(&ctx.accounts.instructions, &ctx.accounts.bundle.key())?, BundleError::NoSettle);
        let raised = bundle.raised;
        let ops = (raised as u128 * bundle.ops_bps as u128 / BPS as u128) as u64;
        let buy = raised.checked_sub(ops).ok_or(BundleError::MathOverflow)?;
        let from = ctx.accounts.bundle.to_account_info();
        move_lamports(&from, &ctx.accounts.ops_wallet.to_account_info(), ops)?;
        move_lamports(&from, &ctx.accounts.launch_signer.to_account_info(), buy)?;
        let bundle = &mut ctx.accounts.bundle;
        bundle.released = buy;
        bundle.ops_paid = ops;
        Ok(())
    }

    /// Launch, step 2 of 2. The new pool is on the bundle's config; the released SOL went into it (its reserve holds at
    /// least LAUNCH_SPEND_BPS of it); every token outside the curve is in the vault, at least `min_tokens`.
    pub fn settle(ctx: Context<Settle>, min_tokens: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let released = ctx.accounts.bundle.released;
        require!(ctx.accounts.bundle.status == STATUS_RAISING && released > 0, BundleError::NotReleased);
        // The pool was created in this transaction: its partner fees so far are the launch buy's, which the backers' own SOL
        // paid, so they are the vault's to get back (not backer income).
        let (config, mint, base_vault, quote_reserve, launch_fee) = {
            let data = meteora_account(&ctx.accounts.pool, &DBC, &DBC_POOL_DISC)?;
            (read_key(&data, DBC_POOL_CONFIG)?, read_key(&data, DBC_POOL_BASE_MINT)?, read_key(&data, DBC_POOL_BASE_VAULT)?,
                read_u64(&data, DBC_POOL_QUOTE_RESERVE)?, read_u64(&data, DBC_POOL_PARTNER_QUOTE_FEE)?)
        };
        require_keys_eq!(config, ctx.accounts.bundle.curve_config, BundleError::BadPool);
        require!(ctx.accounts.mint.key() == mint && ctx.accounts.base_vault.key() == base_vault, BundleError::BadPool);
        require!(quote_reserve as u128 * BPS as u128 >= released as u128 * LAUNCH_SPEND_BPS as u128, BundleError::NotSpent);
        // A new pool: the only partner fees in it are the launch buy's.
        require!(launch_fee as u128 * BPS as u128 <= released as u128 * MAX_LAUNCH_PARTNER_FEE_BPS as u128, BundleError::BadPool);
        let vault_key = ctx.accounts.vault.key();
        let ata = Pubkey::find_program_address(&[vault_key.as_ref(), SPL_TOKEN.as_ref(), mint.as_ref()], &ATA_PROGRAM).0;
        require_keys_eq!(ctx.accounts.vault_tokens.key(), ata, BundleError::BadVaultAccount);
        let tokens = token_account(&ctx.accounts.vault_tokens)?;
        require!(tokens.owner == ctx.accounts.vault.key() && tokens.mint == mint, BundleError::BadVaultAccount);
        require!(tokens.amount > 0 && tokens.amount >= min_tokens, BundleError::TooFewTokens);
        let supply = {
            require_keys_eq!(*ctx.accounts.mint.owner, SPL_TOKEN, BundleError::BadPool);
            read_u64(&ctx.accounts.mint.try_borrow_data()?, MINT_SUPPLY)?
        };
        let curve_left = token_account(&ctx.accounts.base_vault)?.amount;
        require!(supply.checked_sub(curve_left) == Some(tokens.amount), BundleError::TokensElsewhere);
        let cooldown = ctx.accounts.bundle.launch_cooldown_secs as i64;
        let bundle = &mut ctx.accounts.bundle;
        bundle.status = STATUS_LAUNCHED;
        bundle.mint = mint;
        bundle.pool = ctx.accounts.pool.key();
        bundle.vault_tokens = ctx.accounts.vault_tokens.key();
        bundle.launched_at = now;
        bundle.trading_opens_at = now.checked_add(cooldown).ok_or(BundleError::MathOverflow)?;
        bundle.cost_lamports = bundle.released;
        bundle.cost_tokens = tokens.amount;
        bundle.vault_volume = bundle.released;
        bundle.vault_fee_generated = launch_fee;
        bundle.vault_fee_owed = launch_fee;
        Ok(())
    }

    /// Anyone, once after the launch: creates the vault's wrapped SOL account and the backers' fee account.
    pub fn open_vault(ctx: Context<OpenVault>) -> Result<()> {
        require!(ctx.accounts.bundle.status == STATUS_LAUNCHED, BundleError::NotLaunched);
        require!(ctx.accounts.bundle.vault_sol == Pubkey::default(), BundleError::AlreadyOpen);
        let a = &ctx.accounts;
        for (ata, owner) in [(&a.vault_sol, a.vault.to_account_info()), (&a.pot, a.bundle.to_account_info())] {
            invoke(
                &Instruction {
                    program_id: ATA_PROGRAM,
                    accounts: vec![
                        AccountMeta::new(a.payer.key(), true),
                        AccountMeta::new(ata.key(), false),
                        AccountMeta::new_readonly(owner.key(), false),
                        AccountMeta::new_readonly(WSOL, false),
                        AccountMeta::new_readonly(system_program::ID, false),
                        AccountMeta::new_readonly(SPL_TOKEN, false),
                    ],
                    data: vec![1], // CreateIdempotent: the program derives and checks the address
                },
                &[
                    a.payer.to_account_info(),
                    ata.to_account_info(),
                    owner,
                    a.wsol_mint.to_account_info(),
                    a.system_program.to_account_info(),
                    a.token_program.to_account_info(),
                ],
            )?;
        }
        let vault_sol = token_account(&a.vault_sol)?;
        let pot = token_account(&a.pot)?;
        require!(vault_sol.owner == a.vault.key() && vault_sol.mint == WSOL, BundleError::BadVaultAccount);
        require!(pot.owner == a.bundle.key() && pot.mint == WSOL, BundleError::BadVaultAccount);
        let (vault_sol_key, pot_key) = (a.vault_sol.key(), a.pot.key());
        let bundle = &mut ctx.accounts.bundle;
        bundle.vault_sol = vault_sol_key;
        bundle.pot = pot_key;
        Ok(())
    }

    /// An operator trades the vault on its curve (before graduation).
    pub fn vault_swap_curve(ctx: Context<VaultSwapCurve>, buy: bool, amount_in: u64, minimum_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        require!(!a.bundle.graduated, BundleError::Graduated);
        let (sol0, tokens0) = (token_account(&a.vault_sol)?.amount, token_account(&a.vault_tokens)?.amount);
        let fee0 = read_u64(&meteora_account(&a.pool, &DBC, &DBC_POOL_DISC)?, DBC_POOL_PARTNER_QUOTE_FEE)?;
        trades_alone(&a.instructions)?;
        let operator = a.operator.key();
        check_trade(&ctx.accounts.platform, &mut ctx.accounts.bundle, &operator, now, buy, amount_in, sol0, tokens0)?;
        let a = &ctx.accounts;
        let (input, output) = if buy { (&a.vault_sol, &a.vault_tokens) } else { (&a.vault_tokens, &a.vault_sol) };
        let bundle_key = a.bundle.key();
        let vault_bump = [a.bundle.vault_bump];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, bundle_key.as_ref(), &vault_bump];
        invoke_signed(
            &Instruction {
                program_id: DBC,
                accounts: vec![
                    AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
                    AccountMeta::new_readonly(a.config.key(), false),
                    AccountMeta::new(a.pool.key(), false),
                    AccountMeta::new(input.key(), false),
                    AccountMeta::new(output.key(), false),
                    AccountMeta::new(a.base_vault.key(), false),
                    AccountMeta::new(a.quote_vault.key(), false),
                    AccountMeta::new_readonly(a.base_mint.key(), false),
                    AccountMeta::new_readonly(a.quote_mint.key(), false),
                    AccountMeta::new_readonly(a.vault.key(), true),
                    AccountMeta::new_readonly(SPL_TOKEN, false),
                    AccountMeta::new_readonly(SPL_TOKEN, false),
                    AccountMeta::new_readonly(DBC, false), // no referral account
                    AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
                    AccountMeta::new_readonly(DBC, false),
                ],
                data: swap_data(DBC_SWAP, amount_in, minimum_out),
            },
            &[
                a.pool_authority.to_account_info(),
                a.config.to_account_info(),
                a.pool.to_account_info(),
                input.to_account_info(),
                output.to_account_info(),
                a.base_vault.to_account_info(),
                a.quote_vault.to_account_info(),
                a.base_mint.to_account_info(),
                a.quote_mint.to_account_info(),
                a.vault.to_account_info(),
                a.token_program.to_account_info(),
                a.event_authority.to_account_info(),
                a.dbc_program.to_account_info(),
            ],
            &[vault_seeds],
        )?;
        let (sol1, tokens1) = (token_account(&a.vault_sol)?.amount, token_account(&a.vault_tokens)?.amount);
        let fee1 = read_u64(&meteora_account(&a.pool, &DBC, &DBC_POOL_DISC)?, DBC_POOL_PARTNER_QUOTE_FEE)?;
        record_trade(&mut ctx.accounts.bundle, now, buy, (sol0, tokens0), (sol1, tokens1), fee1.saturating_sub(fee0))
    }

    /// The admin, once the curve has migrated: binds the bundle to its DAMM v2 pool and the router's partner LP position there
    /// (the one the migration created, permanently locked). Admin only: anyone can create another position owned by the
    /// router, and even lock one and hand its NFT to the router, so the program cannot tell the migration's apart alone.
    pub fn record_graduation(ctx: Context<RecordGraduation>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.bundle.status == STATUS_LAUNCHED && !a.bundle.graduated, BundleError::NotLaunched);
        {
            let curve = meteora_account(&a.pool, &DBC, &DBC_POOL_DISC)?;
            require!(curve.get(DBC_POOL_IS_MIGRATED).copied() == Some(1), BundleError::NotMigrated);
        }
        let mint = a.bundle.mint;
        {
            let pool = meteora_account(&a.damm_pool, &DAMM, &DAMM_POOL_DISC)?;
            require!(read_key(&pool, DAMM_POOL_TOKEN_A_MINT)? == mint && read_key(&pool, DAMM_POOL_TOKEN_B_MINT)? == WSOL, BundleError::BadPool);
            // Fees in SOL only, so the router's SOL account receives all of them and the vault's share is measurable.
            require!(pool.get(DAMM_POOL_COLLECT_FEE_MODE).copied() == Some(1), BundleError::BadPool);
        }
        let (high, low) = if mint.to_bytes() > WSOL.to_bytes() { (mint, WSOL) } else { (WSOL, mint) };
        let expected = Pubkey::find_program_address(&[b"pool", a.bundle.damm_config.as_ref(), high.as_ref(), low.as_ref()], &DAMM).0;
        require_keys_eq!(a.damm_pool.key(), expected, BundleError::BadPool);
        let nft_mint = {
            let position = meteora_account(&a.router_position, &DAMM, &DAMM_POSITION_DISC)?;
            require!(read_key(&position, DAMM_POSITION_POOL)? == a.damm_pool.key(), BundleError::BadPosition);
            require!(read_u128(&position, DAMM_POSITION_PERMANENT_LOCKED)? > 0, BundleError::BadPosition);
            read_key(&position, DAMM_POSITION_NFT_MINT)?
        };
        let nft_account = Pubkey::find_program_address(&[b"position_nft_account", nft_mint.as_ref()], &DAMM).0;
        require_keys_eq!(a.router_position_nft.key(), nft_account, BundleError::BadPosition);
        let nft_program = *a.router_position_nft.owner;
        require!(nft_program == SPL_TOKEN || nft_program == TOKEN_2022, BundleError::BadPosition);
        let nft = token_account_any(&a.router_position_nft)?;
        require!(nft.owner == a.router.key() && nft.mint == nft_mint && nft.amount == 1, BundleError::BadPosition);
        let (damm_pool, position, position_nft) = (a.damm_pool.key(), a.router_position.key(), a.router_position_nft.key());
        let bundle = &mut ctx.accounts.bundle;
        bundle.graduated = true;
        bundle.damm_pool = damm_pool;
        bundle.router_position = position;
        bundle.router_position_nft = position_nft;
        Ok(())
    }

    /// An operator trades the vault on its DAMM v2 pool (after graduation).
    pub fn vault_swap_pool(ctx: Context<VaultSwapPool>, buy: bool, amount_in: u64, minimum_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        require!(a.bundle.graduated, BundleError::NotGraduated);
        let (sol0, tokens0) = (token_account(&a.vault_sol)?.amount, token_account(&a.vault_tokens)?.amount);
        let growth0 = read_u256(&meteora_account(&a.damm_pool, &DAMM, &DAMM_POOL_DISC)?, DAMM_POOL_FEE_B_PER_LIQUIDITY)?;
        let liquidity = position_liquidity(&a.router_position)?;
        trades_alone(&a.instructions)?;
        let operator = a.operator.key();
        check_trade(&ctx.accounts.platform, &mut ctx.accounts.bundle, &operator, now, buy, amount_in, sol0, tokens0)?;
        let a = &ctx.accounts;
        let (input, output) = if buy { (&a.vault_sol, &a.vault_tokens) } else { (&a.vault_tokens, &a.vault_sol) };
        let bundle_key = a.bundle.key();
        let vault_bump = [a.bundle.vault_bump];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, bundle_key.as_ref(), &vault_bump];
        invoke_signed(
            &Instruction {
                program_id: DAMM,
                accounts: vec![
                    AccountMeta::new_readonly(DAMM_POOL_AUTHORITY, false),
                    AccountMeta::new(a.damm_pool.key(), false),
                    AccountMeta::new(input.key(), false),
                    AccountMeta::new(output.key(), false),
                    AccountMeta::new(a.token_a_vault.key(), false),
                    AccountMeta::new(a.token_b_vault.key(), false),
                    AccountMeta::new_readonly(a.token_a_mint.key(), false),
                    AccountMeta::new_readonly(a.token_b_mint.key(), false),
                    AccountMeta::new_readonly(a.vault.key(), true),
                    AccountMeta::new_readonly(SPL_TOKEN, false),
                    AccountMeta::new_readonly(SPL_TOKEN, false),
                    AccountMeta::new_readonly(DAMM, false), // no referral account
                    AccountMeta::new_readonly(DAMM_EVENT_AUTHORITY, false),
                    AccountMeta::new_readonly(DAMM, false),
                ],
                data: swap_data(DAMM_SWAP, amount_in, minimum_out),
            },
            &[
                a.pool_authority.to_account_info(),
                a.damm_pool.to_account_info(),
                input.to_account_info(),
                output.to_account_info(),
                a.token_a_vault.to_account_info(),
                a.token_b_vault.to_account_info(),
                a.token_a_mint.to_account_info(),
                a.token_b_mint.to_account_info(),
                a.vault.to_account_info(),
                a.token_program.to_account_info(),
                a.event_authority.to_account_info(),
                a.damm_program.to_account_info(),
            ],
            &[vault_seeds],
        )?;
        let (sol1, tokens1) = (token_account(&a.vault_sol)?.amount, token_account(&a.vault_tokens)?.amount);
        let growth1 = read_u256(&meteora_account(&a.damm_pool, &DAMM, &DAMM_POOL_DISC)?, DAMM_POOL_FEE_B_PER_LIQUIDITY)?;
        let generated = position_fee(growth0, growth1, liquidity)?;
        record_trade(&mut ctx.accounts.bundle, now, buy, (sol0, tokens0), (sol1, tokens1), generated)
    }

    /// Anyone: the router claims the curve's partner fees and routes them (vault rebate, backers, treasury).
    pub fn route_curve_fees(ctx: Context<RouteCurveFees>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.bundle.status == STATUS_LAUNCHED && a.bundle.vault_sol != Pubkey::default(), BundleError::VaultNotOpen);
        let router_tokens = token_account(&a.router_tokens)?;
        require!(router_tokens.owner == a.router.key() && router_tokens.mint == a.bundle.mint, BundleError::BadRouterAccount);
        let before = token_account(&a.router_sol)?.amount;
        let router_bump = [ctx.bumps.router];
        let router_seeds: &[&[u8]] = &[ROUTER_SEED, &router_bump];
        let mut data = DBC_CLAIM_TRADING_FEE.to_vec();
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        invoke_signed(
            &Instruction {
                program_id: DBC,
                accounts: vec![
                    AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
                    AccountMeta::new_readonly(a.config.key(), false),
                    AccountMeta::new(a.pool.key(), false),
                    AccountMeta::new(a.router_tokens.key(), false),
                    AccountMeta::new(a.router_sol.key(), false),
                    AccountMeta::new(a.base_vault.key(), false),
                    AccountMeta::new(a.quote_vault.key(), false),
                    AccountMeta::new_readonly(a.base_mint.key(), false),
                    AccountMeta::new_readonly(a.quote_mint.key(), false),
                    AccountMeta::new_readonly(a.router.key(), true),
                    AccountMeta::new_readonly(SPL_TOKEN, false),
                    AccountMeta::new_readonly(SPL_TOKEN, false),
                    AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
                    AccountMeta::new_readonly(DBC, false),
                ],
                data,
            },
            &[
                a.pool_authority.to_account_info(),
                a.config.to_account_info(),
                a.pool.to_account_info(),
                a.router_tokens.to_account_info(),
                a.router_sol.to_account_info(),
                a.base_vault.to_account_info(),
                a.quote_vault.to_account_info(),
                a.base_mint.to_account_info(),
                a.quote_mint.to_account_info(),
                a.router.to_account_info(),
                a.token_program.to_account_info(),
                a.event_authority.to_account_info(),
                a.dbc_program.to_account_info(),
            ],
            &[router_seeds],
        )?;
        let claimed = token_account(&a.router_sol)?.amount.checked_sub(before).ok_or(BundleError::MathOverflow)?;
        require!(claimed > 0, BundleError::NothingToClaim);
        let accounts = RouteAccounts {
            router: a.router.to_account_info(),
            router_sol: a.router_sol.to_account_info(),
            vault_sol: a.vault_sol.to_account_info(),
            pot: a.pot.to_account_info(),
            treasury: a.treasury.to_account_info(),
            token_program: a.token_program.to_account_info(),
        };
        let backer_bps = a.bundle.backer_bps;
        route(&mut ctx.accounts.bundle, backer_bps, claimed, &accounts, router_seeds)
    }

    /// Anyone, after graduation: the router claims its DAMM v2 position's fees and routes them like curve fees.
    pub fn route_pool_fees(ctx: Context<RoutePoolFees>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.bundle.graduated && a.bundle.vault_sol != Pubkey::default(), BundleError::NotGraduated);
        let router_tokens = token_account(&a.router_tokens)?;
        require!(router_tokens.owner == a.router.key() && router_tokens.mint == a.bundle.mint, BundleError::BadRouterAccount);
        let before = token_account(&a.router_sol)?.amount;
        let router_bump = [ctx.bumps.router];
        let router_seeds: &[&[u8]] = &[ROUTER_SEED, &router_bump];
        invoke_signed(
            &Instruction {
                program_id: DAMM,
                accounts: vec![
                    AccountMeta::new_readonly(DAMM_POOL_AUTHORITY, false),
                    AccountMeta::new_readonly(a.damm_pool.key(), false),
                    AccountMeta::new(a.router_position.key(), false),
                    AccountMeta::new(a.router_tokens.key(), false),
                    AccountMeta::new(a.router_sol.key(), false),
                    AccountMeta::new(a.token_a_vault.key(), false),
                    AccountMeta::new(a.token_b_vault.key(), false),
                    AccountMeta::new_readonly(a.token_a_mint.key(), false),
                    AccountMeta::new_readonly(a.token_b_mint.key(), false),
                    AccountMeta::new_readonly(a.router_position_nft.key(), false),
                    AccountMeta::new_readonly(a.router.key(), true),
                    AccountMeta::new_readonly(SPL_TOKEN, false),
                    AccountMeta::new_readonly(SPL_TOKEN, false),
                    AccountMeta::new_readonly(DAMM_EVENT_AUTHORITY, false),
                    AccountMeta::new_readonly(DAMM, false),
                ],
                data: DAMM_CLAIM_POSITION_FEE.to_vec(),
            },
            &[
                a.pool_authority.to_account_info(),
                a.damm_pool.to_account_info(),
                a.router_position.to_account_info(),
                a.router_tokens.to_account_info(),
                a.router_sol.to_account_info(),
                a.token_a_vault.to_account_info(),
                a.token_b_vault.to_account_info(),
                a.token_a_mint.to_account_info(),
                a.token_b_mint.to_account_info(),
                a.router_position_nft.to_account_info(),
                a.router.to_account_info(),
                a.token_program.to_account_info(),
                a.event_authority.to_account_info(),
                a.damm_program.to_account_info(),
            ],
            &[router_seeds],
        )?;
        let claimed = token_account(&a.router_sol)?.amount.checked_sub(before).ok_or(BundleError::MathOverflow)?;
        require!(claimed > 0, BundleError::NothingToClaim);
        let accounts = RouteAccounts {
            router: a.router.to_account_info(),
            router_sol: a.router_sol.to_account_info(),
            vault_sol: a.vault_sol.to_account_info(),
            pot: a.pot.to_account_info(),
            treasury: a.treasury.to_account_info(),
            token_program: a.token_program.to_account_info(),
        };
        let backer_bps = a.bundle.backer_bps;
        route(&mut ctx.accounts.bundle, backer_bps, claimed, &accounts, router_seeds)
    }

    /// A backer takes its share of the routed fees (wrapped SOL into `destination`).
    pub fn claim_backer_fees(ctx: Context<ClaimBackerFees>) -> Result<()> {
        let destination = token_account(&ctx.accounts.destination)?;
        require!(destination.mint == WSOL, BundleError::BadDestination);
        let owed = pending(&ctx.accounts.bundle, &ctx.accounts.backer)?;
        require!(owed > 0, BundleError::NothingToClaim);
        let bundle = &ctx.accounts.bundle;
        let id = bundle.id.to_le_bytes();
        let bump = [bundle.bump];
        let bundle_seeds: &[&[u8]] = &[BUNDLE_SEED, id.as_ref(), &bump];
        token_transfer(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.pot.to_account_info(),
            &ctx.accounts.destination.to_account_info(),
            &ctx.accounts.bundle.to_account_info(),
            owed,
            bundle_seeds,
        )?;
        let backer = &mut ctx.accounts.backer;
        backer.paid = backer.paid.checked_add(owed).ok_or(BundleError::MathOverflow)?;
        let bundle = &mut ctx.accounts.bundle;
        bundle.backer_paid = bundle.backer_paid.checked_add(owed).ok_or(BundleError::MathOverflow)?;
        Ok(())
    }

    /// The admin can only tighten a bundle's policy (never loosen it).
    pub fn set_policy(ctx: Context<AdminBundle>, policy: Policy) -> Result<()> {
        validate_policy(&policy)?;
        let bundle = &mut ctx.accounts.bundle;
        require!(tighter_or_equal(&policy, &bundle.policy), BundleError::PolicyTooLoose);
        bundle.policy = policy;
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminBundle>, paused: bool) -> Result<()> {
        ctx.accounts.bundle.paused = paused;
        Ok(())
    }
}

// ------------------------------------------------------------------ rules

/// `accounts`: the treasury's and the router's wrapped SOL accounts, and the bundle config.
fn apply_platform(platform: &mut Platform, args: &PlatformArgs, accounts: &(AccountInfo, AccountInfo, AccountInfo), router: &Pubkey) -> Result<()> {
    let (treasury, router_sol, curve_config) = accounts;
    for key in [args.admin, args.launch_signer, args.ops_wallet, args.damm_config] {
        require!(key != Pubkey::default(), BundleError::BadKey);
    }
    require!(args.operators.iter().any(|key| *key != Pubkey::default()), BundleError::BadKey);
    require!(args.backer_bps as u64 <= BPS && args.ops_bps <= MAX_OPS_BPS, BundleError::BadSettings);
    require!(args.launch_cooldown_secs >= MIN_LAUNCH_COOLDOWN_SECS && args.launch_grace_secs >= MIN_LAUNCH_GRACE_SECS, BundleError::BadSettings);
    validate_policy(&args.limits)?;
    let treasury_account = token_account(treasury)?;
    require!(treasury_account.mint == WSOL, BundleError::BadSettings);
    let router_account = token_account(router_sol)?;
    require!(router_account.mint == WSOL && router_account.owner == *router, BundleError::BadSettings);
    // The bundle config: its fees go to the router, in SOL only, on SPL Token mints with a SOL quote.
    {
        let config = meteora_account(curve_config, &DBC, &DBC_CONFIG_DISC).map_err(|_| BundleError::BadSettings)?;
        require!(
            read_key(&config, DBC_CONFIG_FEE_CLAIMER)? == *router
                && read_key(&config, DBC_CONFIG_QUOTE_MINT)? == WSOL
                && config.get(DBC_CONFIG_COLLECT_FEE_MODE).copied() == Some(0)
                && config.get(DBC_CONFIG_TOKEN_TYPE).copied() == Some(0),
            BundleError::BadSettings
        );
    }
    platform.admin = args.admin;
    platform.launch_signer = args.launch_signer;
    platform.operators = args.operators;
    platform.ops_wallet = args.ops_wallet;
    platform.treasury = treasury.key();
    platform.router_sol = router_sol.key();
    platform.curve_config = curve_config.key();
    platform.damm_config = args.damm_config;
    platform.backer_bps = args.backer_bps;
    platform.ops_bps = args.ops_bps;
    platform.launch_cooldown_secs = args.launch_cooldown_secs;
    platform.launch_grace_secs = args.launch_grace_secs;
    platform.limits = args.limits;
    Ok(())
}

fn validate_policy(policy: &Policy) -> Result<()> {
    let fraction = |bps: u16| bps as u64 <= BPS;
    require!(
        fraction(policy.max_trade_bps) && fraction(policy.max_daily_buy_bps) && fraction(policy.max_daily_sell_bps)
            && policy.floor_bps <= MAX_FLOOR_BPS,
        BundleError::BadPolicy
    );
    Ok(())
}

/// `a` allows nothing that `b` refuses.
fn tighter_or_equal(a: &Policy, b: &Policy) -> bool {
    a.max_trade_bps <= b.max_trade_bps
        && a.max_daily_buy_bps <= b.max_daily_buy_bps
        && a.max_daily_sell_bps <= b.max_daily_sell_bps
        && a.floor_bps >= b.floor_bps
        && a.gap_secs >= b.gap_secs
}

fn bps_of(amount: u64, bps: u16) -> u64 {
    (amount as u128 * bps as u128 / BPS as u128) as u64
}

/// Every check before a vault trade (it also starts a new UTC day's counters).
// The trade's inputs are separate values the two swap handlers already hold; a struct would only rename them.
#[allow(clippy::too_many_arguments)]
fn check_trade(
    platform: &Platform,
    bundle: &mut Bundle,
    operator: &Pubkey,
    now: i64,
    buy: bool,
    amount_in: u64,
    sol: u64,
    tokens: u64,
) -> Result<()> {
    require!(*operator != Pubkey::default() && platform.operators.contains(operator), BundleError::NotOperator);
    require!(bundle.status == STATUS_LAUNCHED, BundleError::NotLaunched);
    require!(!bundle.paused, BundleError::Paused);
    require!(now >= bundle.trading_opens_at, BundleError::LaunchCooldown);
    require!(bundle.vault_sol != Pubkey::default(), BundleError::VaultNotOpen);
    require!(amount_in > 0, BundleError::TradeTooLarge);
    let day = now.div_euclid(DAY);
    if day != bundle.day {
        bundle.day = day;
        bundle.day_bought = 0;
        bundle.day_sold = 0;
    }
    let policy = bundle.policy;
    let gap = policy.gap_secs as i64;
    if buy {
        require!(bundle.last_sell_at == 0 || now >= bundle.last_sell_at.saturating_add(gap), BundleError::TooSoon);
        require!(amount_in <= bps_of(sol, policy.max_trade_bps), BundleError::TradeTooLarge);
        // The day's buys against the SOL the vault had before them (today's sells and rebates included).
        let total = bundle.day_bought.checked_add(amount_in).ok_or(BundleError::MathOverflow)?;
        let base = sol.checked_add(bundle.day_bought).ok_or(BundleError::MathOverflow)?;
        require!(total <= bps_of(base, policy.max_daily_buy_bps), BundleError::DailyLimit);
    } else {
        require!(bundle.last_buy_at == 0 || now >= bundle.last_buy_at.saturating_add(gap), BundleError::TooSoon);
        require!(amount_in <= bps_of(tokens, policy.max_trade_bps), BundleError::TradeTooLarge);
        let total = bundle.day_sold.checked_add(amount_in).ok_or(BundleError::MathOverflow)?;
        let base = tokens.checked_add(bundle.day_sold).ok_or(BundleError::MathOverflow)?;
        require!(total <= bps_of(base, policy.max_daily_sell_bps), BundleError::DailyLimit);
    }
    Ok(())
}

/// Books a vault trade from the vault's balances before and after it, and the partner fees it generated.
fn record_trade(bundle: &mut Bundle, now: i64, buy: bool, before: (u64, u64), after: (u64, u64), generated: u64) -> Result<()> {
    let (sol0, tokens0) = before;
    let (sol1, tokens1) = after;
    if buy {
        let spent = sol0.checked_sub(sol1).ok_or(BundleError::MathOverflow)?;
        let got = tokens1.checked_sub(tokens0).ok_or(BundleError::MathOverflow)?;
        require!(spent > 0 && got > 0, BundleError::NoOutput);
        bundle.cost_lamports = bundle.cost_lamports.checked_add(spent).ok_or(BundleError::MathOverflow)?;
        bundle.cost_tokens = bundle.cost_tokens.checked_add(got).ok_or(BundleError::MathOverflow)?;
        bundle.day_bought = bundle.day_bought.checked_add(spent).ok_or(BundleError::MathOverflow)?;
        bundle.last_buy_at = now;
        bundle.vault_volume = bundle.vault_volume.checked_add(spent).ok_or(BundleError::MathOverflow)?;
    } else {
        let sold = tokens0.checked_sub(tokens1).ok_or(BundleError::MathOverflow)?;
        let received = sol1.checked_sub(sol0).ok_or(BundleError::MathOverflow)?;
        require!(sold > 0 && received > 0 && bundle.cost_tokens > 0, BundleError::NoOutput);
        // received / sold ≥ floor_bps / BPS × cost_lamports / cost_tokens
        let left = received as u128 * bundle.cost_tokens as u128 * BPS as u128;
        let right = sold as u128 * bundle.cost_lamports as u128 * bundle.policy.floor_bps as u128;
        require!(left >= right, BundleError::BelowFloor);
        let part = sold.min(bundle.cost_tokens);
        let basis = (bundle.cost_lamports as u128 * part as u128 / bundle.cost_tokens as u128) as u64;
        bundle.cost_lamports -= basis;
        bundle.cost_tokens -= part;
        bundle.day_sold = bundle.day_sold.checked_add(sold).ok_or(BundleError::MathOverflow)?;
        bundle.last_sell_at = now;
        bundle.vault_volume = bundle.vault_volume.checked_add(received).ok_or(BundleError::MathOverflow)?;
    }
    bundle.vault_fee_owed = bundle.vault_fee_owed.checked_add(generated).ok_or(BundleError::MathOverflow)?;
    bundle.vault_fee_generated = bundle.vault_fee_generated.checked_add(generated).ok_or(BundleError::MathOverflow)?;
    Ok(())
}

struct RouteAccounts<'info> {
    router: AccountInfo<'info>,
    router_sol: AccountInfo<'info>,
    vault_sol: AccountInfo<'info>,
    pot: AccountInfo<'info>,
    treasury: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
}

/// Splits one claim: first the vault's own partner fees go back to the vault (never backer income), then `backer_bps`
/// of the rest to the backers' pot and the remainder (rounding included) to the treasury.
fn route<'info>(bundle: &mut Bundle, backer_bps: u16, claimed: u64, accounts: &RouteAccounts<'info>, router_seeds: &[&[u8]]) -> Result<()> {
    let rebate = claimed.min(bundle.vault_fee_owed);
    let rest = claimed - rebate;
    let to_backers = bps_of(rest, backer_bps);
    let to_treasury = rest - to_backers;
    require!(bundle.raised > 0, BundleError::MathOverflow);
    bundle.vault_fee_owed -= rebate;
    bundle.vault_rebated = bundle.vault_rebated.checked_add(rebate).ok_or(BundleError::MathOverflow)?;
    bundle.backer_income = bundle.backer_income.checked_add(to_backers).ok_or(BundleError::MathOverflow)?;
    bundle.treasury_income = bundle.treasury_income.checked_add(to_treasury).ok_or(BundleError::MathOverflow)?;
    bundle.acc_per_share = bundle
        .acc_per_share
        .checked_add(to_backers as u128 * ACC_SCALE / bundle.raised as u128)
        .ok_or(BundleError::MathOverflow)?;
    for (destination, amount) in [(&accounts.vault_sol, rebate), (&accounts.pot, to_backers), (&accounts.treasury, to_treasury)] {
        if amount > 0 {
            token_transfer(&accounts.token_program, &accounts.router_sol, destination, &accounts.router, amount, router_seeds)?;
        }
    }
    Ok(())
}

fn pending(bundle: &Bundle, backer: &Backer) -> Result<u64> {
    let earned = backer.shares as u128 * bundle.acc_per_share / ACC_SCALE;
    let earned = u64::try_from(earned).map_err(|_| BundleError::MathOverflow)?;
    Ok(earned.saturating_sub(backer.paid))
}

/// A vault trade runs at top level, with no other DBC or DAMM v2 instruction in its transaction: nothing can trade around
/// it atomically (a same-transaction sandwich). Trades in other transactions are bounded by the policy only.
fn trades_alone(instructions: &UncheckedAccount) -> Result<()> {
    require!(get_stack_height() == TOP_LEVEL, BundleError::NotTopLevel);
    let sysvar = instructions.to_account_info();
    let current = load_current_index_checked(&sysvar)? as usize;
    let mut index = 0;
    while let Ok(ix) = load_instruction_at_checked(index, &sysvar) {
        require!(index == current || (ix.program_id != DBC && ix.program_id != DAMM), BundleError::NotAlone);
        index += 1;
    }
    Ok(())
}

/// Whether a top-level instruction after the current one is this program's `settle` for `bundle`.
fn settles_later(instructions: &UncheckedAccount, bundle: &Pubkey) -> Result<bool> {
    let sysvar = instructions.to_account_info();
    let current = load_current_index_checked(&sysvar)? as usize;
    let mut index = current + 1;
    while let Ok(ix) = load_instruction_at_checked(index, &sysvar) {
        if ix.program_id == crate::ID
            && ix.data.starts_with(instruction::Settle::DISCRIMINATOR)
            && ix.accounts.get(2).map(|meta| meta.pubkey) == Some(*bundle)
        {
            return Ok(true);
        }
        index += 1;
    }
    Ok(false)
}

// ---------------------------------------------------------------- helpers

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let left = from.lamports().checked_sub(amount).ok_or(BundleError::MathOverflow)?;
    require!(left >= Rent::get()?.minimum_balance(from.data_len()), BundleError::RentFloor);
    **from.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).ok_or(BundleError::MathOverflow)?;
    Ok(())
}

fn token_transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    let mut data = vec![3u8]; // SPL Token Transfer
    data.extend_from_slice(&amount.to_le_bytes());
    invoke_signed(
        &Instruction {
            program_id: SPL_TOKEN,
            accounts: vec![AccountMeta::new(from.key(), false), AccountMeta::new(to.key(), false), AccountMeta::new_readonly(authority.key(), true)],
            data,
        },
        &[from.clone(), to.clone(), authority.clone(), token_program.clone()],
        &[seeds],
    )?;
    Ok(())
}

struct TokenView {
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
}

/// An SPL token account (mint, owner, amount).
fn token_account(info: &AccountInfo) -> Result<TokenView> {
    require_keys_eq!(*info.owner, SPL_TOKEN, BundleError::NotTokenAccount);
    require!(info.data_len() == 165, BundleError::NotTokenAccount);
    token_account_any(info)
}

/// An initialized SPL or Token-2022 token account (the first 165 bytes are the same; Token-2022 adds extensions after).
fn token_account_any(info: &AccountInfo) -> Result<TokenView> {
    require!(*info.owner == SPL_TOKEN || *info.owner == TOKEN_2022, BundleError::NotTokenAccount);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 165 && data[TOKEN_STATE] == 1, BundleError::NotTokenAccount);
    Ok(TokenView {
        mint: Pubkey::try_from(&data[0..32]).unwrap(),
        owner: Pubkey::try_from(&data[32..64]).unwrap(),
        amount: u64::from_le_bytes(data[64..72].try_into().unwrap()),
    })
}

/// The data of a Meteora account of the expected program and type.
fn meteora_account<'a, 'info: 'a>(info: &'a AccountInfo<'info>, program: &Pubkey, discriminator: &[u8; 8]) -> Result<std::cell::Ref<'a, &'a mut [u8]>> {
    require_keys_eq!(*info.owner, *program, BundleError::BadPool);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 8 && data[..8] == discriminator[..], BundleError::BadPool);
    Ok(data)
}

fn read_key(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes = data.get(offset..offset + 32).ok_or(BundleError::BadPool)?;
    Ok(Pubkey::try_from(bytes).unwrap())
}

fn read_u64(data: &[u8], offset: usize) -> Result<u64> {
    let bytes = data.get(offset..offset + 8).ok_or(BundleError::BadPool)?;
    Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
}

fn read_u128(data: &[u8], offset: usize) -> Result<u128> {
    let bytes = data.get(offset..offset + 16).ok_or(BundleError::BadPool)?;
    Ok(u128::from_le_bytes(bytes.try_into().unwrap()))
}

/// A little-endian u256 as (low, high) halves.
fn read_u256(data: &[u8], offset: usize) -> Result<(u128, u128)> {
    Ok((read_u128(data, offset)?, read_u128(data, offset + 16)?))
}

fn position_liquidity(info: &AccountInfo) -> Result<u128> {
    let data = meteora_account(info, &DAMM, &DAMM_POSITION_DISC)?;
    let mut total: u128 = 0;
    for offset in DAMM_POSITION_LIQUIDITY {
        total = total.checked_add(read_u128(&data, offset)?).ok_or(BundleError::MathOverflow)?;
    }
    Ok(total)
}

/// What a position of `liquidity` earned while the pool's fee per liquidity grew from `before` to `after`
/// (DAMM v2: liquidity × Δfee_per_liquidity >> 128, rounded down).
fn position_fee(before: (u128, u128), after: (u128, u128), liquidity: u128) -> Result<u64> {
    let (low, borrow) = after.0.overflowing_sub(before.0);
    let high = after.1.checked_sub(before.1).and_then(|h| h.checked_sub(borrow as u128)).ok_or(BundleError::MathOverflow)?;
    require!(high == 0, BundleError::MathOverflow);
    Ok(u64::try_from(mul_shr_128(low, liquidity)).map_err(|_| BundleError::MathOverflow)?)
}

/// ⌊a × b / 2^128⌋ without overflow.
fn mul_shr_128(a: u128, b: u128) -> u128 {
    const MASK: u128 = u64::MAX as u128;
    let (a0, a1, b0, b1) = (a & MASK, a >> 64, b & MASK, b >> 64);
    let low = a0 * b0;
    let mid1 = a1 * b0;
    let mid2 = a0 * b1;
    let carry = ((low >> 64) + (mid1 & MASK) + (mid2 & MASK)) >> 64;
    a1 * b1 + (mid1 >> 64) + (mid2 >> 64) + carry
}

fn swap_data(discriminator: [u8; 8], amount_in: u64, minimum_out: u64) -> Vec<u8> {
    let mut data = discriminator.to_vec();
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_out.to_le_bytes());
    data
}

// ------------------------------------------------------------------ state

#[account]
#[derive(InitSpace)]
pub struct Platform {
    /// repo.ing's launch co-signer: co-signs new bundles, sets the platform, tightens policies, pauses vaults.
    pub admin: Pubkey,
    /// Receives a full raise at launch (less operations) and makes the first swap.
    pub launch_signer: Pubkey,
    /// The agent keys that may trade vaults (unused slots are the default key).
    pub operators: [Pubkey; 4],
    /// Receives `ops_bps` of each raise at launch.
    pub ops_wallet: Pubkey,
    /// repo.ing's wrapped SOL account for its share of the fees.
    pub treasury: Pubkey,
    /// The router PDA's wrapped SOL account, where fee claims land before they are routed.
    pub router_sol: Pubkey,
    /// The DBC config of bundle markets (its fee claimer is the router PDA).
    pub curve_config: Pubkey,
    /// The DAMM v2 config those markets migrate into.
    pub damm_config: Pubkey,
    pub backer_bps: u16,
    pub ops_bps: u16,
    pub launch_cooldown_secs: u32,
    pub launch_grace_secs: u32,
    /// The loosest policy a bundle may have.
    pub limits: Policy,
    pub bump: u8,
    /// Room for later fields without a reallocation.
    pub reserved: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, InitSpace)]
pub struct Policy {
    /// One trade: at most this share of the vault's SOL (a buy) or tokens (a sell).
    pub max_trade_bps: u16,
    /// One UTC day: SOL spent at most this share of the SOL at the day's first trade.
    pub max_daily_buy_bps: u16,
    /// One UTC day: tokens sold at most this share of the tokens at the day's first trade.
    pub max_daily_sell_bps: u16,
    /// A sell must get at least this share of the vault's average cost (10000 = cost).
    pub floor_bps: u16,
    /// Seconds between a buy and a sell, in either order.
    pub gap_secs: u32,
}

#[account]
#[derive(InitSpace)]
pub struct Bundle {
    pub id: u64,
    /// GitHub numeric repository id.
    pub repo_id: u64,
    /// The launcher who opened the raise.
    pub creator: Pubkey,
    pub status: u8,
    pub graduated: bool,
    pub paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
    pub target: u64,
    pub min_deposit: u64,
    pub deadline: i64,
    /// The platform's terms when the bundle was created (fixed for it).
    pub curve_config: Pubkey,
    pub damm_config: Pubkey,
    pub backer_bps: u16,
    pub ops_bps: u16,
    pub launch_cooldown_secs: u32,
    pub launch_grace_secs: u32,
    /// Lamports deposited: one share each.
    pub raised: u64,
    pub refunded: u64,
    /// At launch: lamports for the first swap and for operations.
    pub released: u64,
    pub ops_paid: u64,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub damm_pool: Pubkey,
    pub router_position: Pubkey,
    pub router_position_nft: Pubkey,
    pub vault_tokens: Pubkey,
    pub vault_sol: Pubkey,
    /// The backers' wrapped SOL (owned by this bundle account).
    pub pot: Pubkey,
    pub launched_at: i64,
    /// No vault trade before this time (the launch fee).
    pub trading_opens_at: i64,
    pub policy: Policy,
    /// The vault's cost basis: lamports paid and tokens held at that cost.
    pub cost_lamports: u64,
    pub cost_tokens: u64,
    /// The UTC day of the last trade, and that day's buys (lamports spent) and sells (tokens sold).
    pub day: i64,
    pub day_bought: u64,
    pub day_sold: u64,
    pub last_buy_at: i64,
    pub last_sell_at: i64,
    /// Lamports the vault traded (spent on buys, received on sells).
    pub vault_volume: u64,
    /// Partner fees the vault's own trades generated: in total, and not yet paid back to it.
    pub vault_fee_generated: u64,
    pub vault_fee_owed: u64,
    pub vault_rebated: u64,
    /// Routed fees: to the backers' pot, paid out of it, and to the treasury.
    pub backer_income: u64,
    pub backer_paid: u64,
    pub treasury_income: u64,
    /// Backer income per share × ACC_SCALE.
    pub acc_per_share: u128,
    /// Room for later fields without a reallocation.
    pub reserved: [u8; 128],
}

#[account]
#[derive(InitSpace)]
pub struct Backer {
    pub bundle: Pubkey,
    pub wallet: Pubkey,
    /// Lamports deposited.
    pub shares: u64,
    /// Fees claimed.
    pub paid: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PlatformArgs {
    pub admin: Pubkey,
    pub launch_signer: Pubkey,
    pub operators: [Pubkey; 4],
    pub ops_wallet: Pubkey,
    pub damm_config: Pubkey,
    pub backer_bps: u16,
    pub ops_bps: u16,
    pub launch_cooldown_secs: u32,
    pub launch_grace_secs: u32,
    pub limits: Policy,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateBundleArgs {
    pub id: u64,
    pub repo_id: u64,
    pub target: u64,
    pub min_deposit: u64,
    pub deadline: i64,
    pub policy: Policy,
}

// --------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitPlatform<'info> {
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(init, payer = upgrade_authority, space = 8 + Platform::INIT_SPACE, seeds = [PLATFORM_SEED], bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ BundleError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::BundleVault>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ BundleError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    /// CHECK: repo.ing's wrapped SOL account (checked in `apply_platform`)
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: the router's wrapped SOL account (checked in `apply_platform`)
    pub router_sol: UncheckedAccount<'info>,
    /// CHECK: the bundle config (checked in `apply_platform`)
    pub curve_config: UncheckedAccount<'info>,
    /// CHECK: the router PDA
    #[account(seeds = [ROUTER_SEED], bump)]
    pub router: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPlatform<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump, has_one = admin @ BundleError::NotAdmin)]
    pub platform: Box<Account<'info, Platform>>,
    /// CHECK: checked in `apply_platform`
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: checked in `apply_platform`
    pub router_sol: UncheckedAccount<'info>,
    /// CHECK: checked in `apply_platform`
    pub curve_config: UncheckedAccount<'info>,
    /// CHECK: the router PDA
    #[account(seeds = [ROUTER_SEED], bump)]
    pub router: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(args: CreateBundleArgs)]
pub struct CreateBundle<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(address = platform.admin @ BundleError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(init, payer = creator, space = 8 + Bundle::INIT_SPACE, seeds = [BUNDLE_SEED, args.id.to_le_bytes().as_ref()], bump)]
    pub bundle: Box<Account<'info, Bundle>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    #[account(init_if_needed, payer = wallet, space = 8 + Backer::INIT_SPACE, seeds = [BACKER_SEED, bundle.key().as_ref(), wallet.key().as_ref()], bump)]
    pub backer: Account<'info, Backer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminBundle<'info> {
    #[account(address = platform.admin @ BundleError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
}

#[derive(Accounts)]
pub struct FailRaise<'info> {
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    #[account(mut, close = wallet, seeds = [BACKER_SEED, bundle.key().as_ref(), wallet.key().as_ref()], bump = backer.bump,
        has_one = wallet @ BundleError::NotBacker, has_one = bundle @ BundleError::NotBacker)]
    pub backer: Account<'info, Backer>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, address = platform.launch_signer @ BundleError::NotLaunchSigner)]
    pub launch_signer: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    /// CHECK: the operations wallet (address checked)
    #[account(mut, address = platform.ops_wallet @ BundleError::BadSettings)]
    pub ops_wallet: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar (address checked)
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(address = platform.launch_signer @ BundleError::NotLaunchSigner)]
    pub launch_signer: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    /// CHECK: the vault PDA
    #[account(seeds = [VAULT_SEED, bundle.key().as_ref()], bump = bundle.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the new DBC pool (owner, type and config checked in `settle`)
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the vault's token account (checked in `settle`)
    pub vault_tokens: UncheckedAccount<'info>,
    /// CHECK: the pool's mint (checked against the pool in `settle`)
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the pool's base vault (checked against the pool in `settle`)
    pub base_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OpenVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    /// CHECK: the vault PDA
    #[account(seeds = [VAULT_SEED, bundle.key().as_ref()], bump = bundle.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: created by the associated token program, which checks the address
    #[account(mut)]
    pub vault_sol: UncheckedAccount<'info>,
    /// CHECK: as above
    #[account(mut)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL
    #[account(address = WSOL)]
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: SPL Token
    #[account(address = SPL_TOKEN)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the associated token program
    #[account(address = ATA_PROGRAM)]
    pub ata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VaultSwapCurve<'info> {
    pub operator: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    /// CHECK: the vault PDA
    #[account(seeds = [VAULT_SEED, bundle.key().as_ref()], bump = bundle.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the bundle's DBC pool
    #[account(mut, address = bundle.pool @ BundleError::BadPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the bundle's config
    #[account(address = bundle.curve_config @ BundleError::BadPool)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: DBC's pool authority
    #[account(address = DBC_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC checks it against the pool
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC checks it against the pool
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the market token
    #[account(address = bundle.mint @ BundleError::BadPool)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL
    #[account(address = WSOL)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the vault's token account
    #[account(mut, address = bundle.vault_tokens @ BundleError::BadVaultAccount)]
    pub vault_tokens: UncheckedAccount<'info>,
    /// CHECK: the vault's wrapped SOL account
    #[account(mut, address = bundle.vault_sol @ BundleError::BadVaultAccount)]
    pub vault_sol: UncheckedAccount<'info>,
    /// CHECK: SPL Token
    #[account(address = SPL_TOKEN)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: DBC's event authority
    #[account(address = DBC_EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC
    #[account(address = DBC)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar (address checked)
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecordGraduation<'info> {
    #[account(address = platform.admin @ BundleError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    /// CHECK: the bundle's DBC pool
    #[account(address = bundle.pool @ BundleError::BadPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: checked in `record_graduation`
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: checked in `record_graduation`
    pub router_position: UncheckedAccount<'info>,
    /// CHECK: checked in `record_graduation`
    pub router_position_nft: UncheckedAccount<'info>,
    /// CHECK: the router PDA
    #[account(seeds = [ROUTER_SEED], bump)]
    pub router: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VaultSwapPool<'info> {
    pub operator: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    /// CHECK: the vault PDA
    #[account(seeds = [VAULT_SEED, bundle.key().as_ref()], bump = bundle.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the bundle's DAMM v2 pool
    #[account(mut, address = bundle.damm_pool @ BundleError::BadPool)]
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's pool authority
    #[account(address = DAMM_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 checks it against the pool
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 checks it against the pool
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: the market token
    #[account(address = bundle.mint @ BundleError::BadPool)]
    pub token_a_mint: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL
    #[account(address = WSOL)]
    pub token_b_mint: UncheckedAccount<'info>,
    /// CHECK: the vault's token account
    #[account(mut, address = bundle.vault_tokens @ BundleError::BadVaultAccount)]
    pub vault_tokens: UncheckedAccount<'info>,
    /// CHECK: the vault's wrapped SOL account
    #[account(mut, address = bundle.vault_sol @ BundleError::BadVaultAccount)]
    pub vault_sol: UncheckedAccount<'info>,
    /// CHECK: the router's LP position (its liquidity measures the vault's partner fees)
    #[account(address = bundle.router_position @ BundleError::BadPosition)]
    pub router_position: UncheckedAccount<'info>,
    /// CHECK: SPL Token
    #[account(address = SPL_TOKEN)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's event authority
    #[account(address = DAMM_EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2
    #[account(address = DAMM)]
    pub damm_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar (address checked)
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RouteCurveFees<'info> {
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    /// CHECK: the router PDA (the bundle config's fee claimer)
    #[account(seeds = [ROUTER_SEED], bump)]
    pub router: UncheckedAccount<'info>,
    /// CHECK: the bundle's DBC pool
    #[account(mut, address = bundle.pool @ BundleError::BadPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the bundle's config
    #[account(address = bundle.curve_config @ BundleError::BadPool)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: DBC's pool authority
    #[account(address = DBC_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC checks it against the pool
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC checks it against the pool
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the market token
    #[account(address = bundle.mint @ BundleError::BadPool)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL
    #[account(address = WSOL)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the router's account for the market token (checked in the handler)
    #[account(mut)]
    pub router_tokens: UncheckedAccount<'info>,
    /// CHECK: the router's wrapped SOL account
    #[account(mut, address = platform.router_sol @ BundleError::BadRouterAccount)]
    pub router_sol: UncheckedAccount<'info>,
    /// CHECK: the vault's wrapped SOL account
    #[account(mut, address = bundle.vault_sol @ BundleError::BadVaultAccount)]
    pub vault_sol: UncheckedAccount<'info>,
    /// CHECK: the backers' pot
    #[account(mut, address = bundle.pot @ BundleError::BadVaultAccount)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: repo.ing's treasury account
    #[account(mut, address = platform.treasury @ BundleError::BadSettings)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: SPL Token
    #[account(address = SPL_TOKEN)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: DBC's event authority
    #[account(address = DBC_EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC
    #[account(address = DBC)]
    pub dbc_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RoutePoolFees<'info> {
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    /// CHECK: the router PDA
    #[account(seeds = [ROUTER_SEED], bump)]
    pub router: UncheckedAccount<'info>,
    /// CHECK: the bundle's DAMM v2 pool
    #[account(address = bundle.damm_pool @ BundleError::BadPool)]
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: the router's LP position
    #[account(mut, address = bundle.router_position @ BundleError::BadPosition)]
    pub router_position: UncheckedAccount<'info>,
    /// CHECK: the router's position NFT account
    #[account(address = bundle.router_position_nft @ BundleError::BadPosition)]
    pub router_position_nft: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's pool authority
    #[account(address = DAMM_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 checks it against the pool
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 checks it against the pool
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: the market token
    #[account(address = bundle.mint @ BundleError::BadPool)]
    pub token_a_mint: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL
    #[account(address = WSOL)]
    pub token_b_mint: UncheckedAccount<'info>,
    /// CHECK: the router's account for the market token (checked in the handler)
    #[account(mut)]
    pub router_tokens: UncheckedAccount<'info>,
    /// CHECK: the router's wrapped SOL account
    #[account(mut, address = platform.router_sol @ BundleError::BadRouterAccount)]
    pub router_sol: UncheckedAccount<'info>,
    /// CHECK: the vault's wrapped SOL account
    #[account(mut, address = bundle.vault_sol @ BundleError::BadVaultAccount)]
    pub vault_sol: UncheckedAccount<'info>,
    /// CHECK: the backers' pot
    #[account(mut, address = bundle.pot @ BundleError::BadVaultAccount)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: repo.ing's treasury account
    #[account(mut, address = platform.treasury @ BundleError::BadSettings)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: SPL Token
    #[account(address = SPL_TOKEN)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's event authority
    #[account(address = DAMM_EVENT_AUTHORITY)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2
    #[account(address = DAMM)]
    pub damm_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimBackerFees<'info> {
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub bundle: Box<Account<'info, Bundle>>,
    #[account(mut, seeds = [BACKER_SEED, bundle.key().as_ref(), wallet.key().as_ref()], bump = backer.bump,
        has_one = wallet @ BundleError::NotBacker, has_one = bundle @ BundleError::NotBacker)]
    pub backer: Account<'info, Backer>,
    /// CHECK: the backers' pot
    #[account(mut, address = bundle.pot @ BundleError::BadVaultAccount)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: a wrapped SOL account of the backer's choice (checked in the handler)
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token
    #[account(address = SPL_TOKEN)]
    pub token_program: UncheckedAccount<'info>,
}

#[error_code]
pub enum BundleError {
    #[msg("only the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("only the platform admin")]
    NotAdmin,
    #[msg("only the launch signer")]
    NotLaunchSigner,
    #[msg("only a platform operator")]
    NotOperator,
    #[msg("only the backer")]
    NotBacker,
    #[msg("a key that must be set is the default key")]
    BadKey,
    #[msg("invalid platform settings")]
    BadSettings,
    #[msg("invalid vault policy")]
    BadPolicy,
    #[msg("the policy is looser than allowed")]
    PolicyTooLoose,
    #[msg("invalid raise target, minimum deposit or deadline")]
    BadRaise,
    #[msg("the bundle is not raising")]
    NotRaising,
    #[msg("the raise is closed")]
    RaiseClosed,
    #[msg("the raise can still succeed")]
    RaiseOpen,
    #[msg("the raise is not full")]
    RaiseNotFull,
    #[msg("the deposit would pass the target")]
    OverTarget,
    #[msg("the deposit is below the minimum")]
    BelowMinimum,
    #[msg("the raise has not failed")]
    NotFailed,
    #[msg("no settle for this bundle later in the transaction")]
    NoSettle,
    #[msg("the raise was not released")]
    NotReleased,
    #[msg("not a pool of the bundle config")]
    BadPool,
    #[msg("not the vault's account")]
    BadVaultAccount,
    #[msg("the vault received fewer tokens than the quote")]
    TooFewTokens,
    #[msg("the bundle is not launched")]
    NotLaunched,
    #[msg("the vault accounts are already open")]
    AlreadyOpen,
    #[msg("the vault accounts are not open")]
    VaultNotOpen,
    #[msg("the vault is paused")]
    Paused,
    #[msg("the launch fee has not ended")]
    LaunchCooldown,
    #[msg("too soon after the opposite trade")]
    TooSoon,
    #[msg("the trade is larger than the policy allows")]
    TradeTooLarge,
    #[msg("the daily limit is reached")]
    DailyLimit,
    #[msg("the sell is below the price floor")]
    BelowFloor,
    #[msg("the trade moved no tokens")]
    NoOutput,
    #[msg("the market has graduated")]
    Graduated,
    #[msg("the market has not graduated")]
    NotGraduated,
    #[msg("the curve has not migrated")]
    NotMigrated,
    #[msg("not the router's position")]
    BadPosition,
    #[msg("not the router's account")]
    BadRouterAccount,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("the destination must be a wrapped SOL account")]
    BadDestination,
    #[msg("not a token account")]
    NotTokenAccount,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("the launch did not put the released SOL into the pool")]
    NotSpent,
    #[msg("tokens outside the curve are not all in the vault")]
    TokensElsewhere,
    #[msg("only as a top-level instruction")]
    NotTopLevel,
    #[msg("a vault trade must be the only DBC or DAMM v2 instruction in its transaction")]
    NotAlone,
    #[msg("the account would fall below its rent-exempt minimum")]
    RentFloor,
}
