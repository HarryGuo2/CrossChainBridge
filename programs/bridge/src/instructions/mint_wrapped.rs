use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use anchor_spl::associated_token::get_associated_token_address;

use crate::errors::BridgeError;
use crate::payload::BridgePayload;
use crate::state::{BridgeConfig, ProcessedMessage};

#[derive(Accounts)]
#[instruction(payload: BridgePayload)]
pub struct MintWrapped<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        seeds = [BridgeConfig::SEED],
        bump = config.config_bump,
    )]
    pub config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = relayer,
        space = 8 + ProcessedMessage::SIZE,
        seeds = [
            ProcessedMessage::SEED,
            &payload.source_chain_id.to_le_bytes(),
            payload.source_bridge.as_ref(),
            &payload.nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub processed_message: Account<'info, ProcessedMessage>,

    #[account(mut)]
    pub wrapped_mint: Account<'info, Mint>,

    /// CHECK: PDA-only authority for mint_to CPI.
    #[account(
        seeds = [BridgeConfig::MINT_AUTHORITY_SEED],
        bump = config.mint_authority_bump,
    )]
    pub mint_authority: AccountInfo<'info>,

    /// CHECK: Wallet that owns the destination ATA. Verified against payload.
    pub recipient: AccountInfo<'info>,

    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MintWrapped>, payload: BridgePayload) -> Result<()> {
    let cfg = &ctx.accounts.config;

    // Pause + auth.
    require!(!cfg.paused, BridgeError::Paused);
    require!(ctx.accounts.relayer.key() == cfg.authorized_relayer, BridgeError::UnauthorizedRelayer);

    // Payload version + source-binding.
    require!(payload.version == 1, BridgeError::UnsupportedVersion);
    require!(payload.source_chain_id == cfg.source_chain_id, BridgeError::InvalidSource);
    require!(payload.source_bridge == cfg.source_bridge, BridgeError::InvalidSource);
    require!(payload.source_token == cfg.source_token, BridgeError::InvalidSource);

    // Sanity.
    require!(payload.amount > 0, BridgeError::ZeroAmount);

    // Mint identity.
    require!(ctx.accounts.wrapped_mint.key() == cfg.wrapped_mint, BridgeError::WrongMint);

    // Recipient consistency: ATA derivation first (using payload), then recipient match.
    let recipient_pubkey = Pubkey::new_from_array(payload.recipient_sol);
    let expected_ata = get_associated_token_address(&recipient_pubkey, &ctx.accounts.wrapped_mint.key());
    require!(ctx.accounts.recipient_token_account.key() == expected_ata, BridgeError::InvalidRecipientAta);
    require!(ctx.accounts.recipient.key() == recipient_pubkey, BridgeError::RecipientMismatch);

    let bump = cfg.mint_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[BridgeConfig::MINT_AUTHORITY_SEED, &[bump]]];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        ),
        payload.amount,
    )?;

    let pm = &mut ctx.accounts.processed_message;
    pm.nonce = payload.nonce;
    pm.source_tx_hash = payload.source_tx_hash;
    pm.source_log_index = payload.source_log_index;
    pm.amount = payload.amount;
    pm.recipient = recipient_pubkey;
    pm.processed_slot = Clock::get()?.slot;

    Ok(())
}
