use anchor_lang::prelude::*;

#[account]
pub struct BridgeConfig {
    pub admin: Pubkey,                   // 32
    pub authorized_relayer: Pubkey,      // 32
    pub source_chain_id: u16,            //  2
    pub source_bridge: [u8; 20],         // 20
    pub source_token: [u8; 20],          // 20
    pub wrapped_mint: Pubkey,            // 32
    pub mint_authority_bump: u8,         //  1
    pub config_bump: u8,                 //  1
    pub paused: bool,                    //  1
}

impl BridgeConfig {
    pub const SIZE: usize = 32 + 32 + 2 + 20 + 20 + 32 + 1 + 1 + 1; // = 141
    pub const SEED: &'static [u8] = b"config";
    pub const MINT_AUTHORITY_SEED: &'static [u8] = b"mint_authority";
}

#[account]
pub struct ProcessedMessage {
    pub nonce: u64,                      //  8
    pub source_tx_hash: [u8; 32],        // 32
    pub source_log_index: u32,           //  4
    pub amount: u64,                     //  8
    pub recipient: Pubkey,               // 32
    pub processed_slot: u64,             //  8
}

impl ProcessedMessage {
    pub const SIZE: usize = 8 + 32 + 4 + 8 + 32 + 8; // = 92
    pub const SEED: &'static [u8] = b"processed";
}
