import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint,
  setAuthority,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { TransactionInstruction, Transaction } from "@solana/web3.js";
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

  function makePayload(overrides: Partial<any> = {}) {
    return {
      version: 1,
      sourceChainId: SOURCE_CHAIN_ID,
      sourceBridge: Array.from(SOURCE_BRIDGE),
      sourceToken: Array.from(SOURCE_TOKEN),
      nonce: new anchor.BN(1),
      amount: new anchor.BN(1_000_000),
      senderEth: Array.from(Buffer.alloc(20, 0xee)),
      recipientSol: Array.from(Buffer.alloc(32, 0)),
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
  });

  describe("initialize rejection cases", () => {
    let badMint: PublicKey;

    before(async () => {
      // Mint whose authority is admin, NOT transferred to the program PDA.
      badMint = await createMint(
        provider.connection,
        admin,
        admin.publicKey,
        null,
        6
      );
    });

    it("rejects when mint authority is not the program PDA", async () => {
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
  });

  describe("initialize happy path", () => {
    before(async () => {
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
      expect(cfg.authorizedRelayer.toBase58()).to.equal(
        relayer.publicKey.toBase58()
      );
      expect(cfg.sourceChainId).to.equal(SOURCE_CHAIN_ID);
      expect(Buffer.from(cfg.sourceBridge).equals(SOURCE_BRIDGE)).to.equal(
        true
      );
      expect(Buffer.from(cfg.sourceToken).equals(SOURCE_TOKEN)).to.equal(true);
      expect(cfg.wrappedMint.toBase58()).to.equal(wrappedMint.toBase58());
      expect(cfg.paused).to.equal(false);
    });
  });

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

  describe("mint_wrapped validation", () => {
    const recipient = Keypair.generate();

    async function attempt(payload: any, signer = relayer, nonceForPda?: bigint, badAccounts: any = {}) {
      const nonce = nonceForPda ?? BigInt(payload.nonce.toString());
      const recipientAta = await getAssociatedTokenAddress(wrappedMint, recipient.publicKey);
      const chainId = payload.sourceChainId ?? SOURCE_CHAIN_ID;
      const bridge = Buffer.isBuffer(payload.sourceBridge)
        ? payload.sourceBridge
        : Buffer.from(payload.sourceBridge ?? Array.from(SOURCE_BRIDGE));
      const processedMessage = processedPda(
        program.programId,
        chainId,
        bridge,
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
      // The PDA is derived from payload.sourceChainId, so the seed mismatches the
      // bound config — request must hit InvalidSource (or a seed error).
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
});
