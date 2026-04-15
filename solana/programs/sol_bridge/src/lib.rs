use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Burn};

declare_id!("HV11QLUsejCfagzrgWnvK9DSA4A46s1bEgXzT4R67enp");

/// Maximum number of relayers in the committee
const MAX_RELAYERS: usize = 10;

#[program]
pub mod sol_bridge {
    use super::*;

    // ── Initialise bridge state ───────────────────────────────────────────────

    /// Called once by the deployer to create the bridge config PDA.
    pub fn initialize(
        ctx: Context<Initialize>,
        relayers: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        require!(relayers.len() > 0, BridgeError::NoRelayers);
        require!(
            threshold > 0 && threshold as usize <= relayers.len(),
            BridgeError::BadThreshold
        );
        require!(relayers.len() <= MAX_RELAYERS, BridgeError::TooManyRelayers);

        let state = &mut ctx.accounts.bridge_state;
        state.authority = ctx.accounts.authority.key();
        state.threshold = threshold;
        state.relayers = relayers;
        state.bump = ctx.bumps.bridge_state;
        Ok(())
    }

    // ── Mint wrapped tokens (Ethereum → Solana) ───────────────────────────────

    /// Called by a relayer after detecting a `TokensLocked` event on Ethereum.
    /// Each relayer calls this independently; tokens are minted once the
    /// threshold is reached.
    ///
    /// # Arguments
    /// * `eth_tx_hash`  – keccak256 hash of the Ethereum lock transaction
    /// * `recipient`    – Solana token account to receive wrapped tokens
    /// * `amount`       – Amount to mint (in lamports / token base units)
    /// * `eth_nonce`    – Nonce from the `TokensLocked` event (replay guard)
    pub fn submit_mint(
        ctx: Context<SubmitMint>,
        eth_tx_hash: [u8; 32],
        amount: u64,
        eth_nonce: u64,
    ) -> Result<()> {
        let state = &ctx.accounts.bridge_state;
        let relayer = ctx.accounts.relayer.key();

        // Verify caller is a registered relayer
        require!(
            state.relayers.contains(&relayer),
            BridgeError::NotARelayer
        );

        let pending = &mut ctx.accounts.pending_mint;

        // Initialise on first call
        if pending.signature_count == 0 {
            pending.eth_tx_hash = eth_tx_hash;
            pending.recipient = ctx.accounts.recipient_token_account.key();
            pending.amount = amount;
            pending.eth_nonce = eth_nonce;
            pending.executed = false;
            pending.bump = ctx.bumps.pending_mint;
        }

        // Idempotency: ignore duplicate submissions from the same relayer
        require!(
            !pending.signers.contains(&relayer),
            BridgeError::AlreadySigned
        );
        require!(!pending.executed, BridgeError::AlreadyExecuted);

        pending.signers.push(relayer);
        pending.signature_count += 1;

        // Reached threshold → mint
        if pending.signature_count >= state.threshold {
            pending.executed = true;

            let seeds: &[&[u8]] = &[
                b"bridge_state",
                &[state.bump],
            ];
            let signer_seeds = &[seeds];

            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.wrapped_mint.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.bridge_state.to_account_info(),
                },
                signer_seeds,
            );
            token::mint_to(cpi_ctx, amount)?;

            emit!(MintedEvent {
                eth_tx_hash,
                recipient: ctx.accounts.recipient_token_account.key(),
                amount,
                eth_nonce,
            });
        }
        Ok(())
    }

    // ── Burn wrapped tokens (Solana → Ethereum) ───────────────────────────────

    /// Called by a user who wants to redeem wrapped tokens back on Ethereum.
    /// Burns the SPL tokens and emits a `BurnedEvent` that relayers watch.
    ///
    /// # Arguments
    /// * `amount`      – Amount of wrapped tokens to burn
    /// * `eth_recipient` – Ethereum address (20 bytes, right-padded to 32)
    pub fn burn_tokens(
        ctx: Context<BurnTokens>,
        amount: u64,
        eth_recipient: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, BridgeError::ZeroAmount);

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.wrapped_mint.to_account_info(),
                from: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::burn(cpi_ctx, amount)?;

        emit!(BurnedEvent {
            user: ctx.accounts.user.key(),
            eth_recipient,
            amount,
        });
        Ok(())
    }
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = BridgeState::LEN,
        seeds = [b"bridge_state"],
        bump
    )]
    pub bridge_state: Account<'info, BridgeState>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(eth_tx_hash: [u8; 32], amount: u64, eth_nonce: u64)]
pub struct SubmitMint<'info> {
    #[account(seeds = [b"bridge_state"], bump = bridge_state.bump)]
    pub bridge_state: Account<'info, BridgeState>,

    #[account(
        init_if_needed,
        payer = relayer,
        space = PendingMint::LEN,
        seeds = [b"pending_mint", &eth_tx_hash],
        bump
    )]
    pub pending_mint: Account<'info, PendingMint>,

    /// CHECK: Bridge PDA is the mint authority; validated via seeds
    #[account(mut, mint::authority = bridge_state)]
    pub wrapped_mint: Account<'info, Mint>,

    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub relayer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BurnTokens<'info> {
    #[account(seeds = [b"bridge_state"], bump = bridge_state.bump)]
    pub bridge_state: Account<'info, BridgeState>,

    #[account(mut)]
    pub wrapped_mint: Account<'info, Mint>,

    #[account(mut, token::authority = user)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ── On-chain state ───────────────────────────────────────────────────────────

#[account]
pub struct BridgeState {
    pub authority: Pubkey,    // 32
    pub threshold: u8,        //  1
    pub relayers: Vec<Pubkey>,// 4 + 32 * MAX_RELAYERS
    pub bump: u8,             //  1
}

impl BridgeState {
    pub const LEN: usize = 8 + 32 + 1 + (4 + 32 * MAX_RELAYERS) + 1;
}

#[account]
pub struct PendingMint {
    pub eth_tx_hash: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
    pub eth_nonce: u64,
    pub signers: Vec<Pubkey>,    // relayers who have signed
    pub signature_count: u8,
    pub executed: bool,
    pub bump: u8,
}

impl PendingMint {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + (4 + 32 * MAX_RELAYERS) + 1 + 1 + 1;
}

// ── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct MintedEvent {
    pub eth_tx_hash: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
    pub eth_nonce: u64,
}

#[event]
pub struct BurnedEvent {
    pub user: Pubkey,
    pub eth_recipient: [u8; 32],
    pub amount: u64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum BridgeError {
    #[msg("No relayers provided")]
    NoRelayers,
    #[msg("Threshold must be > 0 and <= number of relayers")]
    BadThreshold,
    #[msg("Exceeded maximum relayer count")]
    TooManyRelayers,
    #[msg("Caller is not a registered relayer")]
    NotARelayer,
    #[msg("This relayer has already signed")]
    AlreadySigned,
    #[msg("This mint has already been executed")]
    AlreadyExecuted,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
}
