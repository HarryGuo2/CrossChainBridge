use anchor_lang::prelude::*;

use crate::errors::BridgeError;
use crate::state::BridgeConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetSourceBindingArgs {
    pub source_chain_id: u16,
    pub source_bridge: [u8; 20],
    pub source_token: [u8; 20],
}

#[derive(Accounts)]
pub struct SetSourceBinding<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = config.config_bump,
    )]
    pub config: Account<'info, BridgeConfig>,
}

pub fn handler(ctx: Context<SetSourceBinding>, args: SetSourceBindingArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.admin == ctx.accounts.admin.key(), BridgeError::UnauthorizedAdmin);
    config.source_chain_id = args.source_chain_id;
    config.source_bridge = args.source_bridge;
    config.source_token = args.source_token;
    Ok(())
}
