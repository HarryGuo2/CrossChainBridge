/**
 * Bridge Relayer
 * ==============
 * Watches both chains and relays cross-chain messages:
 *
 *  Ethereum → Solana  (ETH lock  → SOL mint)
 *    Listen for `TokensLocked` events on EthBridge, call `submit_mint`
 *    on the Solana bridge program.  Repeats until threshold is reached.
 *
 *  Solana   → Ethereum  (SOL burn → ETH unlock)
 *    Poll for `BurnedEvent` logs on the Solana program, then call
 *    `submitUnlock` on EthBridge once per relayer wallet.
 *
 * k-of-n design
 * -------------
 * Each relayer instance holds ONE wallet per chain and submits exactly one
 * signature per event.  Deploy N independent instances (each with a different
 * RELAYER_ETH_KEY / RELAYER_SOL_KEY) to form the committee.
 */

"use strict";
require("dotenv").config();

const { ethers } = require("ethers");
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount } = require("@solana/spl-token");
const bs58 = require("bs58");
const winston = require("winston");
const fs = require("fs");

// ── Logger ────────────────────────────────────────────────────────────────────

const log = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

// ── Config ────────────────────────────────────────────────────────────────────

const ETH_RPC      = process.env.ETH_RPC_URL;
const SOL_RPC      = process.env.SOL_RPC_URL || "https://api.devnet.solana.com";
const RELAYER_ETH_KEY = process.env.RELAYER_ETH_KEY;   // hex private key
const RELAYER_SOL_KEY = process.env.RELAYER_SOL_KEY;   // base58 private key

// Addresses loaded from the Ethereum deploy script output
const deployed        = JSON.parse(fs.readFileSync("../ethereum/deployed.json"));
const ETH_BRIDGE_ADDR = deployed.bridge;
const ETH_TOKEN_ADDR  = deployed.token;

const SOL_PROGRAM_ID  = new PublicKey(process.env.SOL_PROGRAM_ID);
const SOL_WRAPPED_MINT = new PublicKey(process.env.SOL_WRAPPED_MINT);

// How far back to scan on startup (blocks / slots)
const ETH_START_BLOCK  = parseInt(process.env.ETH_START_BLOCK || "0", 10);
const SOL_POLL_INTERVAL_MS = parseInt(process.env.SOL_POLL_MS || "5000", 10);

// ── ABIs ──────────────────────────────────────────────────────────────────────

const ETH_BRIDGE_ABI = [
  "event TokensLocked(address indexed token, address indexed sender, bytes32 indexed recipient, uint256 amount, uint256 nonce)",
  "function submitUnlock(address token, address recipient, uint256 amount, bytes32 solanaTxSig, uint256 nonce) external",
];

// ── Initialise clients ────────────────────────────────────────────────────────

function initEthereum() {
  const provider = new ethers.JsonRpcProvider(ETH_RPC);
  const wallet   = new ethers.Wallet(RELAYER_ETH_KEY, provider);
  const bridge   = new ethers.Contract(ETH_BRIDGE_ADDR, ETH_BRIDGE_ABI, wallet);
  log.info(`ETH relayer address: ${wallet.address}`);
  return { provider, wallet, bridge };
}

function initSolana() {
  const connection = new Connection(SOL_RPC, "confirmed");
  const secretKey  = bs58.decode(RELAYER_SOL_KEY);
  const keypair    = Keypair.fromSecretKey(secretKey);
  log.info(`SOL relayer address: ${keypair.publicKey.toBase58()}`);
  return { connection, keypair };
}

// ── ETH → SOL  (mint path) ────────────────────────────────────────────────────

/**
 * Listen for `TokensLocked` on EthBridge and call `submit_mint` on Solana.
 */
async function watchEthereumLocks(eth, sol, program) {
  log.info("Watching Ethereum for TokensLocked events…");

  // Process historical events first (useful after relayer restart)
  const filter = eth.bridge.filters.TokensLocked();
  const past = await eth.bridge.queryFilter(filter, ETH_START_BLOCK, "latest");
  for (const evt of past) {
    await handleLock(evt, eth, sol, program);
  }

  // Subscribe to new events
  eth.bridge.on(filter, async (...args) => {
    const evt = args[args.length - 1]; // last arg is the event object
    await handleLock(evt, eth, sol, program);
  });
}

async function handleLock(evt, eth, sol, program) {
  const { token, sender, recipient: solRecipientBytes32, amount, nonce } =
    evt.args;

  // recipient is a 32-byte Solana public key stored in a bytes32 field
  const solRecipientPubkey = new PublicKey(
    Buffer.from(solRecipientBytes32.slice(2), "hex")
  );

  const ethTxHash = Array.from(
    Buffer.from(evt.transactionHash.slice(2), "hex")
  );

  log.info(
    `[ETH→SOL] Lock detected | tx=${evt.transactionHash} | amount=${ethers.formatEther(amount)} | nonce=${nonce}`
  );

  try {
    // Get or create the recipient's associated token account
    const recipientATA = await getOrCreateAssociatedTokenAccount(
      sol.connection,
      sol.keypair,
      SOL_WRAPPED_MINT,
      solRecipientPubkey
    );

    // Derive bridge state PDA
    const [bridgeStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge_state")],
      SOL_PROGRAM_ID
    );

    // Derive pending_mint PDA
    const [pendingMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_mint"), Buffer.from(ethTxHash)],
      SOL_PROGRAM_ID
    );

    const tx = await program.methods
      .submitMint(
        ethTxHash,
        new anchor.BN(amount.toString()),
        new anchor.BN(nonce.toString())
      )
      .accounts({
        bridgeState: bridgeStatePDA,
        pendingMint: pendingMintPDA,
        wrappedMint: SOL_WRAPPED_MINT,
        recipientTokenAccount: recipientATA.address,
        relayer: sol.keypair.publicKey,
      })
      .signers([sol.keypair])
      .rpc();

    log.info(`[ETH→SOL] submit_mint sent | solTx=${tx}`);
  } catch (err) {
    // AlreadySigned / AlreadyExecuted are expected when other relayers are faster
    if (err.message?.includes("AlreadySigned") || err.message?.includes("AlreadyExecuted")) {
      log.info(`[ETH→SOL] Already handled by another relayer — skipping`);
    } else {
      log.error(`[ETH→SOL] Error: ${err.message}`);
    }
  }
}

// ── SOL → ETH  (unlock path) ──────────────────────────────────────────────────

/**
 * Poll Solana program logs for `BurnedEvent` and call `submitUnlock` on
 * the Ethereum bridge contract.
 *
 * Solana does not have a native event subscription as convenient as ethers,
 * so we poll `getSignaturesForAddress` on a short interval and track the
 * last processed signature to avoid duplicates.
 */
async function watchSolanaBurns(eth, sol) {
  log.info("Watching Solana for BurnedEvent logs…");

  let lastSig = null;

  setInterval(async () => {
    try {
      const sigs = await sol.connection.getSignaturesForAddress(
        SOL_PROGRAM_ID,
        { until: lastSig || undefined, limit: 50 },
        "confirmed"
      );

      if (sigs.length === 0) return;
      lastSig = sigs[0].signature;

      for (const sigInfo of sigs.reverse()) {
        if (sigInfo.err) continue;

        const tx = await sol.connection.getParsedTransaction(
          sigInfo.signature,
          { maxSupportedTransactionVersion: 0 }
        );

        if (!tx?.meta?.logMessages) continue;

        const burnLog = tx.meta.logMessages.find((l) =>
          l.includes("BurnedEvent")
        );
        if (!burnLog) continue;

        await handleBurn(sigInfo.signature, tx, eth);
      }
    } catch (err) {
      log.error(`[SOL→ETH] Poll error: ${err.message}`);
    }
  }, SOL_POLL_INTERVAL_MS);
}

/**
 * Parse a Solana burn transaction and submit an unlock request to Ethereum.
 *
 * NOTE: In production, use the Anchor event parser (program.addEventListener)
 * or a dedicated indexer to decode the BornedEvent fields reliably.  The log
 * parsing below is a simplified stand-in suitable for a course project.
 */
async function handleBurn(solanaTxSig, tx, eth) {
  const logs = tx.meta.logMessages;

  // Very basic extraction — replace with proper Anchor event decoding
  const ethRecipientLog = logs.find((l) => l.includes("eth_recipient"));
  const amountLog       = logs.find((l) => l.includes("amount"));
  if (!ethRecipientLog || !amountLog) return;

  const ethRecipient = "0x" + ethRecipientLog.split(":")[1].trim().slice(0, 40);
  const amount = BigInt(amountLog.split(":")[1].trim());
  const nonce  = BigInt(tx.slot); // use slot as nonce proxy

  // Convert Solana tx sig (base58) to bytes32 for the Ethereum call
  const sigBytes = bs58.decode(solanaTxSig);
  const sigBytes32 = ethers.zeroPadBytes(sigBytes.slice(0, 32), 32);

  log.info(
    `[SOL→ETH] Burn detected | solanaTx=${solanaTxSig} | to=${ethRecipient} | amount=${amount}`
  );

  try {
    const tx = await eth.bridge.submitUnlock(
      ETH_TOKEN_ADDR,
      ethRecipient,
      amount,
      sigBytes32,
      nonce
    );
    const receipt = await tx.wait();
    log.info(`[SOL→ETH] submitUnlock confirmed | ethTx=${receipt.hash}`);
  } catch (err) {
    if (err.message?.includes("already processed") || err.message?.includes("already signed")) {
      log.info("[SOL→ETH] Already handled — skipping");
    } else {
      log.error(`[SOL→ETH] Error: ${err.message}`);
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  log.info("Starting bridge relayer…");

  const eth = initEthereum();
  const sol = initSolana();

  // Load the Solana program IDL (generated by `anchor build`)
  const idl = JSON.parse(
    fs.readFileSync("../solana/target/idl/sol_bridge.json")
  );
  const provider = new anchor.AnchorProvider(
    sol.connection,
    new anchor.Wallet(sol.keypair),
    { commitment: "confirmed" }
  );
  const program = new anchor.Program(idl, SOL_PROGRAM_ID, provider);

  await watchEthereumLocks(eth, sol, program);
  await watchSolanaBurns(eth, sol);

  log.info("Relayer running — press Ctrl+C to stop");
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
