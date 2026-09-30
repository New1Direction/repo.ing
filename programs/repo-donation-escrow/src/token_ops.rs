use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    close_account, harvest_withheld_tokens_to_mint, transfer_checked, CloseAccount,
    HarvestWithheldTokensToMint, TransferChecked,
};

use crate::{constants::DEPOSIT_SEED, mint_policy::mint_has_transfer_fee, state::Deposit};

/// Everything needed to empty a deposit's vault to `destination` and close it.
pub struct Payout<'a, 'info> {
    pub deposit: &'a Account<'info, Deposit>,
    pub vault: AccountInfo<'info>,
    pub vault_balance: u64,
    pub mint: AccountInfo<'info>,
    pub decimals: u8,
    pub destination: AccountInfo<'info>,
    pub rent_destination: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

/// Transfers the vault's entire balance (whatever is actually there: it may be less
/// than recorded if a permanent delegate intervened, or more if someone sent extra)
/// and closes the vault, returning its rent to `rent_destination` (always the donor).
/// Returns the amount that left the vault.
pub fn pay_out_and_close(p: Payout) -> Result<u64> {
    let repo_id = p.deposit.repo_id.to_le_bytes();
    let index = p.deposit.index.to_le_bytes();
    let bump = [p.deposit.bump];
    let seeds: &[&[u8]] = &[DEPOSIT_SEED, &repo_id, &index, &bump];
    let signer = &[seeds];
    let authority = p.deposit.to_account_info();
    let program_id = p.token_program.key();

    if p.vault_balance > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                program_id,
                TransferChecked {
                    from: p.vault.clone(),
                    mint: p.mint.clone(),
                    to: p.destination.clone(),
                    authority: authority.clone(),
                },
                signer,
            ),
            p.vault_balance,
            p.decimals,
        )?;
    }

    // Token-2022 close requires a zero balance, zero withheld fees and zero confidential
    // balances. Our vaults never configure ConfidentialTransferAccount (Anchor only adds the
    // mint's *required* account extensions), so only withheld fees need handling here.
    // Token-2022 withholds inbound transfer fees *in the destination account*, and an
    // account with withheld fees cannot be closed. Harvesting to the mint is permissionless.
    if mint_has_transfer_fee(&p.mint)? {
        harvest_withheld_tokens_to_mint(
            CpiContext::new(
                program_id,
                HarvestWithheldTokensToMint {
                    token_program_id: p.token_program.clone(),
                    mint: p.mint.clone(),
                },
            ),
            vec![p.vault.clone()],
        )?;
    }

    close_account(CpiContext::new_with_signer(
        program_id,
        CloseAccount {
            account: p.vault,
            destination: p.rent_destination,
            authority,
        },
        signer,
    ))?;

    Ok(p.vault_balance)
}
