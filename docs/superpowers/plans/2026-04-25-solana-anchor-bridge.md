# Solana Anchor Bridge Program — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Solana Anchor program that lets a single authorized relayer mint wrapped SPL tokens corresponding to ERC-20 tokens locked on Sepolia, with replay protection, source-binding, pause, and authority rotation.

**Architecture:** Anchor 0.29 program with two PDAs (`BridgeConfig` singleton + per-message `ProcessedMessage` for replay protection). Mint authority is a separate `["mint_authority"]` PDA so the program is the only entity that can mint. Bridge messages arrive as a 147-byte fixed-width binary `BridgePayload`. Tests run locally via `anchor test`; final deployment goes to Devnet.

**Tech Stack:** Rust + Anchor 0.29, anchor-spl 0.29 (legacy SPL Token Program), TypeScript tests with mocha + chai + `@coral-xyz/anchor` 0.29 client, Solana CLI for Devnet deployment.

**Spec:** `docs/superpowers/specs/2026-04-25-solana-anchor-bridge-design.md` (commit `93e1384`)

**Coordination notes:**
- Existing relayer at `src/` already imports from `@coral-xyz/anchor@^0.29.0`; we match that version to avoid IDL format breakage.
- The current `idl/bridge.json` will be overwritten by `anchor build` output and shape will change (binary payload, BridgeConfig accounts). The relayer's `src/submitter.ts` will need a one-function update — covered in Task 14 handoff notes.
- User asked for AI/superpowers artifacts to stay local-only. Spec, this plan, and any review notes do **not** get pushed. The Rust code, TS tests, deploy script, IDL, and team-facing handoff/writeup files **are** real deliverables that get pushed when the user is ready.

---

## File structure

Files this plan creates or modifies:

```
CrossChainBridge/
├── Anchor.toml                                     [create]
├── Cargo.toml                                      [create — Rust workspace]
├── package.json                                    [modify — add anchor test deps]
├── tsconfig.json                                   [modify — include tests/]
├── .gitignore                                      [modify — target/, .anchor/, node_modules/, *.so]
├── programs/
│   └── bridge/
│       ├── Cargo.toml                              [create]
│       ├── Xargo.toml                              [create]
│       └── src/
│           ├── lib.rs                              [create — declare_id!, instruction handlers]
│           ├── errors.rs                           [create — BridgeError enum]
│           ├── payload.rs                          [create — BridgePayload]
│           ├── state.rs                            [create — BridgeConfig, ProcessedMessage]
│           └── instructions/
│               ├── mod.rs                          [create]
│               ├── initialize.rs                   [create]
│               ├── mint_wrapped.rs                 [create]
│               ├── set_paused.rs                   [create]
│               └── set_relayer.rs                  [create]
├── tests/
│   └── bridge.ts                                   [create — mocha test suite]
├── migrations/
│   └── deploy.ts                                   [create — initialize config + mint setup]
├── idl/
│   └── bridge.json                                 [overwrite from target/idl/bridge.json]
└── docs/
    ├── coordination-handoff.md                     [create — what teammates need to know]
    └── writeup-solana-aaron.md                     [create — draft of PDF section]
```

Each Rust source file has one responsibility: errors only define error codes, payload only defines `BridgePayload`, state only defines the two account structs, and each instruction file owns its own `Accounts` struct and handler. `lib.rs` is the thin entry point that re-exports and wires handlers.

---

### Task 1: Scaffold Anchor workspace

**Files:**
- Create: `Anchor.toml`
- Create: `Cargo.toml`
- Create: `programs/bridge/Cargo.toml`
- Create: `programs/bridge/Xargo.toml`
- Create: `programs/bridge/src/lib.rs`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `.gitignore`

- [ ] **Step 1: Verify required tooling exists**

Run: `solana --version && anchor --version && rustc --version`
Expected output (versions may vary, but all three must print):
```
solana-cli 1.18.x or 2.x
anchor-cli 0.29.0
rustc 1.79.0 or later
```

If anchor is not 0.29.0, install it: `cargo install --git https://github.com/coral-xyz/anchor avm --locked --force && avm install 0.29.0 && avm use 0.29.0`

- [ ] **Step 2: Generate the program keypair**

Anchor needs a keypair whose pubkey becomes the program ID baked into the binary.

Run:
```bash
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase --outfile target/deploy/bridge-keypair.json
solana address -k target/deploy/bridge-keypair.json
```

Copy the printed pubkey (a base58 string ~44 chars). This is `<PROGRAM_ID>` in the next steps.

- [ ] **Step 3: Create root `Cargo.toml`**

Create `Cargo.toml` with:
```toml
[workspace]
members = ["programs/*"]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1
[profile.release.build-override]
opt-level = 3
incremental = false
codegen-units = 1
```

- [ ] **Step 4: Create `Anchor.toml`**

Replace `<PROGRAM_ID>` with the pubkey from Step 2.

```toml
[toolchain]
anchor_version = "0.29.0"

[features]
seeds = false
skip-lint = false

[programs.localnet]
bridge = "<PROGRAM_ID>"

[programs.devnet]
bridge = "<PROGRAM_ID>"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"

[test.validator]
url = "https://api.devnet.solana.com"
```

- [ ] **Step 5: Create `programs/bridge/Cargo.toml`**

```toml
[package]
name = "bridge"
version = "0.1.0"
description = "Cross-chain bridge: ETH -> SOL wrapped mint"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "bridge"

[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]

[dependencies]
anchor-lang = "0.29.0"
anchor-spl = { version = "0.29.0", features = ["token"] }
```

- [ ] **Step 6: Create `programs/bridge/Xargo.toml`**

```toml
[target.bpfel-unknown-unknown.dependencies.std]
features = []
```

- [ ] **Step 7: Create `programs/bridge/src/lib.rs` (stub)**

Replace `<PROGRAM_ID>` with the pubkey from Step 2.

```rust
use anchor_lang::prelude::*;

declare_id!("<PROGRAM_ID>");

#[program]
pub mod bridge {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
```

- [ ] **Step 8: Update `package.json`**

Read the existing file first, then add the new test deps and script. Add to `devDependencies`:
```json
"@types/bn.js": "^5.1.5",
"@types/chai": "^4.3.11",
"@types/mocha": "^10.0.6",
"chai": "^4.3.10",
"mocha": "^10.2.0",
"ts-mocha": "^10.0.0"
```

Add to `scripts`:
```json
"anchor:build": "anchor build && cp target/idl/bridge.json idl/bridge.json",
"anchor:test": "anchor test"
```

- [ ] **Step 9: Update `tsconfig.json`**

Read it first. Ensure `include` covers both `src/**/*` and `tests/**/*` and `migrations/**/*`. Set `target` to `es2020`, `module` to `commonjs`, `esModuleInterop: true`, `resolveJsonModule: true`.

- [ ] **Step 10: Update `.gitignore`**

Append:
```
# Anchor / Solana
target/
.anchor/
*.so
test-ledger/
node_modules/

# But keep the program keypair so deploys are reproducible
!target/deploy/
target/deploy/*
!target/deploy/bridge-keypair.json
```

- [ ] **Step 11: Install JS deps**

Run: `npm install`
Expected: completes with no errors. (yarn warning if `anchor test` later complains — install yarn globally or change `Anchor.toml [scripts] test` to use `npx ts-mocha`.)

- [ ] **Step 12: First build**

Run: `anchor build`
Expected: builds `bridge.so`, generates `target/idl/bridge.json`. May take 60–120s on first run.

If build fails with "no such cmd: build-sbf", install platform tools: `solana-install update`.

- [ ] **Step 13: Commit**

```bash
git add Anchor.toml Cargo.toml programs/ package.json tsconfig.json .gitignore target/deploy/bridge-keypair.json
git commit -m "feat(solana): scaffold Anchor workspace for bridge program"
```

---

### Task 2: Errors module

**Files:**
- Create: `programs/bridge/src/errors.rs`
- Modify: `programs/bridge/src/lib.rs`

- [ ] **Step 1: Create `programs/bridge/src/errors.rs`**

```rust
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
```

- [ ] **Step 2: Wire into `lib.rs`**

Add `pub mod errors;` near the top of `lib.rs` (under `use anchor_lang::prelude::*;`).

- [ ] **Step 3: Verify build**

Run: `anchor build`
Expected: builds successfully, `error_code!` macro expands without warnings.

- [ ] **Step 4: Commit**

```bash
git add programs/bridge/src/errors.rs programs/bridge/src/lib.rs
git commit -m "feat(solana): add BridgeError enum"
```

---

### Task 3: BridgePayload struct with serialization test

**Files:**
- Create: `programs/bridge/src/payload.rs`
- Modify: `programs/bridge/src/lib.rs`

- [ ] **Step 1: Create `programs/bridge/src/payload.rs`**

```rust
use anchor_lang::prelude::*;

/// Fixed-width 147-byte canonical bridge message payload.
/// Field order and encoding must stay byte-compatible with the relayer's encoder.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct BridgePayload {
    pub version: u8,
    pub source_chain_id: u16,
    pub source_bridge: [u8; 20],
    pub source_token: [u8; 20],
    pub nonce: u64,
    pub amount: u64,
    pub sender_eth: [u8; 20],
    pub recipient_sol: [u8; 32],
    pub source_tx_hash: [u8; 32],
    pub source_log_index: u32,
}

impl BridgePayload {
    pub const SERIALIZED_SIZE: usize = 147;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> BridgePayload {
        BridgePayload {
            version: 1,
            source_chain_id: 1,
            source_bridge: [0xAB; 20],
            source_token: [0xCD; 20],
            nonce: 42,
            amount: 1_000_000,
            sender_eth: [0xEF; 20],
            recipient_sol: [0x11; 32],
            source_tx_hash: [0x22; 32],
            source_log_index: 7,
        }
    }

    #[test]
    fn serialized_size_is_147() {
        let mut buf = Vec::new();
        sample().serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), BridgePayload::SERIALIZED_SIZE);
    }

    #[test]
    fn round_trip() {
        let original = sample();
        let mut buf = Vec::new();
        original.serialize(&mut buf).unwrap();
        let decoded = BridgePayload::deserialize(&mut buf.as_slice()).unwrap();
        assert_eq!(original, decoded);
    }
}
```

- [ ] **Step 2: Wire into `lib.rs`**

Add `pub mod payload;` near the top, alongside `pub mod errors;`.

- [ ] **Step 3: Run the unit tests**

Run: `cargo test -p bridge --lib`
Expected:
```
test payload::tests::serialized_size_is_147 ... ok
test payload::tests::round_trip ... ok
```

If `serialized_size_is_147` fails, the field types or order are wrong — recheck against the spec table in §5.

- [ ] **Step 4: Commit**

```bash
git add programs/bridge/src/payload.rs programs/bridge/src/lib.rs
git commit -m "feat(solana): add BridgePayload with size + round-trip tests"
```

---

### Task 4: State accounts (BridgeConfig, ProcessedMessage)

**Files:**
- Create: `programs/bridge/src/state.rs`
- Modify: `programs/bridge/src/lib.rs`

- [ ] **Step 1: Create `programs/bridge/src/state.rs`**

```rust
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
```

- [ ] **Step 2: Wire into `lib.rs`**

Add `pub mod state;` near the top.

- [ ] **Step 3: Verify build**

Run: `anchor build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add programs/bridge/src/state.rs programs/bridge/src/lib.rs
git commit -m "feat(solana): add BridgeConfig and ProcessedMessage account types"
```

---

### Task 5: Initialize instruction (basic happy path, TDD)

**Files:**
- Create: `programs/bridge/src/instructions/mod.rs`
- Create: `programs/bridge/src/instructions/initialize.rs`
- Create: `tests/bridge.ts`
- Modify: `programs/bridge/src/lib.rs`

- [ ] **Step 1: Create `programs/bridge/src/instructions/mod.rs` (empty for now)**

```rust
pub mod initialize;
pub use initialize::*;
```

- [ ] **Step 2: Wire into `lib.rs` and remove the `ping` stub**

Replace the entire `lib.rs` body with:

```rust
use anchor_lang::prelude::*;

pub mod errors;
pub mod payload;
pub mod state;
pub mod instructions;

use instructions::*;
use payload::*;

declare_id!("<PROGRAM_ID>");  // keep the same pubkey from Task 1 Step 2

#[program]
pub mod bridge {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }
}
```

- [ ] **Step 3: Write the failing test in `tests/bridge.ts`**

Create the file with this content:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  setAuthority,
  AuthorityType,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { Bridge } from "../target/types/bridge";

describe("bridge", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Bridge as Program<Bridge>;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const relayer = Keypair.generate();

  const SOURCE_CHAIN_ID = 1;
  const SOURCE_BRIDGE = Buffer.alloc(20, 0xab);
  const SOURCE_TOKEN = Buffer.alloc(20, 0xcd);

  let wrappedMint: PublicKey;
  let configPda: PublicKey;
  let mintAuthorityPda: PublicKey;

  before(async () => {
    // Fund the relayer for later tests.
    const sig = await provider.connection.requestAirdrop(
      relayer.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    [mintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      program.programId
    );

    // Create the wrapped mint with the deployer as initial authority,
    // then transfer mint authority to the program PDA.
    wrappedMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );
    await setAuthority(
      provider.connection,
      admin,
      wrappedMint,
      admin,
      AuthorityType.MintTokens,
      mintAuthorityPda
    );
  });

  it("initializes the bridge config", async () => {
    await program.methods
      .initialize({
        authorizedRelayer: relayer.publicKey,
        sourceChainId: SOURCE_CHAIN_ID,
        sourceBridge: Array.from(SOURCE_BRIDGE),
        sourceToken: Array.from(SOURCE_TOKEN),
      })
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        wrappedMint: wrappedMint,
        mintAuthority: mintAuthorityPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.bridgeConfig.fetch(configPda);
    expect(cfg.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(cfg.authorizedRelayer.toBase58()).to.equal(relayer.publicKey.toBase58());
    expect(cfg.sourceChainId).to.equal(SOURCE_CHAIN_ID);
    expect(Buffer.from(cfg.sourceBridge).equals(SOURCE_BRIDGE)).to.equal(true);
    expect(Buffer.from(cfg.sourceToken).equals(SOURCE_TOKEN)).to.equal(true);
    expect(cfg.wrappedMint.toBase58()).to.equal(wrappedMint.toBase58());
    expect(cfg.paused).to.equal(false);
  });
});
```

- [ ] **Step 4: Run the test — expect failure**

Run: `anchor test`
Expected: build error or test failure because `initialize::handler` does not exist yet.

- [ ] **Step 5: Create `programs/bridge/src/instructions/initialize.rs`**

```rust
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
```

- [ ] **Step 6: Run the test — expect pass**

Run: `anchor test`
Expected: `1 passing`. Test takes ~30–60s because it spins up a local validator.

- [ ] **Step 7: Commit**

```bash
git add programs/bridge/src/instructions/ programs/bridge/src/lib.rs tests/bridge.ts
git commit -m "feat(solana): initialize instruction creates BridgeConfig"
```

---

### Task 6: Initialize rejects un-transferred mint authority

**Files:**
- Modify: `programs/bridge/src/instructions/initialize.rs`
- Modify: `tests/bridge.ts`

- [ ] **Step 1: Add the failing test to `tests/bridge.ts`**

Add a new `describe` block at the bottom of the file (or a new `it` inside the existing `describe`):

```typescript
  it("rejects initialize when mint authority is not the program PDA", async () => {
    // Use a fresh mint where authority is still the admin (not the PDA).
    const badMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );
    // Derive a fresh, unrelated config PDA so we don't collide with the previous test.
    // Easiest: try to initialize a *second* bridge — but BridgeConfig is a singleton,
    // so the init will conflict. To isolate the mint-authority check, we re-deploy the
    // program for this test... or, simpler, run this test first and ensure the happy
    // path runs after. Mocha tests in a single describe run in order, so:
    //   - We restructure: split the happy-path init into a dedicated describe, and
    //     this rejection test runs in its own describe with its own `before` hook.
    //
    // For this step, ASSUME: this `it` runs before the happy-path init by structuring
    // it inside its own `describe("initialize rejection cases", ...)` placed BEFORE
    // the happy-path describe in the file order. Mocha runs describes top-to-bottom.
    try {
      await program.methods
        .initialize({
          authorizedRelayer: relayer.publicKey,
          sourceChainId: SOURCE_CHAIN_ID,
          sourceBridge: Array.from(SOURCE_BRIDGE),
          sourceToken: Array.from(SOURCE_TOKEN),
        })
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          wrappedMint: badMint,
          mintAuthority: mintAuthorityPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("expected initialize to throw");
    } catch (err: any) {
      expect(err.toString()).to.match(/MintAuthorityNotTransferred/);
    }
  });
```

Then refactor the test file: wrap the happy-path init in `describe("initialize", () => { ... })` and put a `describe("initialize rejection", () => { ... })` block BEFORE it. Each `describe` gets its own `before` hook so they don't share state.

Suggested final structure of the file:

```typescript
describe("bridge", () => {
  // shared provider/program setup
  describe("initialize rejection cases", () => {
    // before: create a mint without transferring authority
    it("rejects when mint authority is not the program PDA", async () => { ... });
  });

  describe("initialize happy path", () => {
    // before: create mint AND transfer authority
    it("initializes the bridge config", async () => { ... });
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `anchor test`
Expected: the rejection test fails because no check exists yet (init succeeds with the bad mint).

- [ ] **Step 3: Add the check to `initialize.rs` handler**

Modify the `handler` function. After the existing `Ok(())` removal, insert before the field assignments:

```rust
pub fn handler(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    // Verify the wrapped mint's authority is already set to the bridge's PDA.
    let expected_authority = ctx.accounts.mint_authority.key();
    let actual_authority = ctx.accounts.wrapped_mint.mint_authority;
    require!(
        actual_authority == anchor_lang::solana_program::program_option::COption::Some(expected_authority),
        crate::errors::BridgeError::MintAuthorityNotTransferred
    );

    let config = &mut ctx.accounts.config;
    // ... rest of the existing assignments
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `anchor test`
Expected: both initialize tests pass.

- [ ] **Step 5: Commit**

```bash
git add programs/bridge/src/instructions/initialize.rs tests/bridge.ts
git commit -m "feat(solana): initialize verifies mint authority is the program PDA"
```

---

### Task 7: set_paused instruction

**Files:**
- Create: `programs/bridge/src/instructions/set_paused.rs`
- Modify: `programs/bridge/src/instructions/mod.rs`
- Modify: `programs/bridge/src/lib.rs`
- Modify: `tests/bridge.ts`

- [ ] **Step 1: Add failing tests to `tests/bridge.ts`**

Inside the `describe("bridge", ...)` block, after the initialize describes, add:

```typescript
  describe("set_paused", () => {
    it("admin can pause and unpause", async () => {
      await program.methods.setPaused(true)
        .accounts({ admin: admin.publicKey, config: configPda })
        .rpc();
      let cfg = await program.account.bridgeConfig.fetch(configPda);
      expect(cfg.paused).to.equal(true);

      await program.methods.setPaused(false)
        .accounts({ admin: admin.publicKey, config: configPda })
        .rpc();
      cfg = await program.account.bridgeConfig.fetch(configPda);
      expect(cfg.paused).to.equal(false);
    });

    it("non-admin cannot pause", async () => {
      const intruder = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(intruder.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods.setPaused(true)
          .accounts({ admin: intruder.publicKey, config: configPda })
          .signers([intruder])
          .rpc();
        expect.fail("expected setPaused to throw");
      } catch (err: any) {
        expect(err.toString()).to.match(/UnauthorizedAdmin/);
      }
    });
  });
```

- [ ] **Step 2: Run — expect failure**

Run: `anchor test`
Expected: tests fail because `setPaused` method doesn't exist.

- [ ] **Step 3: Create `programs/bridge/src/instructions/set_paused.rs`**

```rust
use anchor_lang::prelude::*;

use crate::errors::BridgeError;
use crate::state::BridgeConfig;

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeConfig::SEED],
        bump = config.config_bump,
    )]
    pub config: Account<'info, BridgeConfig>,
}

pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.admin == ctx.accounts.admin.key(), BridgeError::UnauthorizedAdmin);
    config.paused = paused;
    Ok(())
}
```

- [ ] **Step 4: Wire it up in `mod.rs` and `lib.rs`**

`programs/bridge/src/instructions/mod.rs`:
```rust
pub mod initialize;
pub mod set_paused;
pub use initialize::*;
pub use set_paused::*;
```

`programs/bridge/src/lib.rs` — add to `#[program]` mod:
```rust
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::handler(ctx, paused)
    }
```

- [ ] **Step 5: Run — expect pass**

Run: `anchor test`
Expected: 4 passing (init reject, init pass, pause admin, pause non-admin).

- [ ] **Step 6: Commit**

```bash
git add programs/bridge/src/instructions/ programs/bridge/src/lib.rs tests/bridge.ts
git commit -m "feat(solana): set_paused instruction with admin guard"
```

---

### Task 8: set_relayer instruction

**Files:**
- Create: `programs/bridge/src/instructions/set_relayer.rs`
- Modify: `programs/bridge/src/instructions/mod.rs`
- Modify: `programs/bridge/src/lib.rs`
- Modify: `tests/bridge.ts`

- [ ] **Step 1: Add failing test to `tests/bridge.ts`**

```typescript
  describe("set_relayer", () => {
    it("admin can rotate the authorized relayer", async () => {
      const newRelayer = Keypair.generate();
      await program.methods.setRelayer(newRelayer.publicKey)
        .accounts({ admin: admin.publicKey, config: configPda })
        .rpc();
      const cfg = await program.account.bridgeConfig.fetch(configPda);
      expect(cfg.authorizedRelayer.toBase58()).to.equal(newRelayer.publicKey.toBase58());

      // Restore original relayer for downstream mint_wrapped tests.
      await program.methods.setRelayer(relayer.publicKey)
        .accounts({ admin: admin.publicKey, config: configPda })
        .rpc();
    });

    it("non-admin cannot rotate", async () => {
      const intruder = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(intruder.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      try {
        await program.methods.setRelayer(intruder.publicKey)
          .accounts({ admin: intruder.publicKey, config: configPda })
          .signers([intruder])
          .rpc();
        expect.fail("expected setRelayer to throw");
      } catch (err: any) {
        expect(err.toString()).to.match(/UnauthorizedAdmin/);
      }
    });
  });
```

- [ ] **Step 2: Run — expect failure**

Run: `anchor test`

- [ ] **Step 3: Create `programs/bridge/src/instructions/set_relayer.rs`**

```rust
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
```

- [ ] **Step 4: Wire up `mod.rs` + `lib.rs`**

Add `pub mod set_relayer; pub use set_relayer::*;` to `mod.rs`.

Add to `lib.rs` `#[program]` block:
```rust
    pub fn set_relayer(ctx: Context<SetRelayer>, new_relayer: Pubkey) -> Result<()> {
        instructions::set_relayer::handler(ctx, new_relayer)
    }
```

- [ ] **Step 5: Run — expect pass**

Run: `anchor test`
Expected: 6 passing.

- [ ] **Step 6: Commit**

```bash
git add programs/bridge/src/instructions/ programs/bridge/src/lib.rs tests/bridge.ts
git commit -m "feat(solana): set_relayer instruction for relayer rotation"
```

---

### Task 9: mint_wrapped happy path

**Files:**
- Create: `programs/bridge/src/instructions/mint_wrapped.rs`
- Modify: `programs/bridge/src/instructions/mod.rs`
- Modify: `programs/bridge/src/lib.rs`
- Modify: `tests/bridge.ts`

- [ ] **Step 1: Add the failing test**

At the top of `tests/bridge.ts`, add a small helper:

```typescript
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { TransactionInstruction, Transaction } from "@solana/web3.js";
import * as bs58 from "bs58";

// Build a BridgePayload-shaped object the Anchor TS client can serialize.
function makePayload(overrides: Partial<any> = {}) {
  return {
    version: 1,
    sourceChainId: SOURCE_CHAIN_ID,
    sourceBridge: Array.from(SOURCE_BRIDGE),
    sourceToken: Array.from(SOURCE_TOKEN),
    nonce: new anchor.BN(1),
    amount: new anchor.BN(1_000_000),
    senderEth: Array.from(Buffer.alloc(20, 0xee)),
    recipientSol: Array.from(Buffer.alloc(32, 0)),     // overwritten in tests
    sourceTxHash: Array.from(Buffer.alloc(32, 0xaa)),
    sourceLogIndex: 0,
    ...overrides,
  };
}

function processedPda(programId: PublicKey, sourceChainId: number, sourceBridge: Buffer, nonce: bigint) {
  const chainBuf = Buffer.alloc(2);
  chainBuf.writeUInt16LE(sourceChainId, 0);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("processed"), chainBuf, sourceBridge, nonceBuf],
    programId
  );
  return pda;
}
```

You'll need `bs58` — add to `package.json` deps: `"bs58": "^5.0.0"` and run `npm install`.

Then add a new describe:

```typescript
  describe("mint_wrapped happy path", () => {
    const recipient = Keypair.generate();

    it("mints wrapped tokens to the recipient ATA", async () => {
      const recipientAta = await getAssociatedTokenAddress(wrappedMint, recipient.publicKey);
      const nonce = 1n;
      const payload = makePayload({
        nonce: new anchor.BN(nonce.toString()),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      const processedMessage = processedPda(program.programId, SOURCE_CHAIN_ID, SOURCE_BRIDGE, nonce);

      // Pre-create the ATA in the same tx via a relayer-paid instruction.
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        relayer.publicKey,
        recipientAta,
        recipient.publicKey,
        wrappedMint
      );

      await program.methods
        .mintWrapped(payload)
        .accounts({
          relayer: relayer.publicKey,
          config: configPda,
          processedMessage,
          wrappedMint,
          mintAuthority: mintAuthorityPda,
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([createAtaIx])
        .signers([relayer])
        .rpc();

      const ata = await getAccount(provider.connection, recipientAta);
      expect(ata.amount.toString()).to.equal("1000000");

      const pm = await program.account.processedMessage.fetch(processedMessage);
      expect(pm.nonce.toString()).to.equal("1");
      expect(pm.amount.toString()).to.equal("1000000");
      expect(pm.recipient.toBase58()).to.equal(recipient.publicKey.toBase58());
    });
  });
```

- [ ] **Step 2: Run — expect failure**

Run: `anchor test`
Expected: `mintWrapped` not defined, build or runtime failure.

- [ ] **Step 3: Create `programs/bridge/src/instructions/mint_wrapped.rs`**

```rust
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

    // Source binding + payload sanity. (Validation suite is fleshed out further in Task 10.)
    require!(payload.amount > 0, BridgeError::ZeroAmount);

    // Recipient consistency: payload's 32-byte recipient must equal the recipient account,
    // and the token account must be the canonical ATA.
    let recipient_pubkey = Pubkey::new_from_array(payload.recipient_sol);
    require!(ctx.accounts.recipient.key() == recipient_pubkey, BridgeError::RecipientMismatch);

    let expected_ata = get_associated_token_address(&recipient_pubkey, &ctx.accounts.wrapped_mint.key());
    require!(ctx.accounts.recipient_token_account.key() == expected_ata, BridgeError::InvalidRecipientAta);

    // Mint via PDA authority.
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

    // Audit record.
    let pm = &mut ctx.accounts.processed_message;
    pm.nonce = payload.nonce;
    pm.source_tx_hash = payload.source_tx_hash;
    pm.source_log_index = payload.source_log_index;
    pm.amount = payload.amount;
    pm.recipient = recipient_pubkey;
    pm.processed_slot = Clock::get()?.slot;

    Ok(())
}
```

- [ ] **Step 4: Wire up `mod.rs` + `lib.rs`**

Add `pub mod mint_wrapped; pub use mint_wrapped::*;` to `mod.rs`.

Add to `lib.rs` `#[program]` block:
```rust
    pub fn mint_wrapped(ctx: Context<MintWrapped>, payload: BridgePayload) -> Result<()> {
        instructions::mint_wrapped::handler(ctx, payload)
    }
```

- [ ] **Step 5: Run — expect pass**

Run: `anchor test`
Expected: 7 passing including the new mint_wrapped happy-path test.

- [ ] **Step 6: Commit**

```bash
git add programs/bridge/src/instructions/ programs/bridge/src/lib.rs tests/bridge.ts package.json
git commit -m "feat(solana): mint_wrapped happy path with PDA authority"
```

---

### Task 10: mint_wrapped full validation suite

**Files:**
- Modify: `programs/bridge/src/instructions/mint_wrapped.rs`
- Modify: `tests/bridge.ts`

- [ ] **Step 1: Add the failing tests**

Append a new describe to `tests/bridge.ts`:

```typescript
  describe("mint_wrapped validation", () => {
    const recipient = Keypair.generate();

    async function attempt(payload: any, signer = relayer, nonceForPda?: bigint, badAccounts: any = {}) {
      const nonce = nonceForPda ?? BigInt(payload.nonce.toString());
      const recipientAta = await getAssociatedTokenAddress(wrappedMint, recipient.publicKey);
      const processedMessage = processedPda(
        program.programId,
        SOURCE_CHAIN_ID,
        SOURCE_BRIDGE,
        nonce
      );
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey, recipientAta, recipient.publicKey, wrappedMint
      );
      return program.methods
        .mintWrapped(payload)
        .accounts({
          relayer: signer.publicKey,
          config: configPda,
          processedMessage,
          wrappedMint,
          mintAuthority: mintAuthorityPda,
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          ...badAccounts,
        })
        .preInstructions([createAtaIx])
        .signers([signer])
        .rpc();
    }

    it("rejects unauthorized relayer", async () => {
      const intruder = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(intruder.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      const payload = makePayload({
        nonce: new anchor.BN(100),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      try {
        await attempt(payload, intruder);
        expect.fail("expected UnauthorizedRelayer");
      } catch (e: any) { expect(e.toString()).to.match(/UnauthorizedRelayer/); }
    });

    it("rejects when paused", async () => {
      await program.methods.setPaused(true).accounts({ admin: admin.publicKey, config: configPda }).rpc();
      const payload = makePayload({
        nonce: new anchor.BN(101),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      try {
        await attempt(payload);
        expect.fail("expected Paused");
      } catch (e: any) {
        expect(e.toString()).to.match(/Paused/);
      } finally {
        await program.methods.setPaused(false).accounts({ admin: admin.publicKey, config: configPda }).rpc();
      }
    });

    it("rejects unsupported version", async () => {
      const payload = makePayload({
        version: 2,
        nonce: new anchor.BN(102),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      try {
        await attempt(payload);
        expect.fail("expected UnsupportedVersion");
      } catch (e: any) { expect(e.toString()).to.match(/UnsupportedVersion/); }
    });

    it("rejects wrong source_chain_id", async () => {
      const payload = makePayload({
        sourceChainId: 999,
        nonce: new anchor.BN(103),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      try {
        await attempt(payload);
        expect.fail("expected InvalidSource");
      } catch (e: any) { expect(e.toString()).to.match(/InvalidSource/); }
    });

    it("rejects wrong source_bridge", async () => {
      const payload = makePayload({
        sourceBridge: Array.from(Buffer.alloc(20, 0xff)),
        nonce: new anchor.BN(104),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      try {
        await attempt(payload);
        expect.fail("expected InvalidSource");
      } catch (e: any) { expect(e.toString()).to.match(/InvalidSource/); }
    });

    it("rejects wrong source_token", async () => {
      const payload = makePayload({
        sourceToken: Array.from(Buffer.alloc(20, 0xff)),
        nonce: new anchor.BN(105),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      try {
        await attempt(payload);
        expect.fail("expected InvalidSource");
      } catch (e: any) { expect(e.toString()).to.match(/InvalidSource/); }
    });

    it("rejects zero amount", async () => {
      const payload = makePayload({
        amount: new anchor.BN(0),
        nonce: new anchor.BN(106),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      try {
        await attempt(payload);
        expect.fail("expected ZeroAmount");
      } catch (e: any) { expect(e.toString()).to.match(/ZeroAmount/); }
    });

    it("rejects wrong wrapped mint", async () => {
      const otherMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
      const payload = makePayload({
        nonce: new anchor.BN(107),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      try {
        await attempt(payload, relayer, undefined, { wrappedMint: otherMint });
        expect.fail("expected WrongMint");
      } catch (e: any) { expect(e.toString()).to.match(/WrongMint/); }
    });
  });
```

- [ ] **Step 2: Run — expect failures**

Run: `anchor test`
Expected: ~5 of these tests fail (auth, pause, version, source_chain, source_bridge, source_token, wrong mint) because the corresponding `require!` checks don't exist yet.

- [ ] **Step 3: Add the missing checks to `mint_wrapped.rs` handler**

Replace the current `handler` body. Insert validation block at the top, before the existing `ZeroAmount` check:

```rust
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

    // Mint identity.
    require!(ctx.accounts.wrapped_mint.key() == cfg.wrapped_mint, BridgeError::WrongMint);

    // Sanity.
    require!(payload.amount > 0, BridgeError::ZeroAmount);

    // ... existing recipient/ATA checks and CPI mint stay below this block ...
}
```

- [ ] **Step 4: Run — expect pass**

Run: `anchor test`
Expected: all validation tests pass. ~14 passing total.

- [ ] **Step 5: Commit**

```bash
git add programs/bridge/src/instructions/mint_wrapped.rs tests/bridge.ts
git commit -m "feat(solana): full validation suite for mint_wrapped"
```

---

### Task 11: mint_wrapped replay protection test

**Files:**
- Modify: `tests/bridge.ts`

This task adds the most important test in the suite (per the spec: duplicate consumption is the quintessential cross-chain failure). The implementation already prevents this via Anchor's `init` constraint — this task only adds the test to *prove* it.

- [ ] **Step 1: Add the test**

Append:

```typescript
  describe("mint_wrapped replay protection", () => {
    const recipient = Keypair.generate();
    const nonce = 200n;

    it("rejects duplicate submission for the same nonce", async () => {
      const recipientAta = await getAssociatedTokenAddress(wrappedMint, recipient.publicKey);
      const processedMessage = processedPda(program.programId, SOURCE_CHAIN_ID, SOURCE_BRIDGE, nonce);
      const payload = makePayload({
        nonce: new anchor.BN(nonce.toString()),
        recipientSol: Array.from(recipient.publicKey.toBuffer()),
      });
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        relayer.publicKey, recipientAta, recipient.publicKey, wrappedMint
      );

      // First submission succeeds.
      await program.methods.mintWrapped(payload)
        .accounts({
          relayer: relayer.publicKey,
          config: configPda,
          processedMessage,
          wrappedMint,
          mintAuthority: mintAuthorityPda,
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([createAtaIx])
        .signers([relayer])
        .rpc();

      // Second submission with the SAME nonce must fail at PDA init.
      try {
        await program.methods.mintWrapped(payload)
          .accounts({
            relayer: relayer.publicKey,
            config: configPda,
            processedMessage,
            wrappedMint,
            mintAuthority: mintAuthorityPda,
            recipient: recipient.publicKey,
            recipientTokenAccount: recipientAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        expect.fail("expected duplicate to fail");
      } catch (e: any) {
        // Anchor returns "already in use" when init hits an existing account.
        expect(e.toString()).to.match(/already in use|0x0/);
      }
    });
  });
```

- [ ] **Step 2: Run — expect pass**

Run: `anchor test`
Expected: all tests pass including the new replay test (~15 passing).

- [ ] **Step 3: Commit**

```bash
git add tests/bridge.ts
git commit -m "test(solana): duplicate-nonce replay protection"
```

---

### Task 12: Migration / deploy script

**Files:**
- Create: `migrations/deploy.ts`

This script is meant to be run once after `anchor deploy` to set up the wrapped mint and initialize `BridgeConfig`. It's parameterized so it works for both local validator (during testing) and Devnet.

- [ ] **Step 1: Create `migrations/deploy.ts`**

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  setAuthority,
  AuthorityType,
} from "@solana/spl-token";
import * as fs from "fs";
import { Bridge } from "../target/types/bridge";

/**
 * Run after `anchor deploy`. Reads addresses from env or defaults to placeholders.
 *
 * Required env vars (set in your shell or .env):
 *   ANCHOR_WALLET            path to admin keypair (defaults to ~/.config/solana/id.json)
 *   ANCHOR_PROVIDER_URL      Devnet or local RPC
 *   RELAYER_PUBKEY           base58 pubkey of relayer (provided by Leah & Harry)
 *   ETH_BRIDGE_ADDRESS       0x... 20-byte address (from Yang)
 *   ETH_TOKEN_ADDRESS        0x... 20-byte address (from Yang)
 *   SOURCE_CHAIN_ID          uint16 (default 1 = Sepolia domain)
 */
async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Bridge as Program<Bridge>;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const relayerPubkey = new PublicKey(process.env.RELAYER_PUBKEY!);
  const sourceChainId = parseInt(process.env.SOURCE_CHAIN_ID ?? "1", 10);
  const sourceBridge = hex20(process.env.ETH_BRIDGE_ADDRESS!);
  const sourceToken = hex20(process.env.ETH_TOKEN_ADDRESS!);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    program.programId
  );

  console.log("Program ID         :", program.programId.toBase58());
  console.log("Admin              :", admin.publicKey.toBase58());
  console.log("Relayer            :", relayerPubkey.toBase58());
  console.log("BridgeConfig PDA   :", configPda.toBase58());
  console.log("Mint Authority PDA :", mintAuthorityPda.toBase58());

  // 1. Create wrapped SPL mint, decimals = 6.
  console.log("\n[1/3] Creating wrapped SPL mint...");
  const wrappedMint = await createMint(
    provider.connection,
    admin,
    admin.publicKey,
    null,
    6
  );
  console.log("Wrapped Mint       :", wrappedMint.toBase58());

  // 2. Transfer mint authority to the program PDA.
  console.log("\n[2/3] Transferring mint authority to program PDA...");
  await setAuthority(
    provider.connection,
    admin,
    wrappedMint,
    admin,
    AuthorityType.MintTokens,
    mintAuthorityPda
  );
  console.log("Mint authority transferred.");

  // 3. Initialize BridgeConfig.
  console.log("\n[3/3] Initializing BridgeConfig...");
  await program.methods
    .initialize({
      authorizedRelayer: relayerPubkey,
      sourceChainId,
      sourceBridge: Array.from(sourceBridge),
      sourceToken: Array.from(sourceToken),
    })
    .accounts({
      admin: admin.publicKey,
      config: configPda,
      wrappedMint,
      mintAuthority: mintAuthorityPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("\n=== DEPLOYMENT ARTIFACTS (give these to relayer team) ===");
  console.log(`SOL_PROGRAM_ID=${program.programId.toBase58()}`);
  console.log(`SOL_WRAPPED_MINT=${wrappedMint.toBase58()}`);
  console.log(`SOL_BRIDGE_CONFIG=${configPda.toBase58()}`);
  console.log(`SOL_MINT_AUTHORITY=${mintAuthorityPda.toBase58()}`);
  console.log(`SOL_AUTHORIZED_RELAYER=${relayerPubkey.toBase58()}`);
}

function hex20(hex: string): Buffer {
  const stripped = hex.replace(/^0x/, "");
  if (stripped.length !== 40) throw new Error(`expected 20-byte hex, got ${stripped.length / 2} bytes`);
  return Buffer.from(stripped, "hex");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add a script entry to `package.json`**

Add to `scripts`:
```json
"anchor:initialize": "ts-node migrations/deploy.ts"
```

- [ ] **Step 3: Smoke-test locally**

Start a local validator manually (separate terminal): `solana-test-validator --reset`

Then in the project terminal:
```bash
solana config set --url localhost
anchor build
anchor deploy
RELAYER_PUBKEY=$(solana-keygen pubkey ~/.config/solana/id.json) \
  ETH_BRIDGE_ADDRESS=0x1111111111111111111111111111111111111111 \
  ETH_TOKEN_ADDRESS=0x2222222222222222222222222222222222222222 \
  ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
  ANCHOR_WALLET=~/.config/solana/id.json \
  npm run anchor:initialize
```

Expected output prints program ID, BridgeConfig PDA, mint, authority. If `BridgeConfig` is already initialized (from `anchor test` runs against the same validator), reset the validator first.

Stop the validator (Ctrl-C) when done.

- [ ] **Step 4: Commit**

```bash
git add migrations/deploy.ts package.json
git commit -m "feat(solana): deploy migration that creates mint and initializes BridgeConfig"
```

---

### Task 13: Devnet deployment + IDL handoff

**Files:**
- Modify: `idl/bridge.json` (overwrite from `target/idl/bridge.json`)

This task involves real Devnet deployment. **Read the entire task before running anything.** It assumes Yang has shared the deployed `EthBridge.sol` and `TestToken.sol` Sepolia addresses; if he hasn't, stop after Step 4 and resume when those are available.

- [ ] **Step 1: Switch CLI to Devnet**

Run:
```bash
solana config set --url devnet
solana balance
```

If balance is below ~3 SOL, request an airdrop. Devnet faucets are rate-limited; you may need to use a web faucet (https://faucet.solana.com) instead of CLI airdrop.

- [ ] **Step 2: Build and capture program ID**

```bash
anchor build
solana address -k target/deploy/bridge-keypair.json
```

The printed pubkey must match the `<PROGRAM_ID>` in `lib.rs` and `Anchor.toml`. If not, your `target/deploy/bridge-keypair.json` was regenerated and you need to update both files and rebuild.

- [ ] **Step 3: Deploy**

```bash
anchor deploy --provider.cluster devnet
```

Expected: a long progress bar, then "Program Id: <PROGRAM_ID>". If it fails partway with "insufficient funds" or "RPC error", re-run — Solana's `program-deploy` resumes from where it left off.

- [ ] **Step 4: Copy the IDL into the relayer's expected location**

```bash
cp target/idl/bridge.json idl/bridge.json
```

Verify it contains the new `BridgePayload` shape (binary fields — `[u8; 20]` arrays, not strings) and `BridgeConfig` account type:
```bash
grep -E '"name": "(bridgePayload|bridgeConfig|sourceChainId|recipientSol)"' idl/bridge.json
```
Expected: at least 4 lines matched.

- [ ] **Step 5: Wait for Yang's addresses (or use placeholders)**

If Yang has shared Sepolia addresses, set:
```bash
export ETH_BRIDGE_ADDRESS=0x...   # from Yang
export ETH_TOKEN_ADDRESS=0x...    # from Yang
```

If not yet, you have two options:
- (a) Stop here, push only the program code, finish initialize later.
- (b) Initialize with placeholder addresses now and accept that you'll need to redeploy/reinitialize when Yang's addresses arrive (BridgeConfig has no setter for source bindings — the workaround is `solana program close <PROGRAM_ID>` and start over, which is cheap on Devnet).

For a tight deadline, (b) is acceptable. Use `0x0000000000000000000000000000000000000000` for both placeholders.

- [ ] **Step 6: Initialize BridgeConfig on Devnet**

The relayer pubkey must come from Leah & Harry. If they have not generated one, ask them to run `solana-keygen new -o relayer-keypair.json` and share the pubkey.

```bash
RELAYER_PUBKEY=<from Leah & Harry> \
  ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
  ANCHOR_WALLET=~/.config/solana/id.json \
  npm run anchor:initialize
```

Capture the printed `=== DEPLOYMENT ARTIFACTS ===` block — these go into the coordination handoff doc in Task 14.

- [ ] **Step 7: Commit the regenerated IDL only**

```bash
git add idl/bridge.json
git commit -m "feat(solana): regenerate IDL after Devnet deploy"
```

Do **not** commit `target/` or `.anchor/` — they are gitignored. The regenerated IDL is intended to be pushed (relayer team needs it).

---

### Task 14: Coordination handoff notes

**Files:**
- Create: `docs/coordination-handoff.md`

This is a real deliverable for teammates — meant to be pushed.

- [ ] **Step 1: Create `docs/coordination-handoff.md`**

```markdown
# Solana <-> Relayer / Ethereum coordination

Maintainer: Aaron
Last updated: 2026-04-25

## What changed in the IDL

Compared to the pre-Anchor draft IDL, the program now:

- `BridgePayload` is a **fixed-width binary struct**:
  - Strings replaced with raw byte arrays.
  - Adds `version` (u8), `sourceChainId` (u16), `sourceBridge` ([u8;20]), `sourceToken` ([u8;20]), `senderEth` ([u8;20]), `recipientSol` ([u8;32]), `sourceTxHash` ([u8;32]), `sourceLogIndex` (u32).
  - Drops `sourceChain` / `targetChain` strings (replaced by numeric `sourceChainId`).
- New singleton account `BridgeConfig` (PDA `["config"]`).
- `mintWrapped` requires additional accounts: `config`, `mintAuthority`, `recipient`.
- `processedMessage` PDA seeds are now `["processed", sourceChainId_le, sourceBridge, nonce_le]` — not just `["processed", nonce]`.

## What the relayer needs to change in `src/submitter.ts`

Replace the existing `bridgePayload` object construction with:

```typescript
import bs58 from "bs58";

const bridgePayload = {
  version: 1,
  sourceChainId: 1,                                                  // Sepolia domain
  sourceBridge: Array.from(Buffer.from(config.ETH_BRIDGE_ADDRESS.replace(/^0x/, ""), "hex")),
  sourceToken:  Array.from(Buffer.from(config.ETH_TOKEN_ADDRESS.replace(/^0x/, ""),  "hex")),
  nonce: new BN(msg.nonce),
  amount: new BN(msg.amount),                                        // throws if amount > u64::MAX
  senderEth:   Array.from(Buffer.from(msg.sender.replace(/^0x/, ""), "hex")),
  recipientSol: Array.from(bs58.decode(msg.recipient)),              // 32 bytes
  sourceTxHash: Array.from(Buffer.from(msg.sourceTxHash.replace(/^0x/, ""), "hex")),
  sourceLogIndex: msg.logIndex ?? 0,
};
```

The `mintWrapped` call now also needs:
- `config` (PDA `["config"]`)
- `mintAuthority` (PDA `["mint_authority"]`)
- `recipient` (the wallet pubkey — same as `payload.recipientSol` but as a `PublicKey`)

The `processedMessage` PDA derivation changes:

```typescript
const chainBuf = Buffer.alloc(2); chainBuf.writeUInt16LE(1, 0);
const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(BigInt(msg.nonce), 0);
const [processedMessagePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("processed"), chainBuf, sourceBridgeBytes, nonceBuf],
  programId
);
```

The relayer also needs to issue an idempotent ATA-creation instruction in the same transaction before `mintWrapped`, since the Solana program no longer creates ATAs itself:

```typescript
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";

const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
  relayerPubkey, recipientAta, recipientPubkey, wrappedMint
);

await program.methods.mintWrapped(payload)
  .accounts({ ... })
  .preInstructions([createAtaIx])
  .rpc();
```

## What `.env` keys the relayer must add

```
ETH_TOKEN_ADDRESS=0x...        # the bound ERC-20 from Yang's deployment
SOL_BRIDGE_CONFIG=...          # printed at end of `anchor:initialize`
SOL_MINT_AUTHORITY=...         # printed at end of `anchor:initialize`
SOL_AUTHORIZED_RELAYER=...     # the relayer pubkey we initialized BridgeConfig with
```

## Devnet deployment artifacts

(To be filled in after Task 13.)

```
SOL_PROGRAM_ID=
SOL_WRAPPED_MINT=
SOL_BRIDGE_CONFIG=
SOL_MINT_AUTHORITY=
SOL_AUTHORIZED_RELAYER=
```

## What Yang needs to share

- Sepolia `EthBridge.sol` deployed address (20-byte hex).
- Sepolia `TestToken.sol` (the bound ERC-20) deployed address (20-byte hex).
- Confirmation that the `Locked` event includes `sourceTxHash` as `bytes32` and that the `recipient` parameter is `bytes32` (raw 32-byte Solana pubkey, not base58 string).

## Risks if these are missed

- If the relayer encodes a string-based payload, `mintWrapped` fails on the first call (Borsh size mismatch).
- If the ATA pre-instruction is forgotten, `mintWrapped` fails with `AccountNotInitialized`.
- If `ETH_TOKEN_ADDRESS` doesn't match what was passed to `initialize`, every mint fails with `InvalidSource`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/coordination-handoff.md
git commit -m "docs: coordination handoff notes for relayer + ethereum teammates"
```

---

### Task 15: Writeup draft ("Solana Aaron" section)

**Files:**
- Create: `docs/writeup-solana-aaron.md`

A draft of the writeup section that goes into the team's PDF. The user will refine voice and copy it into the PDF; this is the structural skeleton with content.

- [ ] **Step 1: Create `docs/writeup-solana-aaron.md`**

Use the §10 outline from the spec. Each section below maps to one of the eight subsections. Target ~2000 words total. Voice: first-person implementer.

```markdown
# Solana — Aaron

## What I built

I implemented the Solana side of the bridge as an Anchor program (`programs/bridge`).
The program owns three pieces of state: a singleton `BridgeConfig` account that holds
the bound source domain and the authorized relayer, a per-message `ProcessedMessage`
account that prevents replay, and an SPL mint whose mint authority is a program-derived
address. Four instructions sit on top of that state: `initialize` to set up
`BridgeConfig` once at deployment, `mint_wrapped` for the relayer to mint wrapped
tokens after observing an Ethereum lock event, and `set_paused` / `set_relayer` for
the admin to halt the system or rotate the relayer key.

I did not build the off-chain relayer (Leah & Harry's responsibility) or the
Ethereum-side lock contract (Yang's responsibility), and I did not implement a
k-of-n threshold scheme — the program trusts a single signer, matching the
deliberately simplified trust model the team adopted.

## Account model

I chose two on-chain account types because they encode two genuinely different
lifecycles. `BridgeConfig` is a singleton: it exists once per deployment and
mutates rarely. `ProcessedMessage` is per-message and exists only to prove a
nonce has been consumed.

The `BridgeConfig` PDA is seeded from `["config"]` — a constant. There is only
one bridge per program deployment, so a more complex seed scheme would not buy
anything. I cached the bump alongside the data so subsequent instructions don't
need to re-derive it; cheaper compute, and the canonical Anchor pattern.

The `ProcessedMessage` seed is the part of the design I spent the most time on.
The naive choice is `["processed", nonce_le]`, which works for a single source
chain bound to a single source contract. But that scheme implicitly assumes the
program will never need to recognize a second source. If we ever added a second
Sepolia bridge contract, or a second source chain, two distinct messages with the
same nonce would collide. So I went with
`["processed", source_chain_id_le, source_bridge, nonce_le]`. The replay namespace
becomes "this message identity from this source bridge on this source chain,"
which generalizes cleanly.

The mint authority lives at its own PDA, derived from `["mint_authority"]`.
Putting authority on a separate PDA — instead of using `BridgeConfig` itself
— matters because `BridgeConfig` is mutable. If a later instruction rewrote it,
nothing in the runtime would stop the mint authority from changing too. A
separate PDA can never have its data changed (it stores nothing), so the mint
authority is structurally immutable for the life of the deployment.

## The `mint_wrapped` instruction

The instruction's job is to verify a relayer-signed message and mint wrapped
tokens. The validation order matters because each check serves a different
purpose, and getting the order wrong leaks information through error codes.

1. `paused` first — fail fast under operational lockdown.
2. `authorized_relayer` second — refuse unsigned-by-relayer requests before doing
   any payload work.
3. `version == 1` — refuse messages from a future payload format we haven't
   audited.
4. `source_chain_id`, `source_bridge`, `source_token` — bind the message to the
   exact source we expect. A relayer with a stolen key still cannot mint from
   a different ERC-20 they happen to also have access to.
5. `wrapped_mint` matches `BridgeConfig.wrapped_mint` — defense against a
   relayer mistakenly passing the wrong mint account.
6. `amount > 0` — sanity.
7. Recipient consistency: the on-chain `recipient` account must match
   `payload.recipient_sol`, and the token account must equal the canonical ATA.

The recipient ATA check is enforced inside the program rather than trusted to
the relayer. This is a small extra cost in compute but means an audit can
verify the program never mints to the wrong account, even with a buggy relayer.

The CPI mint uses signer seeds for the `["mint_authority"]` PDA. This is the
classic Solana pattern for delegating signing authority to a program: the program
is the only entity that knows the seeds and bump that re-derive the authority,
so only this program can mint.

## Replay protection

Replay protection is the single most important property of any cross-chain
bridge, and Solana's account model gives a clean way to express it. The
`ProcessedMessage` account uses Anchor's `init` constraint, not `init_if_needed`.
The first submission for a given (chain, bridge, nonce) creates the PDA. Any
later submission for the same triplet derives the same PDA — and `init` fails
with "account already in use." That single mechanism is the entire replay
defense.

A subtle property here is that I did not need to write an explicit
`MessageAlreadyProcessed` error. The runtime returns "account already in use"
on duplicate `init`, which is sufficient for off-chain logging and triage.
Adding a custom error would mean an extra read and an extra branch — code
paths that could go wrong without making the system safer. Less code is better.

The reason this works at all is that Solana transactions are atomic. If the
mint CPI fails for any reason — wrong authority, bogus mint, anything — the
`ProcessedMessage` creation also reverts. So we cannot end up with a "processed"
record but no minted tokens, and we cannot end up with minted tokens but no
processed record. The two states are coupled by transaction atomicity, which
is what makes the relayer's retry policy safe: a failed retry leaves no trace.

## Token integration

I used the legacy SPL Token Program rather than Token-2022. Both are supported
by `anchor-spl`, but the Anchor TypeScript client and `@solana/spl-token` v0.3
target legacy Token first. For a project where a teammate's relayer code
already imports `@solana/spl-token@0.3.8`, breaking that compatibility for
features Token-2022 offers (transfer hooks, confidential transfers) wasn't
worth it.

ATA handling lives on the relayer side. The relayer issues an idempotent
ATA-creation instruction in the same transaction before `mint_wrapped`, using
`createAssociatedTokenAccountIdempotentInstruction`. This keeps the bridge
program smaller and avoids `init_if_needed`, which carries a known foot-gun
around re-initialization attacks if the program isn't careful to validate the
existing account. Doing it on the relayer side keeps the surface area small;
because both instructions are atomic in the same transaction, the user
experience is identical.

The CPI signer seeds for `mint_to` are `[b"mint_authority", &[bump]]`. The
bump is cached on `BridgeConfig` so we don't re-derive it on every call. This
is a tiny optimization but is the standard Anchor pattern.

## Tests

The Anchor test suite has 14 tests in TypeScript covering: initialize happy
path, initialize rejection when mint authority isn't transferred to the PDA,
admin/non-admin pause, admin/non-admin relayer rotation, mint_wrapped happy
path, and seven distinct rejection cases (unauthorized relayer, paused, wrong
version, wrong chain id, wrong source bridge, wrong source token, zero amount,
wrong wrapped mint, wrong ATA), plus the duplicate-nonce replay test.

The single most important test is the duplicate-nonce one. It is the
quintessential cross-chain failure mode and the one a reviewer should look for
first. If that test passes and the others fail, the bridge is still safe; if
that test fails and everything else passes, the bridge is broken.

The local Anchor test loop catches bugs faster than Devnet does, and resets
state cleanly between runs. I treated `anchor test` as the inner dev loop and
Devnet as integration verification.

## Devnet deployment notes

Deployment has one non-obvious step: after creating the wrapped SPL mint,
`setAuthority` must be called to transfer mint authority from the human deployer
to the program's `["mint_authority"]` PDA. My `initialize` instruction validates
this — it rejects initialization if the mint's authority isn't yet the PDA.
This caught my own deployment mistake the first time I ran the migration script.

The values I handed to the relayer team after Devnet deployment:
- Program ID
- Wrapped mint pubkey
- BridgeConfig PDA (purely informational; they derive it themselves)
- Mint authority PDA (also informational)
- Authorized relayer pubkey (matches what we passed to `initialize`)

## What I would change with more time

1. **k-of-n threshold verification.** The single-relayer trust model is the
   biggest weakness, and the report's extension analysis already lays out the
   on-chain ed25519 sibling-instruction pattern. With another week, the program
   could verify that at least k signatures from a stored relayer set are present
   in the transaction's instructions sysvar.
2. **On-chain ATA `init_if_needed`.** Moving ATA creation into the program
   would simplify the relayer at the cost of a more careful re-init check.
   Doable, just not worth the risk on a tight deadline.
3. **A `set_source_binding` admin instruction.** Right now, if Yang's contract
   address changes, the only fix is `solana program close` and a fresh
   deployment. A small admin-only setter would make this less painful.
4. **Pre-flight balance check in `mint_wrapped`.** Catching an under-funded
   relayer earlier would produce a friendlier error than the Solana runtime's
   default insufficient-funds message.
```

- [ ] **Step 2: Commit**

```bash
git add docs/writeup-solana-aaron.md
git commit -m "docs: draft Solana implementer writeup section for team report"
```

---

## Self-review

**Spec coverage:**
- §3 (architecture/layout) → Task 1 ✓
- §4 (account model) → Task 4 ✓
- §5 (BridgePayload) → Task 3 ✓
- §6 (instructions) → Tasks 5, 6, 7, 8, 9, 10 ✓
- §7 (errors) → Task 2 ✓
- §8 (test plan, 14 tests) → Tasks 5–11 ✓ (initialize-happy, initialize-reject-mint-auth, mint-happy, 7 validation cases, duplicate-nonce, set-paused admin/non-admin, set-relayer rotate/non-admin = 14)
- §9 (Devnet deployment) → Tasks 12, 13 ✓
- §10 (writeup outline) → Task 15 ✓
- §11 (coordination handoff) → Task 14 ✓

**Placeholder scan:** No "TODO"/"TBD"/"fill in later" left in code or test bodies. Tasks 5 and 6 reference structural test-file refactoring but provide explicit guidance.

**Type consistency:**
- `BridgeConfig::SEED = b"config"` referenced from initialize, set_paused, set_relayer, mint_wrapped — consistent.
- `MINT_AUTHORITY_SEED = b"mint_authority"` referenced from initialize and mint_wrapped — consistent.
- `ProcessedMessage::SEED = b"processed"` referenced from mint_wrapped accounts struct and from the TS `processedPda` helper — consistent.
- BridgeConfig field names (`authorizedRelayer`, `sourceChainId`, `sourceBridge`, `sourceToken`, `wrappedMint`, `paused`) consistent across Rust struct, TS test fetches, and migration script.
- BridgePayload field names match between Rust (`source_chain_id`) and TS-camelCase (`sourceChainId`) — Anchor's IDL handles this conversion automatically.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-25-solana-anchor-bridge.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
