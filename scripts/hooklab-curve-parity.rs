// Offline adapter for the actual frozen Hook Lab Rust builder. No RPC, keypair or signing.
// Copy into programs/bordrless_launch/examples/repoing_curve_parity.rs in the pinned checkout;
// build with cargo build -p bordrless-launch --features production --example repoing_curve_parity --locked.
use anchor_lang::prelude::Pubkey;
use bordrless_launch::client::{swap, LaunchKeys};
use std::{env, str::FromStr};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    assert_eq!(
        args.len(),
        6,
        "mint trader recipient direction amount minimum"
    );
    let keys = LaunchKeys {
        mint: Pubkey::from_str(&args[0]).unwrap(),
        quote_mint: Pubkey::from_str("A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i").unwrap(),
        lp_fee_bps: 0,
        modules: 0,
        burns: false,
        custom_hook: None,
    };
    let ix = swap(
        &keys,
        Pubkey::from_str(&args[1]).unwrap(),
        Pubkey::from_str(&args[2]).unwrap(),
        args[3].parse().unwrap(),
        args[4].parse().unwrap(),
        args[5].parse().unwrap(),
    );
    let data: String = ix.data.iter().map(|b| format!("{b:02x}")).collect();
    let metas: Vec<String> = ix
        .accounts
        .iter()
        .map(|a| {
            format!(
                "{{\"address\":\"{}\",\"signer\":{},\"writable\":{}}}",
                a.pubkey, a.is_signer, a.is_writable
            )
        })
        .collect();
    println!(
        "{{\"programId\":\"{}\",\"dataHex\":\"{}\",\"accounts\":[{}]}}",
        ix.program_id,
        data,
        metas.join(",")
    );
}
