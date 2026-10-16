// Offline, unsigned LiteSVM execution of repo.ing's exact messages against pinned production ELFs.
// Copy to programs/tests/examples/repoing_curve_runtime.rs in the frozen Hook Lab checkout.
use anchor_lang::prelude::{Clock, Pubkey};
use bordrless_program_tests::program_bytes;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_hash::Hash;
use solana_message::{
    compiled_instruction::CompiledInstruction, v0, MessageHeader, VersionedMessage,
};
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;
use std::{env, fs, str::FromStr};

fn unhex(text: &str) -> Vec<u8> {
    assert_eq!(text.len() % 2, 0);
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let input = fs::read_to_string(env::args().nth(1).expect("fixture TSV required")).unwrap();
    let mut svm = LiteSVM::new()
        .with_sigverify(false)
        .with_blockhash_check(false)
        .with_transaction_history(0);
    for (name, id) in [
        ("bordrless_token", bordrless_token::ID),
        ("bordrless_swap", bordrless_swap::ID),
        ("bordrless_launch", bordrless_launch::ID),
    ] {
        svm.add_program(id, &program_bytes(name)).unwrap();
    }
    let mut clock: Clock = svm.get_sysvar();
    clock.slot = 104;
    clock.unix_timestamp = 2000;
    svm.set_sysvar(&clock);
    let mut payer = Pubkey::default();
    let mut blockhash = Hash::default();
    let mut accounts = Vec::new();
    let mut wire = v0::Message::default();
    let mut expected_message = Vec::new();
    let mut success = true;
    let mut step = 0;
    for line in input.lines() {
        let p: Vec<_> = line.split('\t').collect();
        match p[0] {
            "CONTEXT" => {
                payer = Pubkey::from_str(p[1]).unwrap();
                blockhash = Hash::from_str(p[2]).unwrap();
                svm.set_account(
                    payer,
                    Account {
                        lamports: 50_000_000,
                        ..Account::default()
                    },
                )
                .unwrap();
            }
            "ACCOUNT" => {
                let key = Pubkey::from_str(p[2]).unwrap();
                svm.set_account(
                    key,
                    Account {
                        owner: Pubkey::from_str(p[3]).unwrap(),
                        lamports: 50_000_000,
                        data: unhex(p[4]),
                        executable: false,
                        // These fixtures are rent-exempt; use the runtime's exempt epoch sentinel.
                        rent_epoch: u64::MAX,
                    },
                )
                .unwrap();
                accounts.push((p[1].to_string(), key));
            }
            "STEP" => {
                success = p[1] == "ok";
                expected_message = unhex(p[2]);
                wire = v0::Message {
                    recent_blockhash: blockhash,
                    ..v0::Message::default()
                };
            }
            "HEADER" => {
                wire.header = MessageHeader {
                    num_required_signatures: p[1].parse().unwrap(),
                    num_readonly_signed_accounts: p[2].parse().unwrap(),
                    num_readonly_unsigned_accounts: p[3].parse().unwrap(),
                }
            }
            "KEY" => wire.account_keys.push(Pubkey::from_str(p[1]).unwrap()),
            "IX" => wire.instructions.push(CompiledInstruction {
                program_id_index: p[1].parse().unwrap(),
                accounts: unhex(p[2]),
                data: unhex(p[3]),
            }),
            "END" => {
                // Preserve the JS compiler's exact account order, not the Rust compiler's different ordering.
                let message = VersionedMessage::V0(wire.clone());
                assert_eq!(
                    message.serialize(),
                    expected_message,
                    "TS message transport drift"
                );
                let before: Vec<_> = accounts
                    .iter()
                    .map(|(_, key)| svm.get_account(key).unwrap())
                    .collect();
                let native_before = svm.get_account(&payer).unwrap().lamports;
                let tx = VersionedTransaction {
                    signatures: vec![
                        Signature::default();
                        message.header().num_required_signatures as usize
                    ],
                    message,
                };
                let result = svm.send_transaction(tx);
                assert_eq!(result.is_ok(), success, "unexpected outcome: {result:?}");
                let cu = match result {
                    Ok(m) => m.compute_units_consumed,
                    Err(e) => e.meta.compute_units_consumed,
                };
                let native_after = svm.get_account(&payer).unwrap().lamports;
                println!(
                    "RESULT\t{step}\t{}\t{cu}\t{native_before}\t{native_after}",
                    if success { "ok" } else { "refused" }
                );
                for ((role, key), pre) in accounts.iter().zip(before.iter()) {
                    let post = svm.get_account(key).unwrap();
                    assert_eq!(
                        (post.owner, post.lamports, post.executable, post.rent_epoch),
                        (pre.owner, pre.lamports, pre.executable, pre.rent_epoch),
                        "unexpected metadata/native debit for {role}"
                    );
                    if !success {
                        assert_eq!(pre, &post, "failed instruction changed {role}");
                    }
                    println!(
                        "STATE\t{step}\t{role}\t{}\t{}",
                        hex(&pre.data),
                        hex(&post.data)
                    );
                }
                step += 1;
            }
            _ => panic!("unknown input record"),
        }
    }
    assert!(step > 0);
}
