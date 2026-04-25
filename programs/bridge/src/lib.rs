use anchor_lang::prelude::*;

pub mod errors;
pub mod payload;
pub mod state;
pub mod instructions;

use instructions::*;

declare_id!("FaWcnbmoyN1SWfUaio4cJAC2HokPgukzKhhk1hZrh4De");

#[program]
pub mod bridge {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }
}
