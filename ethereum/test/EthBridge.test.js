const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EthBridge", () => {
  let token, bridge;
  let owner, relayer1, relayer2, relayer3, user;
  const THRESHOLD = 2;

  beforeEach(async () => {
    [owner, relayer1, relayer2, relayer3, user] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("BridgeToken");
    token = await Token.deploy("Bridge USD", "bUSD", 1_000_000);

    const Bridge = await ethers.getContractFactory("EthBridge");
    bridge = await Bridge.deploy(
      [relayer1.address, relayer2.address, relayer3.address],
      THRESHOLD
    );

    // Fund user
    await token.transfer(user.address, ethers.parseEther("1000"));
    await token.connect(user).approve(await bridge.getAddress(), ethers.MaxUint256);
  });

  // ── lockTokens ─────────────────────────────────────────────────────────────

  it("emits TokensLocked with correct fields", async () => {
    const amount = ethers.parseEther("100");
    const solRecipient = ethers.encodeBytes32String("SolanaAddressHere123");

    await expect(
      bridge.connect(user).lockTokens(await token.getAddress(), amount, solRecipient)
    )
      .to.emit(bridge, "TokensLocked")
      .withArgs(await token.getAddress(), user.address, solRecipient, amount, 0);
  });

  it("increments nonce on each deposit", async () => {
    const amount = ethers.parseEther("10");
    const rec = ethers.encodeBytes32String("sol");

    await bridge.connect(user).lockTokens(await token.getAddress(), amount, rec);
    await bridge.connect(user).lockTokens(await token.getAddress(), amount, rec);

    expect(await bridge.depositNonce(await token.getAddress())).to.equal(2);
  });

  it("reverts on zero amount", async () => {
    await expect(
      bridge.connect(user).lockTokens(
        await token.getAddress(),
        0,
        ethers.encodeBytes32String("x")
      )
    ).to.be.revertedWith("Bridge: zero amount");
  });

  // ── submitUnlock (k-of-n) ──────────────────────────────────────────────────

  it("releases tokens only after threshold signatures", async () => {
    const amount = ethers.parseEther("50");
    const solanaSig = ethers.encodeBytes32String("solanaTxSig");
    const nonce = 7;
    const tokenAddr = await token.getAddress();

    // Pre-fund the bridge
    await token.transfer(await bridge.getAddress(), amount);

    const userBalBefore = await token.balanceOf(user.address);

    // First relayer signs — NOT yet released
    await bridge
      .connect(relayer1)
      .submitUnlock(tokenAddr, user.address, amount, solanaSig, nonce);
    expect(await token.balanceOf(user.address)).to.equal(userBalBefore);

    // Second relayer signs — threshold met, tokens released
    await expect(
      bridge
        .connect(relayer2)
        .submitUnlock(tokenAddr, user.address, amount, solanaSig, nonce)
    )
      .to.emit(bridge, "TokensUnlocked")
      .withArgs(tokenAddr, user.address, amount, solanaSig);

    expect(await token.balanceOf(user.address)).to.equal(userBalBefore + amount);
  });

  it("prevents replay of the same unlock", async () => {
    const amount = ethers.parseEther("10");
    const solanaSig = ethers.encodeBytes32String("sig");
    const nonce = 1;
    const tokenAddr = await token.getAddress();

    await token.transfer(await bridge.getAddress(), amount * 2n);

    await bridge.connect(relayer1).submitUnlock(tokenAddr, user.address, amount, solanaSig, nonce);
    await bridge.connect(relayer2).submitUnlock(tokenAddr, user.address, amount, solanaSig, nonce);

    // Third relayer tries the same message after it was already processed
    await expect(
      bridge.connect(relayer3).submitUnlock(tokenAddr, user.address, amount, solanaSig, nonce)
    ).to.be.revertedWith("Bridge: already processed");
  });

  it("prevents a relayer from signing twice", async () => {
    const amount = ethers.parseEther("10");
    const solanaSig = ethers.encodeBytes32String("sig2");
    const nonce = 2;
    const tokenAddr = await token.getAddress();

    await bridge.connect(relayer1).submitUnlock(tokenAddr, user.address, amount, solanaSig, nonce);
    await expect(
      bridge.connect(relayer1).submitUnlock(tokenAddr, user.address, amount, solanaSig, nonce)
    ).to.be.revertedWith("Bridge: already signed");
  });

  it("rejects non-relayer callers", async () => {
    await expect(
      bridge.connect(user).submitUnlock(
        await token.getAddress(),
        user.address,
        ethers.parseEther("1"),
        ethers.encodeBytes32String("sig"),
        0
      )
    ).to.be.revertedWith("Bridge: not a relayer");
  });
});
