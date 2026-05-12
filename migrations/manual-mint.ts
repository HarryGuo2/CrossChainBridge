import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ethers } from "ethers";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("FaWcnbmoyN1SWfUaio4cJAC2HokPgukzKhhk1hZrh4De");

/**
 * One-off `mint_wrapped` submission for a known Ethereum tx hash.
 *
 * Usage:
 *   ts-node migrations/manual-mint.ts --tx 0x<hash>
 *   ts-node migrations/manual-mint.ts --tx 0x<hash> --expect-fail
 *
 * With --expect-fail, the script EXPECTS the on-chain submission to fail
 * with "account already in use" (the replay-protection defense). Used to
 * demo replay rejection on camera.
 *
 * Required env:
 *   ANCHOR_PROVIDER_URL   Solana RPC (Devnet for demo)
 *   ANCHOR_WALLET         path to relayer keypair file
 *   ETH_RPC_URL           Sepolia RPC
 *   ETH_BRIDGE_ADDRESS    deployed bridge contract
 *   ETH_TOKEN_ADDRESS     deployed bUSD contract
 */

const SOURCE_CHAIN_ID = 1;
// Ethereum bUSD has 18 decimals; Solana wrapped mint has 6. We rescale the
// uint256 source amount down by 10^12 before fitting into the u64 payload.
const ETH_DECIMALS = 18;
const SOL_DECIMALS = 6;
const SCALE_DIVISOR = 10n ** BigInt(ETH_DECIMALS - SOL_DECIMALS); // 10^12
const TOKENS_LOCKED_ABI = [
  "event TokensLocked(address indexed token, address indexed sender, bytes32 indexed recipient, uint256 amount, uint256 nonce)",
];

interface Args { txHash: string; expectFail: boolean; }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let txHash = "";
  let expectFail = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tx") txHash = argv[++i] ?? "";
    else if (argv[i] === "--expect-fail") expectFail = true;
  }
  if (!txHash || !txHash.startsWith("0x")) {
    console.error("Usage: ts-node migrations/manual-mint.ts --tx <0x...hash> [--expect-fail]");
    process.exit(1);
  }
  return { txHash, expectFail };
}

function require20(buf: Buffer, label: string): void {
  if (buf.length !== 20) throw new Error(`${label} expected 20 bytes, got ${buf.length}`);
}
function require32(buf: Buffer, label: string): void {
  if (buf.length !== 32) throw new Error(`${label} expected 32 bytes, got ${buf.length}`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  // ── Ethereum side: fetch the TokensLocked event ───────────────────────────
  const ethRpc    = process.env.ETH_RPC_URL!;
  const ethBridge = process.env.ETH_BRIDGE_ADDRESS!;
  const ethToken  = process.env.ETH_TOKEN_ADDRESS!;
  if (!ethRpc || !ethBridge || !ethToken) {
    throw new Error("ETH_RPC_URL, ETH_BRIDGE_ADDRESS, ETH_TOKEN_ADDRESS must all be set");
  }

  const ethProvider = new ethers.JsonRpcProvider(ethRpc);
  const iface = new ethers.Interface(TOKENS_LOCKED_ABI);
  const topic = ethers.id("TokensLocked(address,address,bytes32,uint256,uint256)");

  console.log(`Fetching tx receipt: ${args.txHash}`);
  const receipt = await ethProvider.getTransactionReceipt(args.txHash);
  if (!receipt) throw new Error("tx not found or not yet mined");
  console.log(`  block ${receipt.blockNumber}, status=${receipt.status}`);

  const evtLog = receipt.logs.find(
    (l) => l.address.toLowerCase() === ethBridge.toLowerCase() && l.topics[0] === topic
  );
  if (!evtLog) throw new Error("no TokensLocked event found in this tx receipt");

  const parsed = iface.parseLog({ topics: evtLog.topics as string[], data: evtLog.data });
  if (!parsed) throw new Error("could not parse TokensLocked log");

  const eSender     = parsed.args.sender as string;
  const eRecipient  = parsed.args.recipient as string;
  const eAmount     = parsed.args.amount as bigint;
  const eNonce      = parsed.args.nonce as bigint;

  console.log(`  TokensLocked: nonce=${eNonce}, amount=${eAmount}`);
  console.log(`    sender=${eSender}`);
  console.log(`    recipient(bytes32)=${eRecipient}`);

  // ── Pack the 147-byte binary BridgePayload ────────────────────────────────
  const sourceBridgeBytes = Buffer.from(ethBridge.replace(/^0x/, ""), "hex");
  const sourceTokenBytes  = Buffer.from(ethToken.replace(/^0x/, ""), "hex");
  const senderBytes       = Buffer.from(eSender.replace(/^0x/, ""), "hex");
  const recipientSolBytes = Buffer.from(eRecipient.slice(2), "hex");
  const sourceTxHashBytes = Buffer.from(args.txHash.replace(/^0x/, ""), "hex");

  require20(sourceBridgeBytes, "source_bridge");
  require20(sourceTokenBytes,  "source_token");
  require20(senderBytes,       "sender_eth");
  require32(recipientSolBytes, "recipient_sol");
  require32(sourceTxHashBytes, "source_tx_hash");

  // Scale Ethereum 18-decimal amount to Solana 6-decimal amount.
  if (eAmount % SCALE_DIVISOR !== 0n) {
    console.warn(`  WARN: amount ${eAmount} is not a whole multiple of 10^12; truncating low-decimal dust`);
  }
  const scaledAmount = eAmount / SCALE_DIVISOR;
  const amountBN = new BN(scaledAmount.toString());
  if (amountBN.bitLength() > 64) throw new Error(`scaled amount ${scaledAmount} exceeds u64::MAX`);
  console.log(`  amount: ${eAmount} (ETH 18dp) -> ${scaledAmount} (SOL 6dp)`);

  // ── Solana side: PDAs, accounts, call ─────────────────────────────────────
  const aProvider = anchor.AnchorProvider.env();
  anchor.setProvider(aProvider);
  const idlPath = path.resolve(__dirname, "..", "idl", "bridge.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(idl, PROGRAM_ID, aProvider) as any;
  const relayer = (aProvider.wallet as anchor.Wallet).payer;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    program.programId
  );

  const cfg = await program.account.bridgeConfig.fetch(configPda);
  const wrappedMint = cfg.wrappedMint;

  const chainBuf = Buffer.alloc(2);  chainBuf.writeUInt16LE(SOURCE_CHAIN_ID, 0);
  const nonceBuf = Buffer.alloc(8);  nonceBuf.writeBigUInt64LE(BigInt(eNonce.toString()), 0);
  const [processedMessage] = PublicKey.findProgramAddressSync(
    [Buffer.from("processed"), chainBuf, sourceBridgeBytes, nonceBuf],
    program.programId
  );

  const recipientPubkey = new PublicKey(recipientSolBytes);
  const recipientAta = await getAssociatedTokenAddress(wrappedMint, recipientPubkey);

  console.log(`\nSolana submission target:`);
  console.log(`  ProcessedMessage PDA : ${processedMessage.toBase58()}`);
  console.log(`  Recipient            : ${recipientPubkey.toBase58()}`);
  console.log(`  Recipient ATA        : ${recipientAta.toBase58()}`);
  console.log(`  Wrapped mint         : ${wrappedMint.toBase58()}`);
  console.log(`  Relayer signer       : ${relayer.publicKey.toBase58()}`);

  const payload = {
    version: 1,
    sourceChainId: SOURCE_CHAIN_ID,
    sourceBridge: Array.from(sourceBridgeBytes),
    sourceToken:  Array.from(sourceTokenBytes),
    nonce:  new BN(eNonce.toString()),
    amount: amountBN,
    senderEth:    Array.from(senderBytes),
    recipientSol: Array.from(recipientSolBytes),
    sourceTxHash: Array.from(sourceTxHashBytes),
    sourceLogIndex: evtLog.index ?? 0,
  };

  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    relayer.publicKey, recipientAta, recipientPubkey, wrappedMint
  );

  console.log(`\n${args.expectFail ? "Attempting replay (expect failure)…" : "Calling mintWrapped…"}`);

  try {
    const sig = await program.methods
      .mintWrapped(payload)
      .accounts({
        relayer: relayer.publicKey,
        config: configPda,
        processedMessage,
        wrappedMint,
        mintAuthority: mintAuthorityPda,
        recipient: recipientPubkey,
        recipientTokenAccount: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([createAtaIx])
      .rpc();

    if (args.expectFail) {
      console.error(`\nFAIL — replay attempt unexpectedly succeeded.`);
      console.error(`  signature: ${sig}`);
      console.error(`  (The ProcessedMessage PDA must have been deleted, or the nonce was never previously minted.)`);
      process.exit(1);
    }
    console.log(`\nMINT SUCCEEDED`);
    console.log(`  signature: ${sig}`);
    console.log(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  } catch (err: any) {
    const msg = (err.toString() + " " + (err.logs?.join(" ") ?? "")).toLowerCase();
    const looksLikeReplay = msg.includes("already in use") || msg.includes("allocate") || msg.includes("0x0");

    if (args.expectFail && looksLikeReplay) {
      console.log(`\nREPLAY REJECTED as expected.`);
      console.log(`  The ProcessedMessage PDA already exists on chain:`);
      console.log(`    ${processedMessage.toBase58()}`);
      console.log(`  Anchor's \`init\` constraint refuses to allocate it twice.`);
      console.log(`  This is the bridge's replay defense — the same mechanism prevents`);
      console.log(`  duplicate mints whether triggered by relayer retries, bugs, or attacks.`);
      return;
    }

    if (args.expectFail) {
      console.error(`\nFAIL — got an error, but not the replay-rejection signature:`);
      console.error(msg);
      process.exit(1);
    }

    console.error(`\nMINT FAILED:`);
    console.error(err.toString());
    if (err.logs) console.error(err.logs.join("\n"));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
