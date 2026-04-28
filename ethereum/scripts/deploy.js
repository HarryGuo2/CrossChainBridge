const { ethers } = require("hardhat");
require("dotenv").config();

/**
 * Deploy BridgeToken + EthBridge to the configured network.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network sepolia
 *
 * Env vars required:
 *   DEPLOYER_PRIVATE_KEY, ETH_RPC_URL
 *   RELAYER_1_ADDRESS … RELAYER_N_ADDRESS  (comma-separated in RELAYER_ADDRESSES)
 *   BRIDGE_THRESHOLD   (default: 2)
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // ── Relayer committee ──────────────────────────────────────────────────────
  const rawRelayers = process.env.RELAYER_ADDRESSES || deployer.address;
  const relayerAddresses = rawRelayers.split(",").map((s) => s.trim());
  const threshold = parseInt(process.env.BRIDGE_THRESHOLD || "1", 10);

  console.log(`Relayers (${relayerAddresses.length}):`, relayerAddresses);
  console.log("Threshold:", threshold);

  // ── BridgeToken ────────────────────────────────────────────────────────────
  const Token = await ethers.getContractFactory("BridgeToken");
  const token = await Token.deploy("Bridge USD", "bUSD", 1_000_000);
  await token.waitForDeployment();
  console.log("BridgeToken deployed to:", await token.getAddress());

  // ── EthBridge ──────────────────────────────────────────────────────────────
  const Bridge = await ethers.getContractFactory("EthBridge");
  const bridge = await Bridge.deploy(relayerAddresses, threshold);
  await bridge.waitForDeployment();
  console.log("EthBridge deployed to:", await bridge.getAddress());

  // ── Persist addresses for the relayer service ──────────────────────────────
  const fs = require("fs");
  const out = {
    network: (await ethers.provider.getNetwork()).name,
    token: await token.getAddress(),
    bridge: await bridge.getAddress(),
    relayers: relayerAddresses,
    threshold,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync("deployed.json", JSON.stringify(out, null, 2));
  console.log("Addresses saved to deployed.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
