import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  setAuthority,
  AuthorityType,
} from "@solana/spl-token";
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

  console.log("\n[1/3] Creating wrapped SPL mint...");
  const wrappedMint = await createMint(
    provider.connection,
    admin,
    admin.publicKey,
    null,
    6
  );
  console.log("Wrapped Mint       :", wrappedMint.toBase58());

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
