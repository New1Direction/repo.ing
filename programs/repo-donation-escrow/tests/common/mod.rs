//! LiteSVM harness for the donation escrow. Everything runs in-process; nothing
//! here talks to a real cluster.
#![allow(dead_code, clippy::result_large_err)]

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{program_pack::Pack, system_instruction},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::{
        get_associated_token_address_with_program_id,
        spl_associated_token_account::instruction::create_associated_token_account,
    },
    token::spl_token,
    token_2022::spl_token_2022::{
        self,
        extension::{
            permanent_delegate::PermanentDelegate,
            transfer_fee::instruction::initialize_transfer_fee_config,
            transfer_hook::{self, TransferHook},
            BaseStateWithExtensions, BaseStateWithExtensionsMut, ExtensionType,
            StateWithExtensions, StateWithExtensionsMut,
        },
        state::{Account as TokenAccountState, Mint as MintState},
    },
};
use base64::Engine;
use litesvm::{types::TransactionResult, LiteSVM};
use repo_donation_escrow::{
    accounts as ix_accounts,
    attestation::attestation_message,
    constants::*,
    instruction as ix_data,
    state::{AllowedMint, Config, Deposit, RepoVault},
};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{cell::RefCell, collections::HashMap};

pub const PROGRAM_ID: Pubkey = repo_donation_escrow::ID;
pub const SPYX_MINT: &str = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
pub const DAY: i64 = 24 * 60 * 60;

// ---------- type bridging (anchor's Pubkey vs LiteSVM's Address) ----------

pub fn addr(p: &Pubkey) -> Address {
    Address::new_from_array(p.to_bytes())
}

pub fn pk(a: &Address) -> Pubkey {
    Pubkey::new_from_array(a.to_bytes())
}

pub fn kp(k: &Keypair) -> Pubkey {
    pk(&k.pubkey())
}

/// Converts an instruction built with anchor-side crates into LiteSVM's type.
macro_rules! conv {
    ($ix:expr) => {{
        let ix = $ix;
        Instruction {
            program_id: Address::new_from_array(ix.program_id.to_bytes()),
            accounts: ix
                .accounts
                .iter()
                .map(|m| AccountMeta {
                    pubkey: Address::new_from_array(m.pubkey.to_bytes()),
                    is_signer: m.is_signer,
                    is_writable: m.is_writable,
                })
                .collect(),
            data: ix.data.clone(),
        }
    }};
}

pub fn program_ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: addr(&PROGRAM_ID),
        accounts: accounts
            .to_account_metas(None)
            .into_iter()
            .map(|m| AccountMeta {
                pubkey: addr(&m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data: data.data(),
    }
}

// ---------- PDAs ----------

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &PROGRAM_ID).0
}
pub fn allowed_mint_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ALLOWED_MINT_SEED, mint.as_ref()], &PROGRAM_ID).0
}
pub fn repo_pda(repo_id: u64) -> Pubkey {
    Pubkey::find_program_address(&[REPO_SEED, &repo_id.to_le_bytes()], &PROGRAM_ID).0
}
pub fn deposit_pda(repo_id: u64, index: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[DEPOSIT_SEED, &repo_id.to_le_bytes(), &index.to_le_bytes()],
        &PROGRAM_ID,
    )
    .0
}
pub fn vault_pda(deposit: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[DEPOSIT_VAULT_SEED, deposit.as_ref()], &PROGRAM_ID).0
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, token_program)
}

// ---------- mints under test ----------

#[derive(Clone, Copy, Debug)]
pub struct TestMint {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
}

pub struct Env {
    pub svm: LiteSVM,
    /// Last seen state of each deposit, so tests can build instructions against
    /// deposits that have since been closed (replay / revival attempts).
    seen: RefCell<HashMap<(u64, u64), Deposit>>,
    pub admin: Keypair,
    pub verifier: Keypair,
    pub allowlist: Keypair,
    pub mint_authority: Keypair,
}

pub fn assert_err(res: TransactionResult, needle: &str) {
    match res {
        Ok(meta) => panic!(
            "expected failure containing {needle:?}, got success: {:#?}",
            meta.logs
        ),
        Err(e) => {
            let logs = e.meta.logs.join("\n");
            let err = format!("{:?}", e.err);
            assert!(
                logs.contains(needle) || err.contains(needle),
                "expected {needle:?}; err={err}\nlogs:\n{logs}"
            );
        }
    }
}

pub fn assert_ok(res: TransactionResult) -> litesvm::types::TransactionMetadata {
    match res {
        Ok(meta) => meta,
        Err(e) => panic!("tx failed: {:?}\n{}", e.err, e.meta.logs.join("\n")),
    }
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/deploy/repo_donation_escrow.so"
        );
        svm.add_program_from_file(addr(&PROGRAM_ID), so)
            .expect("build the program first: programs/scripts/build.sh build");

        let env = Env {
            svm,
            seen: RefCell::new(HashMap::new()),
            admin: Keypair::new(),
            verifier: Keypair::new(),
            allowlist: Keypair::new(),
            mint_authority: Keypair::new(),
        };
        let mut env = env;
        for k in [
            &env.admin,
            &env.verifier,
            &env.allowlist,
            &env.mint_authority,
        ] {
            env.svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        env.set_upgrade_authority(Some(kp(&env.admin)));
        env
    }

    /// Env with config initialised by the admin (the upgrade authority).
    pub fn initialized() -> Self {
        let mut env = Self::new();
        let admin = env.admin.insecure_clone();
        let res = env.initialize_config(&admin);
        assert_ok(res);
        env
    }

    /// LiteSVM deploys with no upgrade authority; patch the ProgramData header.
    pub fn set_upgrade_authority(&mut self, authority: Option<Pubkey>) {
        let loader = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
        let (pd, _) = Pubkey::find_program_address(&[PROGRAM_ID.as_ref()], &loader);
        let mut acct = self.svm.get_account(&addr(&pd)).unwrap();
        // bincode: u32 tag (3) | u64 slot | Option<Pubkey>
        match authority {
            Some(a) => {
                acct.data[12] = 1;
                acct.data[13..45].copy_from_slice(a.as_ref());
            }
            None => acct.data[12..45].fill(0),
        }
        self.svm.set_account(addr(&pd), acct).unwrap();
    }

    pub fn program_data(&self) -> Pubkey {
        let loader = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
        Pubkey::find_program_address(&[PROGRAM_ID.as_ref()], &loader).0
    }

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        signers: &[&Keypair],
    ) -> TransactionResult {
        let mut all: Vec<&Keypair> = vec![payer];
        for s in signers {
            if s.pubkey() != payer.pubkey() {
                all.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            &all,
            self.svm.latest_blockhash(),
        );
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    pub fn new_funded(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        k
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn warp(&mut self, secs: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += secs;
        clock.slot += (secs.max(0) as u64) * 2 + 1;
        self.svm.set_sysvar(&clock);
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm
            .get_account(&addr(key))
            .map(|a| a.lamports)
            .unwrap_or(0)
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.svm
            .get_account(&addr(key))
            .map(|a| a.lamports > 0)
            .unwrap_or(false)
    }

    pub fn read<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acct = self.svm.get_account(&addr(key)).expect("account missing");
        T::try_deserialize(&mut acct.data.as_slice()).expect("deserialize")
    }

    pub fn config(&self) -> Config {
        self.read(&config_pda())
    }
    /// Live deposit record (panics if closed).
    pub fn deposit(&self, repo_id: u64, index: u64) -> Deposit {
        let d: Deposit = self.read(&deposit_pda(repo_id, index));
        self.seen.borrow_mut().insert((repo_id, index), d.clone());
        d
    }

    /// Live record if present, otherwise the last one seen (for closed deposits).
    pub fn deposit_meta(&self, repo_id: u64, index: u64) -> Deposit {
        let live = self
            .svm
            .get_account(&addr(&deposit_pda(repo_id, index)))
            .and_then(|a| Deposit::try_deserialize(&mut a.data.as_slice()).ok());
        if let Some(d) = live {
            self.seen.borrow_mut().insert((repo_id, index), d.clone());
            return d;
        }
        self.seen
            .borrow()
            .get(&(repo_id, index))
            .cloned()
            .expect("deposit never observed")
    }
    pub fn repo(&self, repo_id: u64) -> RepoVault {
        self.read(&repo_pda(repo_id))
    }
    pub fn allowed(&self, mint: &Pubkey) -> AllowedMint {
        self.read(&allowed_mint_pda(mint))
    }

    pub fn token_balance(&self, account: &Pubkey) -> u64 {
        let acct = self
            .svm
            .get_account(&addr(account))
            .expect("token account missing");
        StateWithExtensions::<TokenAccountState>::unpack(&acct.data)
            .unwrap()
            .base
            .amount
    }

    // ---------- admin instructions ----------

    pub fn initialize_config(&mut self, payer: &Keypair) -> TransactionResult {
        let ix = program_ix(
            ix_accounts::InitializeConfig {
                payer: kp(payer),
                config: config_pda(),
                program: PROGRAM_ID,
                program_data: self.program_data(),
                system_program: anchor_lang::system_program::ID,
            },
            ix_data::InitializeConfig {
                admin: kp(&self.admin),
                verifier: kp(&self.verifier),
                allowlist_authority: kp(&self.allowlist),
            },
        );
        self.send(&[ix], payer, &[])
    }

    pub fn admin_ix(&self, signer: &Keypair, data: impl InstructionData) -> Instruction {
        program_ix(
            ix_accounts::AdminOnly {
                admin: kp(signer),
                config: config_pda(),
            },
            data,
        )
    }

    pub fn activate_verifier(&mut self, payer: &Keypair) -> TransactionResult {
        let ix = program_ix(
            ix_accounts::ActivateVerifier {
                config: config_pda(),
            },
            ix_data::ActivateVerifier {},
        );
        self.send(&[ix], payer, &[])
    }

    pub fn add_allowed_mint(
        &mut self,
        signer: &Keypair,
        m: TestMint,
        min_deposit: u64,
        allow_permanent_delegate: bool,
    ) -> TransactionResult {
        let ix = program_ix(
            ix_accounts::AddAllowedMint {
                allowlist_authority: kp(signer),
                config: config_pda(),
                mint: m.mint,
                allowed_mint: allowed_mint_pda(&m.mint),
                token_program: m.token_program,
                system_program: anchor_lang::system_program::ID,
            },
            ix_data::AddAllowedMint {
                min_deposit,
                allow_permanent_delegate,
            },
        );
        self.send(&[ix], signer, &[])
    }

    pub fn allow(&mut self, m: TestMint, min_deposit: u64) {
        let allowlist = self.allowlist.insecure_clone();
        assert_ok(self.add_allowed_mint(&allowlist, m, min_deposit, true));
    }

    pub fn remove_allowed_mint(&mut self, signer: &Keypair, m: TestMint) -> TransactionResult {
        let ix = program_ix(
            ix_accounts::RemoveAllowedMint {
                allowlist_authority: kp(signer),
                config: config_pda(),
                allowed_mint: allowed_mint_pda(&m.mint),
            },
            ix_data::RemoveAllowedMint {},
        );
        self.send(&[ix], signer, &[])
    }

    // ---------- mints and balances ----------

    fn create_mint_account(&mut self, mint: &Keypair, token_program: &Pubkey, space: usize) {
        let payer = self.mint_authority.insecure_clone();
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let ix = conv!(system_instruction::create_account(
            &kp(&payer),
            &kp(mint),
            lamports,
            space as u64,
            token_program,
        ));
        assert_ok(self.send(&[ix], &payer, &[mint]));
    }

    fn init_mint_ixs(&self, mint: &Pubkey, token_program: &Pubkey, decimals: u8) -> Instruction {
        conv!(spl_token_2022::instruction::initialize_mint2(
            token_program,
            mint,
            &kp(&self.mint_authority),
            None,
            decimals
        )
        .unwrap())
    }

    pub fn create_spl_mint(&mut self, decimals: u8) -> TestMint {
        let mint = Keypair::new();
        let program = spl_token::ID;
        self.create_mint_account(&mint, &program, 82);
        let ix = conv!(spl_token::instruction::initialize_mint2(
            &program,
            &kp(&mint),
            &kp(&self.mint_authority),
            None,
            decimals
        )
        .unwrap());
        let payer = self.mint_authority.insecure_clone();
        assert_ok(self.send(&[ix], &payer, &[]));
        TestMint {
            mint: kp(&mint),
            token_program: program,
            decimals,
        }
    }

    /// Token-2022 mint carrying the given pre-init extension instructions.
    fn create_t22_mint(
        &mut self,
        decimals: u8,
        extensions: &[ExtensionType],
        pre_init: impl Fn(&Pubkey) -> Vec<Instruction>,
    ) -> TestMint {
        let mint = Keypair::new();
        let program = spl_token_2022::ID;
        let space = ExtensionType::try_calculate_account_len::<MintState>(extensions).unwrap();
        self.create_mint_account(&mint, &program, space);
        let mut ixs = pre_init(&kp(&mint));
        ixs.push(self.init_mint_ixs(&kp(&mint), &program, decimals));
        let payer = self.mint_authority.insecure_clone();
        assert_ok(self.send(&ixs, &payer, &[]));
        TestMint {
            mint: kp(&mint),
            token_program: program,
            decimals,
        }
    }

    pub fn create_t22_plain_mint(&mut self, decimals: u8) -> TestMint {
        self.create_t22_mint(decimals, &[], |_| vec![])
    }

    pub fn create_t22_fee_mint(&mut self, decimals: u8, bps: u16, max_fee: u64) -> TestMint {
        let authority = kp(&self.mint_authority);
        self.create_t22_mint(decimals, &[ExtensionType::TransferFeeConfig], move |mint| {
            vec![conv!(initialize_transfer_fee_config(
                &spl_token_2022::ID,
                mint,
                Some(&authority),
                Some(&authority),
                bps,
                max_fee
            )
            .unwrap())]
        })
    }

    pub fn create_t22_hook_mint(&mut self, decimals: u8, hook_program: Option<Pubkey>) -> TestMint {
        let authority = kp(&self.mint_authority);
        self.create_t22_mint(decimals, &[ExtensionType::TransferHook], move |mint| {
            vec![conv!(transfer_hook::instruction::initialize(
                &spl_token_2022::ID,
                mint,
                Some(authority),
                hook_program
            )
            .unwrap())]
        })
    }

    pub fn create_t22_non_transferable_mint(&mut self, decimals: u8) -> TestMint {
        self.create_t22_mint(decimals, &[ExtensionType::NonTransferable], |mint| {
            vec![conv!(
                spl_token_2022::instruction::initialize_non_transferable_mint(
                    &spl_token_2022::ID,
                    mint
                )
                .unwrap()
            )]
        })
    }

    /// Loads the real mainnet SPYx mint bytes (tests/fixtures) into LiteSVM with the
    /// mint authority swapped for our test key, so we can mint balances.
    pub fn load_spyx_fixture(&mut self) -> TestMint {
        let b64 = include_str!("../fixtures/spyx-mint.mainnet.b64").trim();
        let mut data = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        // Mint layout: COption<Pubkey> mint_authority = [u32 tag | 32 bytes]
        assert_eq!(&data[0..4], &[1, 0, 0, 0]);
        data[4..36].copy_from_slice(kp(&self.mint_authority).as_ref());
        let decimals = StateWithExtensions::<MintState>::unpack(&data)
            .unwrap()
            .base
            .decimals;
        let mint: Pubkey = SPYX_MINT.parse().unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                addr(&mint),
                Account {
                    lamports,
                    data,
                    owner: addr(&spl_token_2022::ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        TestMint {
            mint,
            token_program: spl_token_2022::ID,
            decimals,
        }
    }

    /// Simulates the issuer activating the (dormant) transfer hook on a mint.
    pub fn set_transfer_hook_program(&mut self, mint: &Pubkey, program: Pubkey) {
        let mut acct = self.svm.get_account(&addr(mint)).unwrap();
        {
            let mut state = StateWithExtensionsMut::<MintState>::unpack(&mut acct.data).unwrap();
            let hook = state.get_extension_mut::<TransferHook>().unwrap();
            hook.program_id = Some(program).try_into().unwrap();
        }
        self.svm.set_account(addr(mint), acct).unwrap();
    }

    /// Replaces the mint's permanent delegate (fixture only), to simulate issuer seizure.
    pub fn set_permanent_delegate(&mut self, mint: &Pubkey, delegate: Pubkey) {
        let mut acct = self.svm.get_account(&addr(mint)).unwrap();
        {
            let mut state = StateWithExtensionsMut::<MintState>::unpack(&mut acct.data).unwrap();
            let pd = state.get_extension_mut::<PermanentDelegate>().unwrap();
            pd.delegate = Some(delegate).try_into().unwrap();
        }
        self.svm.set_account(addr(mint), acct).unwrap();
    }

    /// Issuer uses its permanent delegate to pull `amount` out of `source`.
    pub fn seize(
        &mut self,
        delegate: &Keypair,
        m: TestMint,
        source: &Pubkey,
        amount: u64,
    ) -> Pubkey {
        let dest = ata(&kp(delegate), &m.mint, &m.token_program);
        let ixs = vec![
            conv!(create_associated_token_account(
                &kp(delegate),
                &kp(delegate),
                &m.mint,
                &m.token_program
            )),
            conv!(spl_token_2022::instruction::transfer_checked(
                &m.token_program,
                source,
                &m.mint,
                &dest,
                &kp(delegate),
                &[],
                amount,
                m.decimals
            )
            .unwrap()),
        ];
        assert_ok(self.send(&ixs, delegate, &[]));
        dest
    }

    pub fn mint_has_extension(&self, mint: &Pubkey, ext: ExtensionType) -> bool {
        let acct = self.svm.get_account(&addr(mint)).unwrap();
        StateWithExtensions::<MintState>::unpack(&acct.data)
            .unwrap()
            .get_extension_types()
            .unwrap()
            .contains(&ext)
    }

    /// Creates `owner`'s ATA if needed and mints `amount` into it.
    pub fn fund(&mut self, owner: &Keypair, m: TestMint, amount: u64) -> Pubkey {
        let account = ata(&kp(owner), &m.mint, &m.token_program);
        let payer = self.mint_authority.insecure_clone();
        let mut ixs = vec![];
        if !self.exists(&account) {
            ixs.push(conv!(create_associated_token_account(
                &kp(&payer),
                &kp(owner),
                &m.mint,
                &m.token_program
            )));
        }
        let authority = kp(&payer);
        ixs.push(if m.token_program == spl_token::ID {
            conv!(spl_token::instruction::mint_to_checked(
                &m.token_program,
                &m.mint,
                &account,
                &authority,
                &[],
                amount,
                m.decimals
            )
            .unwrap())
        } else {
            conv!(spl_token_2022::instruction::mint_to_checked(
                &m.token_program,
                &m.mint,
                &account,
                &authority,
                &[],
                amount,
                m.decimals
            )
            .unwrap())
        });
        assert_ok(self.send(&ixs, &payer, &[]));
        account
    }

    /// Wraps `lamports` SOL into `owner`'s wSOL ATA.
    pub fn fund_wsol(&mut self, owner: &Keypair, lamports: u64) -> (TestMint, Pubkey) {
        let m = TestMint {
            mint: spl_token::native_mint::ID,
            token_program: spl_token::ID,
            decimals: 9,
        };
        if !self.exists(&m.mint) {
            // LiteSVM does not pre-create the native mint account; mirror mainnet's.
            let mut data = vec![0u8; spl_token::state::Mint::LEN];
            spl_token::state::Mint {
                mint_authority: None.into(),
                supply: 0,
                decimals: 9,
                is_initialized: true,
                freeze_authority: None.into(),
            }
            .pack_into_slice(&mut data);
            let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
            self.svm
                .set_account(
                    addr(&m.mint),
                    Account {
                        lamports,
                        data,
                        owner: addr(&spl_token::ID),
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .unwrap();
        }
        let account = ata(&kp(owner), &m.mint, &m.token_program);
        let ixs = vec![
            conv!(create_associated_token_account(
                &kp(owner),
                &kp(owner),
                &m.mint,
                &m.token_program
            )),
            conv!(system_instruction::transfer(&kp(owner), &account, lamports)),
            conv!(spl_token::instruction::sync_native(&m.token_program, &account).unwrap()),
        ];
        assert_ok(self.send(&ixs, owner, &[]));
        (m, account)
    }

    // ---------- escrow flows ----------

    pub fn deposit_ix(
        &self,
        donor: &Pubkey,
        m: TestMint,
        repo_id: u64,
        index: u64,
        amount: u64,
    ) -> Instruction {
        let deposit = deposit_pda(repo_id, index);
        program_ix(
            ix_accounts::MakeDeposit {
                donor: *donor,
                config: config_pda(),
                allowed_mint: allowed_mint_pda(&m.mint),
                mint: m.mint,
                donor_token_account: ata(donor, &m.mint, &m.token_program),
                repo_vault: repo_pda(repo_id),
                deposit,
                deposit_vault: vault_pda(&deposit),
                token_program: m.token_program,
                system_program: anchor_lang::system_program::ID,
            },
            ix_data::Deposit {
                repo_id,
                deposit_index: index,
                amount,
            },
        )
    }

    pub fn next_index(&self, repo_id: u64) -> u64 {
        if self.exists(&repo_pda(repo_id)) {
            self.repo(repo_id).deposit_count
        } else {
            0
        }
    }

    pub fn deposit_with(
        &mut self,
        donor: &Keypair,
        m: TestMint,
        repo_id: u64,
        amount: u64,
    ) -> TransactionResult {
        let index = self.next_index(repo_id);
        let ix = self.deposit_ix(&kp(donor), m, repo_id, index, amount);
        self.send(&[ix], donor, &[])
    }

    /// Funds a fresh donor and deposits; returns (donor, deposit index).
    pub fn donate(&mut self, m: TestMint, repo_id: u64, amount: u64) -> (Keypair, u64) {
        let donor = self.new_funded();
        self.fund(&donor, m, amount);
        let index = self.next_index(repo_id);
        assert_ok(self.deposit_with(&donor, m, repo_id, amount));
        self.deposit(repo_id, index);
        (donor, index)
    }

    pub fn attestation_ix(&self, signer: &Keypair, message: &[u8]) -> Instruction {
        ed25519_ix(signer, message)
    }

    pub fn release_ix(
        &self,
        payer: &Pubkey,
        repo_id: u64,
        index: u64,
        recipient: &Pubkey,
        expiry: i64,
        nonce: u64,
    ) -> Instruction {
        let d = self.deposit_meta(repo_id, index);
        let deposit = deposit_pda(repo_id, index);
        program_ix(
            ix_accounts::Release {
                payer: *payer,
                config: config_pda(),
                repo_vault: repo_pda(repo_id),
                deposit,
                deposit_vault: d.vault,
                mint: d.mint,
                recipient: *recipient,
                recipient_token_account: ata(recipient, &d.mint, &d.token_program),
                donor: d.donor,
                instructions_sysvar: solana_sdk_ids::sysvar::instructions::ID,
                token_program: d.token_program,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
            },
            ix_data::Release {
                repo_id,
                expiry,
                nonce,
            },
        )
    }

    /// Release with an attestation signed by `signer` over the given fields.
    #[allow(clippy::too_many_arguments)]
    pub fn release_signed(
        &mut self,
        signer: &Keypair,
        repo_id: u64,
        index: u64,
        attested_repo: u64,
        attested_recipient: &Pubkey,
        actual_recipient: &Pubkey,
        expiry: i64,
        nonce: u64,
    ) -> TransactionResult {
        let msg = attestation_message(
            &PROGRAM_ID,
            attested_repo,
            attested_recipient,
            expiry,
            nonce,
        );
        let payer = self.new_funded();
        let ixs = vec![
            self.attestation_ix(signer, &msg),
            self.release_ix(&kp(&payer), repo_id, index, actual_recipient, expiry, nonce),
        ];
        self.send(&ixs, &payer, &[])
    }

    /// The happy path: verifier attests `recipient` for `repo_id`.
    pub fn release(
        &mut self,
        repo_id: u64,
        index: u64,
        recipient: &Pubkey,
        nonce: u64,
    ) -> TransactionResult {
        let verifier = self.verifier.insecure_clone();
        let expiry = self.now() + 600;
        self.release_signed(
            &verifier, repo_id, index, repo_id, recipient, recipient, expiry, nonce,
        )
    }

    pub fn refund_ix(&self, signer: &Pubkey, repo_id: u64, index: u64) -> Instruction {
        let d = self.deposit_meta(repo_id, index);
        program_ix(
            ix_accounts::Refund {
                donor: *signer,
                config: config_pda(),
                repo_vault: repo_pda(repo_id),
                deposit: deposit_pda(repo_id, index),
                deposit_vault: d.vault,
                mint: d.mint,
                donor_token_account: ata(signer, &d.mint, &d.token_program),
                token_program: d.token_program,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
            },
            ix_data::Refund {},
        )
    }

    pub fn refund(&mut self, signer: &Keypair, repo_id: u64, index: u64) -> TransactionResult {
        let ix = self.refund_ix(&kp(signer), repo_id, index);
        self.send(&[ix], signer, &[])
    }
}

/// Ed25519SigVerify instruction with a single self-contained signature.
pub fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
    let signature = signer.sign_message(message);
    let pubkey = signer.pubkey().to_bytes();
    let header = 2 + 14;
    let pubkey_offset = header;
    let sig_offset = pubkey_offset + 32;
    let msg_offset = sig_offset + 64;
    let mut data = vec![1u8, 0u8];
    for v in [
        sig_offset as u16,
        u16::MAX,
        pubkey_offset as u16,
        u16::MAX,
        msg_offset as u16,
        message.len() as u16,
        u16::MAX,
    ] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    data.extend_from_slice(&pubkey);
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);
    Instruction {
        program_id: addr(&solana_sdk_ids::ed25519_program::ID),
        accounts: vec![],
        data,
    }
}
