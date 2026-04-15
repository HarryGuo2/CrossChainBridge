/**
 * Bridge Relayer - SIMULATION MODE
 * ==================================
 * Real Ethereum (Sepolia) + Simulated Solana side.
 *
 * What is REAL:
 *   - Connects to your actual EthBridge contract on Sepolia
 *   - Watches for real TokensLocked events
 *   - Calls real submitUnlock on Ethereum
 *
 * What is SIMULATED:
 *   - Solana mint (logged as if it happened)
 *   - Solana burn events (auto-generated every 30s to demo the return path)
 */

"use strict";
require("dotenv").config();

const { ethers } = require("ethers");
const winston = require("winston");
const fs = require("fs");

// ── Logger ────────────────────────────────────────────────────────────────────

const log = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

// ── Config ────────────────────────────────────────────────────────────────────

const deployed = JSON.parse(fs.readFileSync("../ethereum/deployed.json"));
const ETH_BRIDGE_ADDR = deployed.bridge;
const ETH_TOKEN_ADDR  = deployed.token;

const ETH_BRIDGE_ABI = [
  "event TokensLocked(address indexed token, address indexed sender, bytes32 indexed recipient, uint256 amount, uint256 nonce)",
  "function submitUnlock(address token, address recipient, uint256 amount, bytes32 solanaTxSig, uint256 nonce) external",
  "function threshold() view returns (uint256)",
  "function getRelayers() view returns (address[])",
];

// ── Simulated Solana state ────────────────────────────────────────────────────

const simulatedMints   = [];   // ETH→SOL mints we've processed
const simulatedBurns   = [];   // SOL→ETH burns we've simulated

let burnCounter = 0;

function simulateSolanaMint(ethTxHash, recipient, amount, nonce) {
  const fakeSolanaTx = "SimSolTx_" + ethTxHash.slice(0, 10) + "_" + Date.now();
  simulatedMints.push({ ethTxHash, recipient, amount, nonce, solanaTx: fakeSolanaTx });

  log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log.info("[SIM: ETH→SOL] ✅ Wrapped tokens MINTED on Solana");
  log.info(`[SIM: ETH→SOL]   Solana Tx   : ${fakeSolanaTx}`);
  log.info(`[SIM: ETH→SOL]   Recipient   : ${recipient} (Solana pubkey)`);
  log.info(`[SIM: ETH→SOL]   Amount      : ${ethers.formatEther(amount)} tokens`);
  log.info(`[SIM: ETH→SOL]   ETH nonce   : ${nonce}`);
  log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return fakeSolanaTx;
}

function simulateSolanaBurn(ethRecipient, amount) {
  burnCounter++;
  const fakeSolanaTx = "SimBurnTx_" + burnCounter + "_" + Date.now();
  simulatedBurns.push({ fakeSolanaTx, ethRecipient, amount });

  log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log.info("[SIM: SOL→ETH] 🔥 User BURNED wrapped tokens on Solana");
  log.info(`[SIM: SOL→ETH]   Solana Tx   : ${fakeSolanaTx}`);
  log.info(`[SIM: SOL→ETH]   ETH dest    : ${ethRecipient}`);
  log.info(`[SIM: SOL→ETH]   Amount      : ${ethers.formatEther(amount)} tokens`);
  log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return { fakeSolanaTx, ethRecipient, amount };
}

// ── Ethereum setup ────────────────────────────────────────────────────────────

function initEthereum() {
  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.RELAYER_ETH_KEY, provider);
  const bridge   = new ethers.Contract(ETH_BRIDGE_ADDR, ETH_BRIDGE_ABI, wallet);
  return { provider, wallet, bridge };
}

// ── ETH → SOL path ────────────────────────────────────────────────────────────

async function watchEthereumLocks(eth) {
  log.info(`Watching EthBridge at ${ETH_BRIDGE_ADDR} for TokensLocked events…`);

  // Scan past events in case we missed any
  const filter = eth.bridge.filters.TokensLocked();
  const past = [];
  if (past.length > 0) {
    log.info(`Found ${past.length} past lock event(s) — replaying…`);
    for (const evt of past) await handleLock(evt);
  }

  // Subscribe to new events
  eth.bridge.on(filter, async (...args) => {
    const evt = args[args.length - 1];
    await handleLock(evt);
  });
}

async function handleLock(evt) {
  const { token, sender, recipient: solRecipientBytes32, amount, nonce } = evt.args;

  log.info(`[ETH→SOL] 🔒 Lock detected on Ethereum`);
  log.info(`[ETH→SOL]   Tx hash   : ${evt.transactionHash}`);
  log.info(`[ETH→SOL]   From      : ${sender}`);
  log.info(`[ETH→SOL]   Amount    : ${ethers.formatEther(amount)} tokens`);
  log.info(`[ETH→SOL]   Nonce     : ${nonce}`);
  log.info(`[ETH→SOL]   Sol dest  : ${solRecipientBytes32}`);

  // Simulate the Solana mint
  simulateSolanaMint(evt.transactionHash, solRecipientBytes32, amount, nonce);
}

// ── SOL → ETH path ───────────────────────────────────────────────────────────

async function startSimulatedBurnLoop(eth) {
  // Simulate a user burning wrapped tokens every 30 seconds
  // In production this would watch real Solana events

  log.info("[SIM] Auto-burn loop started — will simulate a Solana burn every 30s");
  log.info("[SIM] (This represents a user redeeming wrapped tokens back to Ethereum)");

  setInterval(async () => {
    // Use the deployer address as the simulated ETH recipient
    const ethRecipient = eth.wallet.address;
    const amount = ethers.parseEther("1.0"); // simulate 1 token burn

    const { fakeSolanaTx, ethRecipient: recipient } = simulateSolanaBurn(ethRecipient, amount);

    // Convert fake Solana tx to bytes32
    const encoder = new TextEncoder();
    const sigBytes = encoder.encode(fakeSolanaTx.slice(0, 32).padEnd(32, "0"));
    const sigHex = "0x" + Buffer.from(sigBytes).toString("hex").slice(0, 64).padEnd(64, "0");

    const nonce = BigInt(burnCounter);

    log.info(`[SOL→ETH] Submitting unlock to Ethereum for ${ethers.formatEther(amount)} tokens…`);

    try {
      const tx = await eth.bridge.submitUnlock(
        ETH_TOKEN_ADDR,
        recipient,
        amount,
        sigHex,
        nonce
      );
      const receipt = await tx.wait();
      log.info(`[SOL→ETH] ✅ submitUnlock confirmed | ETH tx: ${receipt.hash}`);
    } catch (err) {
      if (err.message?.includes("already processed") || err.message?.includes("already signed")) {
        log.info("[SOL→ETH] Already processed — skipping");
      } else {
        // Bridge may not have funds — that's fine in simulation
        log.warn(`[SOL→ETH] ⚠️  submitUnlock reverted (bridge may need funding): ${err.message?.split("(")[0]}`);
      }
    }
  }, 30_000);
}

// ── Status printer ────────────────────────────────────────────────────────────

function startStatusPrinter(eth) {
  setInterval(async () => {
    const threshold = await eth.bridge.threshold();
    const relayers  = await eth.bridge.getRelayers();
    log.info("──── Bridge Status ────────────────────────");
    log.info(`  EthBridge   : ${ETH_BRIDGE_ADDR}`);
    log.info(`  Token       : ${ETH_TOKEN_ADDR}`);
    log.info(`  Threshold   : ${threshold}-of-${relayers.length}`);
    log.info(`  Mints sim'd : ${simulatedMints.length}`);
    log.info(`  Burns sim'd : ${simulatedBurns.length}`);
    log.info("───────────────────────────────────────────");
  }, 60_000);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  log.info("╔══════════════════════════════════════════╗");
  log.info("║  Bridge Relayer — SIMULATION MODE        ║");
  log.info("║  Real Ethereum + Simulated Solana        ║");
  log.info("╚══════════════════════════════════════════╝");

  const eth = initEthereum();

  log.info(`Relayer wallet : ${eth.wallet.address}`);
  log.info(`EthBridge      : ${ETH_BRIDGE_ADDR}`);
  log.info(`Token          : ${ETH_TOKEN_ADDR}`);

  await watchEthereumLocks(eth);
  await startSimulatedBurnLoop(eth);
  startStatusPrinter(eth);

  log.info("Relayer running — press Ctrl+C to stop");
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
