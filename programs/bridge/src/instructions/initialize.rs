use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::state::BridgeConfig;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub authorized_relayer: Pubkey,
    pub source_chain_id: u16,
    pub source_bridge: [u8; 20],
    pub source_token: [u8; 20],
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + BridgeConfig::SIZE,
        seeds = [BridgeConfig::SEED],
        bump,
    )]
    pub config: Account<'info, BridgeConfig>,

    pub wrapped_mint: Account<'info, Mint>,

    /// CHECK: PDA used as mint authority; not deserialized.
    #[account(
        seeds = [BridgeConfig::MINT_AUTHORITY_SEED],
        bump,
    )]
    pub mint_authority: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.authorized_relayer = args.authorized_relayer;
    config.source_chain_id = args.source_chain_id;
    config.source_bridge = args.source_bridge;
    config.source_token = args.source_token;
    config.wrapped_mint = ctx.accounts.wrapped_mint.key();
    config.mint_authority_bump = ctx.bumps.mint_authority;
    config.config_bump = ctx.bumps.config;
    config.paused = false;
    Ok(())
}
