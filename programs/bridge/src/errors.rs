use anchor_lang::prelude::*;

#[error_code]
pub enum BridgeError {
    #[msg("Bridge is paused")]
    Paused,
    #[msg("Signer is not the authorized relayer")]
    UnauthorizedRelayer,
    #[msg("Signer is not the admin")]
    UnauthorizedAdmin,
    #[msg("Unsupported payload version")]
    UnsupportedVersion,
    #[msg("Source domain mismatch")]
    InvalidSource,
    #[msg("Amount must be non-zero")]
    ZeroAmount,
    #[msg("Wrapped mint does not match configured mint")]
    WrongMint,
    #[msg("Recipient ATA does not match")]
    InvalidRecipientAta,
    #[msg("Recipient pubkey does not match payload")]
    RecipientMismatch,
    #[msg("Mint authority not transferred to bridge PDA")]
    MintAuthorityNotTransferred,
}
