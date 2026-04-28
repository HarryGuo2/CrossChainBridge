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

  async function lockSampleTokens(user: any, token: any, bridge: any, recipient: string) {
    const amount = ethers.parseEther("10");
    await token.connect(user).approve(await bridge.getAddress(), amount);
    await bridge
      .connect(user)
      .lockTokens(recipient, await token.getAddress(), amount, "solana");
    return amount;
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

  it("reverts for zero recipient", async function () {
    const { user, token, bridge } = await networkHelpers.loadFixture(fixture);
    const amount = ethers.parseEther("10");
    await token.connect(user).approve(await bridge.getAddress(), amount);

    await expect(
      bridge
        .connect(user)
        .lockTokens(ethers.ZeroHash, await token.getAddress(), amount, "solana")
    ).to.be.revertedWithCustomError(bridge, "InvalidRecipient");
  });

  it("reverts for zero token", async function () {
    const { user, bridge, recipient } = await networkHelpers.loadFixture(fixture);

    await expect(
      bridge.connect(user).lockTokens(recipient, ethers.ZeroAddress, 1n, "solana")
    ).to.be.revertedWithCustomError(bridge, "InvalidToken");
  });

  it("reverts for zero amount", async function () {
    const { user, token, bridge, recipient } =
      await networkHelpers.loadFixture(fixture);

    await expect(
      bridge
        .connect(user)
        .lockTokens(recipient, await token.getAddress(), 0n, "solana")
    ).to.be.revertedWithCustomError(bridge, "InvalidAmount");
  });

  it("reverts for unsupported target chain", async function () {
    const { user, token, bridge, recipient } =
      await networkHelpers.loadFixture(fixture);
    const amount = ethers.parseEther("10");
    await token.connect(user).approve(await bridge.getAddress(), amount);

    await expect(
      bridge
        .connect(user)
        .lockTokens(recipient, await token.getAddress(), amount, "ethereum")
    ).to.be.revertedWithCustomError(bridge, "UnsupportedTargetChain");
  });

  it("blocks lock when paused", async function () {
    const { owner, user, token, bridge, recipient } =
      await networkHelpers.loadFixture(fixture);
    const amount = ethers.parseEther("10");
    await token.connect(user).approve(await bridge.getAddress(), amount);

    await bridge.connect(owner).pause();
    await expect(
      bridge
        .connect(user)
        .lockTokens(recipient, await token.getAddress(), amount, "solana")
    ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
  });

  it("only owner can pause/unpause and set relayer", async function () {
    const { relayer, attacker, bridge } = await networkHelpers.loadFixture(fixture);

    await expect(bridge.connect(attacker).pause())
      .to.be.revertedWithCustomError(bridge, "OwnableUnauthorizedAccount")
      .withArgs(await attacker.getAddress());

    await expect(bridge.connect(attacker).setRelayer(await attacker.getAddress()))
      .to.be.revertedWithCustomError(bridge, "OwnableUnauthorizedAccount")
      .withArgs(await attacker.getAddress());

    await expect(bridge.connect(relayer).setRelayer(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(bridge, "OwnableUnauthorizedAccount")
      .withArgs(await relayer.getAddress());
  });

  it("reverts setRelayer with zero address", async function () {
    const { owner, bridge } = await networkHelpers.loadFixture(fixture);

    await expect(bridge.connect(owner).setRelayer(ethers.ZeroAddress)).to.be
      .revertedWithCustomError(bridge, "InvalidRelayer");
  });

  it("only relayer can mark relayed", async function () {
    const { user, token, bridge, attacker, recipient } =
      await networkHelpers.loadFixture(fixture);

    await lockSampleTokens(user, token, bridge, recipient);

    await expect(
      bridge.connect(attacker).markRelayed(1n, ethers.hexlify(ethers.randomBytes(32)))
    )
      .to.be.revertedWithCustomError(bridge, "NotRelayer")
      .withArgs(await attacker.getAddress());
  });

  it("reverts markRelayed for unknown nonce", async function () {
    const { relayer, bridge } = await networkHelpers.loadFixture(fixture);

    await expect(
      bridge.connect(relayer).markRelayed(999n, ethers.hexlify(ethers.randomBytes(32)))
    )
      .to.be.revertedWithCustomError(bridge, "UnknownNonce")
      .withArgs(999n);
  });

  it("reverts markRelayed when nonce already relayed", async function () {
    const { user, token, bridge, relayer, recipient } =
      await networkHelpers.loadFixture(fixture);

    await lockSampleTokens(user, token, bridge, recipient);
    await bridge.connect(relayer).markRelayed(1n, ethers.hexlify(ethers.randomBytes(32)));

    await expect(
      bridge.connect(relayer).markRelayed(1n, ethers.hexlify(ethers.randomBytes(32)))
    )
      .to.be.revertedWithCustomError(bridge, "AlreadyRelayed")
      .withArgs(1n);
  });
});
