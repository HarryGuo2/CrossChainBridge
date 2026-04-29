import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "../target/idl/bridge.json";

const PROGRAM_ID = new PublicKey("FaWcnbmoyN1SWfUaio4cJAC2HokPgukzKhhk1hZrh4De");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as anchor.Idl, PROGRAM_ID, provider);
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );

  const sourceChainId = parseInt(process.env.SOURCE_CHAIN_ID ?? "1", 10);
  const sourceBridge = hex20(process.env.ETH_BRIDGE_ADDRESS!);
  const sourceToken  = hex20(process.env.ETH_TOKEN_ADDRESS!);

  console.log("Updating BridgeConfig source binding:");
  console.log("  config:        ", configPda.toBase58());
  console.log("  source_chain:  ", sourceChainId);
  console.log("  source_bridge: 0x" + sourceBridge.toString("hex"));
  console.log("  source_token:  0x" + sourceToken.toString("hex"));

  await program.methods
    .setSourceBinding({
      sourceChainId,
      sourceBridge: Array.from(sourceBridge),
      sourceToken:  Array.from(sourceToken),
    })
    .accounts({ admin: admin.publicKey, config: configPda })
    .rpc();

  const cfg = await program.account.bridgeConfig.fetch(configPda);
  console.log("\nVerified post-update:");
  console.log("  sourceChainId:", cfg.sourceChainId);
  console.log("  sourceBridge: 0x" + Buffer.from(cfg.sourceBridge as number[]).toString("hex"));
  console.log("  sourceToken:  0x" + Buffer.from(cfg.sourceToken as number[]).toString("hex"));
}

function hex20(hex: string): Buffer {
  const stripped = hex.replace(/^0x/, "");
  if (stripped.length !== 40) throw new Error(`expected 20-byte hex, got ${stripped.length / 2} bytes`);
  return Buffer.from(stripped, "hex");
}

main().catch((e) => { console.error(e); process.exit(1); });
