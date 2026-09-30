//! End-to-end tests for the donation escrow on LiteSVM (in-process; no cluster).
//! Build the program first: `programs/scripts/build.sh build`.

mod common;

use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;
use common::*;
use repo_donation_escrow::{
    constants::{REFUND_DELAY_SECS, VERIFIER_ROTATION_DELAY_SECS},
    instruction as ix_data,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

const REPO: u64 = 123_456_789;
const OTHER_REPO: u64 = 987_654_321;

// ---------------------------------------------------------------- config / roles

#[test]
fn initialize_requires_upgrade_authority() {
    let mut env = Env::new();
    let intruder = env.new_funded();
    assert_err(env.initialize_config(&intruder), "NotUpgradeAuthority");
    let admin = env.admin.insecure_clone();
    assert_ok(env.initialize_config(&admin));
    let cfg = env.config();
    assert_eq!(cfg.admin, kp(&env.admin));
    assert_eq!(cfg.verifier, kp(&env.verifier));
    assert_eq!(cfg.allowlist_authority, kp(&env.allowlist));
    // Cannot be re-initialised.
    assert_err(env.initialize_config(&admin), "already in use");
}

#[test]
fn admin_handover_is_two_step() {
    let mut env = Env::initialized();
    let admin = env.admin.insecure_clone();
    let next = env.new_funded();
    let stranger = env.new_funded();

    let ix = env.admin_ix(
        &stranger,
        ix_data::ProposeAdmin {
            new_admin: kp(&next),
        },
    );
    assert_err(env.send(&[ix], &stranger, &[]), "NotAdmin");

    let ix = env.admin_ix(
        &admin,
        ix_data::ProposeAdmin {
            new_admin: kp(&next),
        },
    );
    assert_ok(env.send(&[ix], &admin, &[]));
    assert_eq!(env.config().admin, kp(&admin), "not active until accepted");

    let accept = |who: &Keypair| {
        program_ix(
            repo_donation_escrow::accounts::AcceptAdmin {
                new_admin: kp(who),
                config: config_pda(),
            },
            ix_data::AcceptAdmin {},
        )
    };
    assert_err(
        env.send(&[accept(&stranger)], &stranger, &[]),
        "NotPendingAdmin",
    );
    assert_ok(env.send(&[accept(&next)], &next, &[]));
    assert_eq!(env.config().admin, kp(&next));
    assert_eq!(env.config().pending_admin, None);
}

// ---------------------------------------------------------------- allowlist

#[test]
fn allowlist_is_authority_gated_and_rejects_unsafe_mints() {
    let mut env = Env::initialized();
    let admin = env.admin.insecure_clone();
    let allowlist = env.allowlist.insecure_clone();

    let spl = env.create_spl_mint(6);
    assert_err(
        env.add_allowed_mint(&admin, spl, 1, false),
        "NotAllowlistAuthority",
    );
    assert_err(
        env.add_allowed_mint(&allowlist, spl, 0, false),
        "InvalidMinDeposit",
    );
    assert_ok(env.add_allowed_mint(&allowlist, spl, 1_000, false));
    let a = env.allowed(&spl.mint);
    assert_eq!(a.min_deposit, 1_000);
    assert!(!a.has_transfer_fee && !a.has_permanent_delegate);

    let hooked = env.create_t22_hook_mint(6, Some(Keypair::new().pubkey()).map(|a| pk(&a)));
    assert_err(
        env.add_allowed_mint(&allowlist, hooked, 1, true),
        "TransferHookNotSupported",
    );

    let dormant_hook = env.create_t22_hook_mint(6, None);
    assert_ok(env.add_allowed_mint(&allowlist, dormant_hook, 1, false));

    let soulbound = env.create_t22_non_transferable_mint(6);
    assert_err(
        env.add_allowed_mint(&allowlist, soulbound, 1, true),
        "NonTransferableMint",
    );

    let fee = env.create_t22_fee_mint(6, 100, u64::MAX);
    assert_ok(env.add_allowed_mint(&allowlist, fee, 1, false));
    assert!(env.allowed(&fee.mint).has_transfer_fee);
}

#[test]
fn xstocks_mint_fixture_requires_explicit_permanent_delegate_opt_in() {
    let mut env = Env::initialized();
    let allowlist = env.allowlist.insecure_clone();
    let spyx = env.load_spyx_fixture();
    for ext in [
        ExtensionType::PermanentDelegate,
        ExtensionType::TransferHook,
        ExtensionType::Pausable,
        ExtensionType::ScaledUiAmount,
        ExtensionType::DefaultAccountState,
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::MetadataPointer,
        ExtensionType::TokenMetadata,
    ] {
        assert!(
            env.mint_has_extension(&spyx.mint, ext),
            "fixture should carry {ext:?}"
        );
    }
    assert!(!env.mint_has_extension(&spyx.mint, ExtensionType::TransferFeeConfig));

    assert_err(
        env.add_allowed_mint(&allowlist, spyx, 1, false),
        "PermanentDelegateNotAllowed",
    );
    assert_ok(env.add_allowed_mint(&allowlist, spyx, 1_000_000, true));
    let a = env.allowed(&spyx.mint);
    assert!(a.has_permanent_delegate && a.has_freeze_authority && !a.has_transfer_fee);
    assert_eq!(a.decimals, 8);
}

// ---------------------------------------------------------------- deposits

#[test]
fn deposit_spl_happy_path() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1_000_000);
    let donor = env.new_funded();
    let donor_ata = env.fund(&donor, usdc, 50_000_000);

    let before = env.now();
    assert_ok(env.deposit_with(&donor, usdc, REPO, 20_000_000));

    let d = env.deposit(REPO, 0);
    assert_eq!(d.repo_id, REPO);
    assert_eq!(d.index, 0);
    assert_eq!(d.donor, kp(&donor));
    assert_eq!(d.mint, usdc.mint);
    assert_eq!(d.token_program, usdc.token_program);
    assert_eq!(d.amount, 20_000_000);
    assert_eq!(d.requested_amount, 20_000_000);
    assert_eq!(d.created_at, before);
    assert_eq!(d.refund_after, before + REFUND_DELAY_SECS);
    assert_eq!(d.vault, vault_pda(&deposit_pda(REPO, 0)));
    assert_eq!(env.token_balance(&d.vault), 20_000_000);
    assert_eq!(env.token_balance(&donor_ata), 30_000_000);

    let r = env.repo(REPO);
    assert_eq!((r.repo_id, r.deposit_count, r.open_deposits), (REPO, 1, 1));

    // A second deposit gets the next index and its own vault.
    assert_ok(env.deposit_with(&donor, usdc, REPO, 5_000_000));
    assert_eq!(env.repo(REPO).deposit_count, 2);
    assert_eq!(env.token_balance(&env.deposit(REPO, 1).vault), 5_000_000);
}

#[test]
fn deposit_wrapped_sol() {
    let mut env = Env::initialized();
    let donor = env.new_funded();
    let (wsol, _) = env.fund_wsol(&donor, 2_000_000_000);
    env.allow(wsol, 10_000_000);
    assert_ok(env.deposit_with(&donor, wsol, REPO, 1_000_000_000));
    assert_eq!(env.deposit(REPO, 0).amount, 1_000_000_000);
}

#[test]
fn deposit_token2022_plain_and_xstocks_fixture() {
    let mut env = Env::initialized();
    let t22 = env.create_t22_plain_mint(9);
    env.allow(t22, 1);
    env.donate(t22, REPO, 1_000);
    assert_eq!(env.deposit(REPO, 0).amount, 1_000);

    let spyx = env.load_spyx_fixture();
    env.allow(spyx, 1_000_000); // 0.01 SPYx
    let (_, idx) = env.donate(spyx, REPO, 250_000_000); // 2.5 SPYx
    let d = env.deposit(REPO, idx);
    assert_eq!(d.amount, 250_000_000);
    assert_eq!(env.token_balance(&d.vault), 250_000_000);
}

#[test]
fn deposit_token2022_transfer_fee_records_received_amount() {
    let mut env = Env::initialized();
    let fee_mint = env.create_t22_fee_mint(6, 100, u64::MAX); // 1% fee
    env.allow(fee_mint, 100_000);
    let (_, idx) = env.donate(fee_mint, REPO, 1_000_000);
    let d = env.deposit(REPO, idx);
    assert_eq!(d.requested_amount, 1_000_000);
    assert_eq!(
        d.amount, 990_000,
        "recorded amount is the vault balance delta"
    );
    assert_eq!(env.token_balance(&d.vault), 990_000);
}

#[test]
fn deposit_rejects_non_allowlisted_mint() {
    let mut env = Env::initialized();
    let rogue = env.create_spl_mint(6);
    let donor = env.new_funded();
    env.fund(&donor, rogue, 1_000_000);
    assert_err(
        env.deposit_with(&donor, rogue, REPO, 1_000_000),
        "AccountNotInitialized",
    );
}

#[test]
fn deposit_rejects_below_minimum_including_after_fees() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1_000_000);
    let donor = env.new_funded();
    env.fund(&donor, usdc, 10_000_000);
    assert_err(
        env.deposit_with(&donor, usdc, REPO, 999_999),
        "BelowMinimumDeposit",
    );
    assert_err(env.deposit_with(&donor, usdc, REPO, 0), "ZeroAmount");

    // Fee mint: 1_000_000 sent, 990_000 received < 1_000_000 minimum.
    let fee_mint = env.create_t22_fee_mint(6, 100, u64::MAX);
    env.allow(fee_mint, 1_000_000);
    env.fund(&donor, fee_mint, 10_000_000);
    assert_err(
        env.deposit_with(&donor, fee_mint, REPO, 1_000_000),
        "BelowMinimumDeposit",
    );
    assert!(
        !env.exists(&repo_pda(REPO)),
        "failed deposits leave no state"
    );
}

#[test]
fn deposit_rejects_wrong_index_and_token_program_mismatch() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let donor = env.new_funded();
    env.fund(&donor, usdc, 10_000);
    let ix = env.deposit_ix(&kp(&donor), usdc, REPO, 5, 1_000);
    assert_err(env.send(&[ix], &donor, &[]), "DepositIndexMismatch");

    let wrong_program = TestMint {
        token_program: anchor_spl::token_2022::ID,
        ..usdc
    };
    let ix = env.deposit_ix(&kp(&donor), wrong_program, REPO, 0, 1_000);
    assert!(env.send(&[ix], &donor, &[]).is_err());
}

#[test]
fn deposit_rejected_once_issuer_activates_transfer_hook() {
    let mut env = Env::initialized();
    let spyx = env.load_spyx_fixture();
    env.allow(spyx, 1);
    let (_, idx) = env.donate(spyx, REPO, 100_000_000);

    let donor = env.new_funded();
    env.fund(&donor, spyx, 100_000_000);
    env.set_transfer_hook_program(&spyx.mint, pk(&Keypair::new().pubkey()));
    assert_err(
        env.deposit_with(&donor, spyx, REPO, 100_000_000),
        "TransferHookNotSupported",
    );
    // The earlier deposit is untouched and still Open.
    assert!(
        env.exists(&deposit_pda(REPO, idx)),
        "earlier deposit untouched"
    );
}

#[test]
fn removed_mint_blocks_new_deposits_but_not_settlement() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (donor, idx) = env.donate(usdc, REPO, 1_000);
    let allowlist = env.allowlist.insecure_clone();
    let stranger = env.new_funded();
    assert_err(
        env.remove_allowed_mint(&stranger, usdc),
        "NotAllowlistAuthority",
    );
    assert_ok(env.remove_allowed_mint(&allowlist, usdc));

    env.fund(&donor, usdc, 1_000);
    assert_err(
        env.deposit_with(&donor, usdc, REPO, 1_000),
        "AccountNotInitialized",
    );

    let maintainer = pk(&Keypair::new().pubkey());
    assert_ok(env.release(REPO, idx, &maintainer, 1));
    assert_eq!(
        env.token_balance(&ata(&maintainer, &usdc.mint, &usdc.token_program)),
        1_000
    );
}

// ---------------------------------------------------------------- release

#[test]
fn release_with_valid_attestation_pays_attested_wallet() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (donor, idx) = env.donate(usdc, REPO, 7_000_000);
    let vault = env.deposit(REPO, idx).vault;
    let record = deposit_pda(REPO, idx);
    let all_rent = env.lamports(&vault) + env.lamports(&record);
    let donor_lamports = env.lamports(&kp(&donor));

    let maintainer = pk(&Keypair::new().pubkey());
    let meta = assert_ok(env.release(REPO, idx, &maintainer, 42));
    assert!(
        meta.logs.iter().any(|l| l.contains("Program data:")),
        "emits an event"
    );

    let recipient_ata = ata(&maintainer, &usdc.mint, &usdc.token_program);
    assert_eq!(env.token_balance(&recipient_ata), 7_000_000);
    assert!(!env.exists(&vault), "vault closed");
    assert!(!env.exists(&record), "deposit record closed");
    assert_eq!(
        env.lamports(&kp(&donor)),
        donor_lamports + all_rent,
        "all rent (vault + record) back to the donor, none to the recipient/payer"
    );
    assert_eq!(
        env.lamports(&maintainer),
        0,
        "recipient wallet gets no lamports"
    );
    let r = env.repo(REPO);
    assert_eq!((r.open_deposits, r.last_release_nonce), (0, 42));
}

#[test]
fn release_token2022_fee_mint_and_xstocks_fixture() {
    let mut env = Env::initialized();
    let fee_mint = env.create_t22_fee_mint(6, 100, u64::MAX);
    env.allow(fee_mint, 1);
    let (_, i0) = env.donate(fee_mint, REPO, 1_000_000); // vault receives 990_000
    let spyx = env.load_spyx_fixture();
    env.allow(spyx, 1);
    let (_, i1) = env.donate(spyx, REPO, 300_000_000);

    let maintainer = pk(&Keypair::new().pubkey());
    let fee_vault = env.deposit(REPO, i0).vault;
    assert_ok(env.release(REPO, i0, &maintainer, 1));
    // 990_000 leaves the vault; 1% outbound fee is withheld in the recipient account.
    assert_eq!(
        env.token_balance(&ata(&maintainer, &fee_mint.mint, &fee_mint.token_program)),
        980_100
    );
    assert!(!env.exists(&fee_vault), "fee vault harvested and closed");
    assert!(!env.exists(&deposit_pda(REPO, i0)));

    assert_ok(env.release(REPO, i1, &maintainer, 2));
    assert_eq!(
        env.token_balance(&ata(&maintainer, &spyx.mint, &spyx.token_program)),
        300_000_000
    );
}

#[test]
fn permanent_delegate_seizure_is_isolated_to_one_deposit() {
    let mut env = Env::initialized();
    let spyx = env.load_spyx_fixture();
    env.allow(spyx, 1);
    let (_, i0) = env.donate(spyx, REPO, 100_000_000);
    let (_, i1) = env.donate(spyx, REPO, 100_000_000);

    // The issuer (permanent delegate) claws back 40% of deposit 0's vault.
    let issuer = env.new_funded();
    env.set_permanent_delegate(&spyx.mint, kp(&issuer));
    let v0 = env.deposit(REPO, i0).vault;
    env.seize(&issuer, spyx, &v0, 40_000_000);

    // Release pays whatever is actually left; deposit 1 is unaffected.
    let who = pk(&Keypair::new().pubkey());
    let who_ata = ata(&who, &spyx.mint, &spyx.token_program);
    assert_ok(env.release(REPO, i0, &who, 1));
    assert_eq!(env.token_balance(&who_ata), 60_000_000);
    assert_ok(env.release(REPO, i1, &who, 2));
    assert_eq!(
        env.token_balance(&ata(&who, &spyx.mint, &spyx.token_program)),
        160_000_000
    );
}

#[test]
fn release_rejects_wrong_recipient() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (_, idx) = env.donate(usdc, REPO, 1_000);
    let verifier = env.verifier.insecure_clone();
    let attested = pk(&Keypair::new().pubkey());
    let thief = pk(&Keypair::new().pubkey());
    let expiry = env.now() + 600;
    assert_err(
        env.release_signed(&verifier, REPO, idx, REPO, &attested, &thief, expiry, 1),
        "AttestationMessageMismatch",
    );
    assert!(env.exists(&deposit_pda(REPO, idx)));
}

#[test]
fn release_rejects_expired_attestation() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (_, idx) = env.donate(usdc, REPO, 1_000);
    let verifier = env.verifier.insecure_clone();
    let who = pk(&Keypair::new().pubkey());
    let expiry = env.now() + 60;
    env.warp(61);
    assert_err(
        env.release_signed(&verifier, REPO, idx, REPO, &who, &who, expiry, 1),
        "AttestationExpired",
    );
    let expiry = env.now();
    assert_err(
        env.release_signed(&verifier, REPO, idx, REPO, &who, &who, expiry, 1),
        "AttestationExpired",
    );
}

#[test]
fn release_rejects_replayed_or_stale_nonce() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (_, i0) = env.donate(usdc, REPO, 1_000);
    let (_, i1) = env.donate(usdc, REPO, 1_000);
    let (_, i2) = env.donate(usdc, REPO, 1_000);
    let who = pk(&Keypair::new().pubkey());
    assert_ok(env.release(REPO, i0, &who, 10));
    assert_err(env.release(REPO, i1, &who, 10), "AttestationNonceReplayed");
    assert_err(env.release(REPO, i1, &who, 9), "AttestationNonceReplayed");
    assert_ok(env.release(REPO, i1, &who, 11));

    // Nonces are per repo: another repo's counter is independent.
    let (_, j0) = env.donate(usdc, OTHER_REPO, 1_000);
    assert_ok(env.release(OTHER_REPO, j0, &who, 1));
    assert_ok(env.release(REPO, i2, &who, 12));
}

#[test]
fn release_rejects_foreign_repo_attestation() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (_, idx) = env.donate(usdc, REPO, 1_000);
    let verifier = env.verifier.insecure_clone();
    let who = pk(&Keypair::new().pubkey());
    let expiry = env.now() + 600;
    // Attestation is for OTHER_REPO, used against REPO's deposit.
    assert_err(
        env.release_signed(&verifier, REPO, idx, OTHER_REPO, &who, &who, expiry, 1),
        "AttestationMessageMismatch",
    );
}

#[test]
fn release_rejects_missing_or_foreign_signed_attestation() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (_, idx) = env.donate(usdc, REPO, 1_000);
    let who = pk(&Keypair::new().pubkey());
    let expiry = env.now() + 600;

    // No ed25519 instruction at all.
    let payer = env.new_funded();
    let ix = env.release_ix(&kp(&payer), REPO, idx, &who, expiry, 1);
    assert_err(env.send(&[ix], &payer, &[]), "MissingAttestation");

    // Valid signature, but not by the verifier (e.g. the admin).
    let admin = env.admin.insecure_clone();
    assert_err(
        env.release_signed(&admin, REPO, idx, REPO, &who, &who, expiry, 1),
        "AttestationWrongSigner",
    );

    // Attestation not immediately before the release instruction.
    let verifier = env.verifier.insecure_clone();
    let msg = repo_donation_escrow::attestation::attestation_message(
        &repo_donation_escrow::ID,
        REPO,
        &who,
        expiry,
        1,
    );
    let spacer =
        anchor_lang::solana_program::system_instruction::transfer(&kp(&payer), &kp(&payer), 0);
    let spacer = solana_instruction::Instruction {
        program_id: addr(&spacer.program_id),
        accounts: spacer
            .accounts
            .iter()
            .map(|m| solana_instruction::AccountMeta {
                pubkey: addr(&m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: spacer.data,
    };
    let ixs = vec![
        env.attestation_ix(&verifier, &msg),
        spacer,
        env.release_ix(&kp(&payer), REPO, idx, &who, expiry, 1),
    ];
    assert_err(env.send(&ixs, &payer, &[]), "MissingAttestation");

    // Tampered precompile data is rejected by the runtime before our program runs.
    let mut bad = env.attestation_ix(&verifier, &msg);
    let last = bad.data.len() - 1;
    bad.data[last] ^= 1;
    let ixs = vec![bad, env.release_ix(&kp(&payer), REPO, idx, &who, expiry, 1)];
    assert!(env.send(&ixs, &payer, &[]).is_err());
    assert!(env.exists(&deposit_pda(REPO, idx)));
}

#[test]
fn release_rejects_double_release() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (_, idx) = env.donate(usdc, REPO, 1_000);
    let who = pk(&Keypair::new().pubkey());
    assert_ok(env.release(REPO, idx, &who, 1));
    // Record and vault are closed: a second release (fresh nonce, valid attestation) fails.
    assert_err(env.release(REPO, idx, &who, 2), "AccountNotInitialized");
    assert_eq!(
        env.token_balance(&ata(&who, &usdc.mint, &usdc.token_program)),
        1_000
    );
    assert_eq!(env.repo(REPO).last_release_nonce, 1);
}

#[test]
fn releases_can_be_paused_but_refunds_cannot() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (donor, idx) = env.donate(usdc, REPO, 1_000);
    let admin = env.admin.insecure_clone();
    let ix = env.admin_ix(&admin, ix_data::SetReleasesPaused { paused: true });
    assert_ok(env.send(&[ix], &admin, &[]));

    let who = pk(&Keypair::new().pubkey());
    assert_err(env.release(REPO, idx, &who, 1), "ReleasesPaused");
    env.warp(REFUND_DELAY_SECS);
    assert_ok(env.refund(&donor, REPO, idx));
}

// ---------------------------------------------------------------- refunds

#[test]
fn refund_before_90_days_rejected_after_90_days_ok() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (donor, idx) = env.donate(usdc, REPO, 5_000);
    let donor_ata = ata(&kp(&donor), &usdc.mint, &usdc.token_program);
    assert_eq!(env.token_balance(&donor_ata), 0);

    assert_err(env.refund(&donor, REPO, idx), "RefundNotYetAvailable");
    env.warp(REFUND_DELAY_SECS - 10);
    assert_err(env.refund(&donor, REPO, idx), "RefundNotYetAvailable");
    env.warp(10);

    let vault = env.deposit(REPO, idx).vault;
    let record = deposit_pda(REPO, idx);
    let all_rent = env.lamports(&vault) + env.lamports(&record);
    let donor_lamports = env.lamports(&kp(&donor));
    let meta = assert_ok(env.refund(&donor, REPO, idx));
    assert_eq!(env.token_balance(&donor_ata), 5_000);
    assert!(!env.exists(&vault), "vault closed");
    assert!(!env.exists(&record), "deposit record closed");
    assert_eq!(
        env.lamports(&kp(&donor)),
        donor_lamports + all_rent - meta.fee,
        "all rent back to the donor (minus the tx fee they paid)"
    );
    assert_eq!(env.repo(REPO).open_deposits, 0);

    // Refunded deposits cannot be refunded or released again.
    assert!(env.refund(&donor, REPO, idx).is_err());
    let who = pk(&Keypair::new().pubkey());
    assert!(env.release(REPO, idx, &who, 1).is_err());
}

#[test]
fn refund_works_for_fee_mint_and_xstocks_fixture() {
    let mut env = Env::initialized();
    let fee_mint = env.create_t22_fee_mint(6, 100, u64::MAX);
    env.allow(fee_mint, 1);
    let (d1, i1) = env.donate(fee_mint, REPO, 1_000_000);
    let spyx = env.load_spyx_fixture();
    env.allow(spyx, 1);
    let (d2, i2) = env.donate(spyx, REPO, 1_000_000);
    env.warp(REFUND_DELAY_SECS);
    assert_ok(env.refund(&d1, REPO, i1));
    assert_eq!(
        env.token_balance(&ata(&kp(&d1), &fee_mint.mint, &fee_mint.token_program)),
        980_100
    );
    assert_ok(env.refund(&d2, REPO, i2));
    assert_eq!(
        env.token_balance(&ata(&kp(&d2), &spyx.mint, &spyx.token_program)),
        1_000_000
    );
}

#[test]
fn refund_by_non_donor_rejected() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (_, idx) = env.donate(usdc, REPO, 1_000);
    env.warp(REFUND_DELAY_SECS + 1);
    let stranger = env.new_funded();
    assert_err(env.refund(&stranger, REPO, idx), "ConstraintHasOne");
}

#[test]
fn refund_after_release_rejected() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (donor, idx) = env.donate(usdc, REPO, 1_000);
    let who = pk(&Keypair::new().pubkey());
    assert_ok(env.release(REPO, idx, &who, 1));
    env.warp(REFUND_DELAY_SECS + 1);
    assert_err(env.refund(&donor, REPO, idx), "AccountNotInitialized");
    assert!(!env.exists(&deposit_pda(REPO, idx)));
}

#[test]
fn closed_deposit_cannot_be_revived_or_reinitialised() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (donor, idx) = env.donate(usdc, REPO, 1_000);
    let who = pk(&Keypair::new().pubkey());
    assert_ok(env.release(REPO, idx, &who, 1));

    // Re-initialising the same index is impossible: the index must equal deposit_count.
    env.fund(&donor, usdc, 1_000);
    let ix = env.deposit_ix(&kp(&donor), usdc, REPO, idx, 1_000);
    assert_err(env.send(&[ix], &donor, &[]), "DepositIndexMismatch");

    // "Reviving" the address with lamports leaves a system-owned account that
    // cannot be deserialised as a Deposit, so release/refund still fail.
    let record = deposit_pda(REPO, idx);
    let funder = env.new_funded();
    let ix = anchor_lang::solana_program::system_instruction::transfer(
        &kp(&funder),
        &record,
        10_000_000,
    );
    let ix = solana_instruction::Instruction {
        program_id: addr(&ix.program_id),
        accounts: ix
            .accounts
            .iter()
            .map(|m| solana_instruction::AccountMeta {
                pubkey: addr(&m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: ix.data,
    };
    assert_ok(env.send(&[ix], &funder, &[]));
    assert_err(
        env.release(REPO, idx, &who, 2),
        "AccountOwnedByWrongProgram",
    );
    env.warp(REFUND_DELAY_SECS + 1);
    assert!(env.refund(&donor, REPO, idx).is_err());
    assert_eq!(
        env.token_balance(&ata(&who, &usdc.mint, &usdc.token_program)),
        1_000
    );

    // The next deposit uses a fresh index and settles normally.
    assert_ok(env.deposit_with(&donor, usdc, REPO, 1_000));
    assert_ok(env.release(REPO, idx + 1, &who, 3));
    assert_eq!(
        env.token_balance(&ata(&who, &usdc.mint, &usdc.token_program)),
        2_000
    );
}

// ---------------------------------------------------------------- admin powers

#[test]
fn admin_cannot_withdraw_deposits() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (_, idx) = env.donate(usdc, REPO, 1_000);
    let admin = env.admin.insecure_clone();
    env.warp(REFUND_DELAY_SECS + 1);

    // Not the donor.
    assert_err(env.refund(&admin, REPO, idx), "ConstraintHasOne");
    // Admin-signed attestation to the admin's wallet.
    let expiry = env.now() + 600;
    assert_err(
        env.release_signed(&admin, REPO, idx, REPO, &kp(&admin), &kp(&admin), expiry, 1),
        "AttestationWrongSigner",
    );
    // Swapping in an admin-controlled verifier is time-locked...
    let ix = env.admin_ix(
        &admin,
        ix_data::ProposeVerifier {
            new_verifier: kp(&admin),
        },
    );
    assert_ok(env.send(&[ix], &admin, &[]));
    assert_err(env.activate_verifier(&admin), "VerifierRotationNotReady");
    assert_err(
        env.release_signed(&admin, REPO, idx, REPO, &kp(&admin), &kp(&admin), expiry, 1),
        "AttestationWrongSigner",
    );
    assert_eq!(env.token_balance(&env.deposit(REPO, idx).vault), 1_000);
}

#[test]
fn verifier_rotation_is_timelocked_and_unlocks_early_refunds() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (_, i0) = env.donate(usdc, REPO, 1_000);
    let (d1, i1) = env.donate(usdc, REPO, 1_000);
    let (_, i2) = env.donate(usdc, REPO, 1_000);
    let admin = env.admin.insecure_clone();
    let old = env.verifier.insecure_clone();
    let new_verifier = env.new_funded();
    let who = pk(&Keypair::new().pubkey());

    let stranger = env.new_funded();
    let ix = env.admin_ix(
        &stranger,
        ix_data::ProposeVerifier {
            new_verifier: kp(&new_verifier),
        },
    );
    assert_err(env.send(&[ix], &stranger, &[]), "NotAdmin");

    let ix = env.admin_ix(
        &admin,
        ix_data::ProposeVerifier {
            new_verifier: kp(&new_verifier),
        },
    );
    assert_ok(env.send(&[ix], &admin, &[]));
    assert_eq!(env.config().pending_verifier, Some(kp(&new_verifier)));

    // While pending: the old verifier still works, the new one does not yet.
    assert_ok(env.release(REPO, i0, &who, 1));
    let expiry = env.now() + 600;
    assert_err(
        env.release_signed(&new_verifier, REPO, i2, REPO, &who, &who, expiry, 2),
        "AttestationWrongSigner",
    );
    // ...and donors may exit early.
    assert_ok(env.refund(&d1, REPO, i1));
    assert!(!env.exists(&deposit_pda(REPO, i1)));

    assert_err(env.activate_verifier(&stranger), "VerifierRotationNotReady");
    env.warp(VERIFIER_ROTATION_DELAY_SECS);
    assert_ok(env.activate_verifier(&stranger)); // permissionless after the delay
    let cfg = env.config();
    assert_eq!(
        (cfg.verifier, cfg.verifier_epoch, cfg.pending_verifier),
        (kp(&new_verifier), 1, None)
    );

    let expiry = env.now() + 600;
    assert_err(
        env.release_signed(&old, REPO, i2, REPO, &who, &who, expiry, 2),
        "AttestationWrongSigner",
    );
    assert_ok(env.release_signed(&new_verifier, REPO, i2, REPO, &who, &who, expiry, 2));
    assert_eq!(
        env.token_balance(&ata(&who, &usdc.mint, &usdc.token_program)),
        2_000
    );
}

#[test]
fn cancelled_rotation_restores_normal_refund_lock() {
    let mut env = Env::initialized();
    let usdc = env.create_spl_mint(6);
    env.allow(usdc, 1);
    let (donor, idx) = env.donate(usdc, REPO, 1_000);
    let admin = env.admin.insecure_clone();
    let ix = env.admin_ix(
        &admin,
        ix_data::ProposeVerifier {
            new_verifier: kp(&admin),
        },
    );
    assert_ok(env.send(&[ix], &admin, &[]));
    let ix = env.admin_ix(&admin, ix_data::CancelVerifierRotation {});
    assert_ok(env.send(&[ix], &admin, &[]));
    assert_err(env.refund(&donor, REPO, idx), "RefundNotYetAvailable");
    assert_err(env.activate_verifier(&admin), "NoPendingVerifier");
}
