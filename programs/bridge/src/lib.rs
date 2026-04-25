use anchor_lang::prelude::*;

pub mod errors;
pub mod payload;
pub mod state;

declare_id!("FaWcnbmoyN1SWfUaio4cJAC2HokPgukzKhhk1hZrh4De");

#[program]
pub mod bridge {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
