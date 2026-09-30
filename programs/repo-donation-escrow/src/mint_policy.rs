//! Which mints the escrow can safely custody.
//!
//! Evaluated both when a mint is allowlisted and on every deposit, because
//! Token-2022 authorities can change some extension state after admission
//! (e.g. an issuer can point a dormant TransferHook at a program later; the
//! xStocks mints ship with exactly such a dormant hook).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::spl_token_2022::{
    extension::{
        permanent_delegate::PermanentDelegate, transfer_hook::TransferHook,
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::Mint as MintState,
};

use crate::errors::EscrowError;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MintProfile {
    pub has_transfer_fee: bool,
    pub has_permanent_delegate: bool,
    pub has_freeze_authority: bool,
}

/// True if the mint carries a TransferFeeConfig (fees may be withheld in our vault).
pub fn mint_has_transfer_fee(mint_info: &AccountInfo) -> Result<bool> {
    let data = mint_info.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)?;
    Ok(state
        .get_extension_types()?
        .contains(&ExtensionType::TransferFeeConfig))
}

/// Inspects a mint account (legacy SPL Token or Token-2022) and rejects anything
/// the escrow cannot custody safely. Unknown extensions are rejected by default.
pub fn evaluate_mint(
    mint_info: &AccountInfo,
    allow_permanent_delegate: bool,
) -> Result<MintProfile> {
    let data = mint_info.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)?;
    let mut profile = MintProfile {
        has_freeze_authority: state.base.freeze_authority.is_some(),
        ..MintProfile::default()
    };

    // Legacy SPL Token mints have no TLV data, so this is empty for them.
    for ext in state.get_extension_types()? {
        match ext {
            ExtensionType::TransferFeeConfig => profile.has_transfer_fee = true,
            ExtensionType::TransferHook => {
                let hook = state.get_extension::<TransferHook>()?;
                let program: Option<Pubkey> = hook.program_id.into();
                require!(program.is_none(), EscrowError::TransferHookNotSupported);
            }
            ExtensionType::PermanentDelegate => {
                let pd = state.get_extension::<PermanentDelegate>()?;
                let delegate: Option<Pubkey> = pd.delegate.into();
                if delegate.is_some() {
                    require!(
                        allow_permanent_delegate,
                        EscrowError::PermanentDelegateNotAllowed
                    );
                    profile.has_permanent_delegate = true;
                }
            }
            ExtensionType::NonTransferable => return err!(EscrowError::NonTransferableMint),
            // Benign for custody: they affect display, metadata, confidential balances
            // we never opt into, default state of new accounts, or pausing (which only
            // delays settlement; the refund right has no deadline).
            ExtensionType::MintCloseAuthority
            | ExtensionType::ConfidentialTransferMint
            | ExtensionType::ConfidentialTransferFeeConfig
            | ExtensionType::DefaultAccountState
            | ExtensionType::InterestBearingConfig
            | ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::GroupPointer
            | ExtensionType::TokenGroup
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroupMember
            | ExtensionType::ScaledUiAmount
            | ExtensionType::Pausable => {}
            _ => return err!(EscrowError::UnsupportedMintExtension),
        }
    }
    Ok(profile)
}
