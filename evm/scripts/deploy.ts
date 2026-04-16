import { network } from "hardhat";

const { ethers, networkName } = await network.connect();

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

async function main() {
  console.log(`Deploying to ${networkName}...`);

  const owner = must("OWNER_ADDRESS");
  const relayer = must("RELAYER_ADDRESS");

  const token = await ethers.deployContract("TestToken", [owner]);
  await token.waitForDeployment();

  const bridge = await ethers.deployContract("EthBridge", [owner, relayer]);
  await bridge.waitForDeployment();

  console.log("TestToken:", await token.getAddress());
  console.log("EthBridge:", await bridge.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});