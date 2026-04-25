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
