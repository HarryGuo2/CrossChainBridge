import { expect } from "chai";
import hre from "hardhat";

describe("EthBridge", function () {
  let ethers: any, networkHelpers: any;

  before(async function () {
    const connected = await hre.network.connect();
    ethers = connected.ethers;
    networkHelpers = connected.networkHelpers;
  });

  async function fixture() {
    const [owner, user, relayer, attacker] = await ethers.getSigners();

    const token: any = await ethers.deployContract("TestToken", [
      await owner.getAddress(),
    ]);
    await token.waitForDeployment();

    const bridge: any = await ethers.deployContract("EthBridge", [
      await owner.getAddress(),
      await relayer.getAddress(),
    ]);
    await bridge.waitForDeployment();

    await token.mint(await user.getAddress(), ethers.parseEther("1000"));

    const recipient = ethers.hexlify(ethers.randomBytes(32));

    return { owner, user, relayer, attacker, token, bridge, recipient };
  }

  it("locks tokens and emits Locked", async function () {
    const { user, token, bridge, recipient } =
      await networkHelpers.loadFixture(fixture);

    const amount = ethers.parseEther("10");
    await token.connect(user).approve(await bridge.getAddress(), amount);

    await expect(
      bridge.connect(user).lockTokens(
        recipient,
        await token.getAddress(),
        amount,
        "solana"
      )
    ).to.emit(bridge, "Locked");

    expect(await token.balanceOf(await bridge.getAddress())).to.equal(amount);
    expect(await bridge.nextNonce()).to.equal(2n);
  });
});