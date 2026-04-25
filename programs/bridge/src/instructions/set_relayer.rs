use anchor_lang::prelude::*;

use crate::errors::BridgeError;
use crate::state::BridgeConfig;

#[derive(Accounts)]
pub struct SetRelayer<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = config.config_bump,
    )]
    pub config: Account<'info, BridgeConfig>,
}

pub fn handler(ctx: Context<SetRelayer>, new_relayer: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.admin == ctx.accounts.admin.key(), BridgeError::UnauthorizedAdmin);
    config.authorized_relayer = new_relayer;
    Ok(())
}
