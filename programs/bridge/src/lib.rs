use anchor_lang::prelude::*;

pub mod errors;
pub mod payload;
pub mod state;
pub mod instructions;

use instructions::*;
use payload::BridgePayload;

declare_id!("FaWcnbmoyN1SWfUaio4cJAC2HokPgukzKhhk1hZrh4De");

#[program]
pub mod bridge {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::handler(ctx, paused)
    }

    pub fn set_relayer(ctx: Context<SetRelayer>, new_relayer: Pubkey) -> Result<()> {
        instructions::set_relayer::handler(ctx, new_relayer)
    }

    pub fn mint_wrapped(ctx: Context<MintWrapped>, payload: BridgePayload) -> Result<()> {
        instructions::mint_wrapped::handler(ctx, payload)
    }
}
