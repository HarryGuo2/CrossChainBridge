# Solana ↔ Relayer / Ethereum coordination

Maintainer: Aaron
Last updated: 2026-04-25

## What changed in the IDL

Compared to the pre-Anchor draft IDL, the program now:

- `BridgePayload` is a **fixed-width binary struct**:
  - Strings replaced with raw byte arrays.
  - Adds `version` (u8), `sourceChainId` (u16), `sourceBridge` ([u8;20]), `sourceToken` ([u8;20]), `senderEth` ([u8;20]), `recipientSol` ([u8;32]), `sourceTxHash` ([u8;32]), `sourceLogIndex` (u32).
  - Drops `sourceChain` / `targetChain` strings (replaced by numeric `sourceChainId`).
- New singleton account `BridgeConfig` (PDA `["config"]`).
- `mintWrapped` requires additional accounts: `config`, `mintAuthority`, `recipient`.
- `processedMessage` PDA seeds are now `["processed", sourceChainId_le, sourceBridge, nonce_le]` — not just `["processed", nonce]`.

## What the relayer needs to change in `src/submitter.ts`

Replace the existing `bridgePayload` object construction with:

```typescript
import bs58 from "bs58";

const bridgePayload = {
  version: 1,
  sourceChainId: 1,                                                  // Sepolia domain
  sourceBridge: Array.from(Buffer.from(config.ETH_BRIDGE_ADDRESS.replace(/^0x/, ""), "hex")),
  sourceToken:  Array.from(Buffer.from(config.ETH_TOKEN_ADDRESS.replace(/^0x/, ""),  "hex")),
  nonce: new BN(msg.nonce),
  amount: new BN(msg.amount),                                        // throws if amount > u64::MAX
  senderEth:   Array.from(Buffer.from(msg.sender.replace(/^0x/, ""), "hex")),
  recipientSol: Array.from(bs58.decode(msg.recipient)),              // 32 bytes
  sourceTxHash: Array.from(Buffer.from(msg.sourceTxHash.replace(/^0x/, ""), "hex")),
  sourceLogIndex: msg.logIndex ?? 0,
};
```

The `mintWrapped` call now also needs:
- `config` (PDA `["config"]`)
- `mintAuthority` (PDA `["mint_authority"]`)
- `recipient` (the wallet pubkey — same as `payload.recipientSol` but as a `PublicKey`)

The `processedMessage` PDA derivation changes:

```typescript
const chainBuf = Buffer.alloc(2); chainBuf.writeUInt16LE(1, 0);
const nonceBuf = Buffer.alloc(8); nonceBuf.writeBigUInt64LE(BigInt(msg.nonce), 0);
const [processedMessagePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("processed"), chainBuf, sourceBridgeBytes, nonceBuf],
  programId
);
```

The relayer also needs to issue an idempotent ATA-creation instruction in the same transaction before `mintWrapped`, since the Solana program no longer creates ATAs itself:

```typescript
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";

const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
  relayerPubkey, recipientAta, recipientPubkey, wrappedMint
);

await program.methods.mintWrapped(payload)
  .accounts({ /* see new accounts list above */ })
  .preInstructions([createAtaIx])
  .rpc();
```

## What `.env` keys the relayer must add

```
ETH_TOKEN_ADDRESS=0x...        # the bound ERC-20 from Yang's deployment
SOL_BRIDGE_CONFIG=...          # printed at end of `anchor:initialize`
SOL_MINT_AUTHORITY=...         # printed at end of `anchor:initialize`
SOL_AUTHORIZED_RELAYER=...     # the relayer pubkey we initialized BridgeConfig with
```

## Devnet deployment artifacts

**Status as of 2026-04-25: Devnet deployment pending.** The Anchor program is built and the IDL is regenerated. Local `anchor test` passes (16/16). The Devnet `anchor deploy` step was not run because the deployer keypair `DXMeqSthTy7Cf2E4mpSheTduDDKq9saddTPsnkVs4ziT` had no Devnet SOL and the CLI airdrop endpoint was rate-limited.

To complete Devnet deployment:

1. Fund `DXMeqSthTy7Cf2E4mpSheTduDDKq9saddTPsnkVs4ziT` with ≥3 SOL on Devnet (use https://faucet.solana.com/).
2. Run from repo root:
   ```bash
   export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
   solana config set --url devnet
   anchor deploy --provider.cluster devnet
   RELAYER_PUBKEY=<from Leah & Harry, or DXMeq... if reusing the deployer> \
     ETH_BRIDGE_ADDRESS=<from Yang> \
     ETH_TOKEN_ADDRESS=<from Yang> \
     ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
     ANCHOR_WALLET=~/.config/solana/id.json \
     npm run anchor:initialize
   solana config set --url localhost
   ```
3. Capture the `=== DEPLOYMENT ARTIFACTS ===` block printed at the end and fill in the table below.

```
SOL_PROGRAM_ID=FaWcnbmoyN1SWfUaio4cJAC2HokPgukzKhhk1hZrh4De   # baked into the binary, fixed
SOL_WRAPPED_MINT=<TBD after Devnet deploy>
SOL_BRIDGE_CONFIG=<TBD after Devnet deploy>
SOL_MINT_AUTHORITY=<TBD after Devnet deploy>
SOL_AUTHORIZED_RELAYER=<TBD after Devnet deploy>
```

## What Yang needs to share

- Sepolia `EthBridge.sol` deployed address (20-byte hex).
- Sepolia `TestToken.sol` (the bound ERC-20) deployed address (20-byte hex).
- Confirmation that the `Locked` event includes `sourceTxHash` as `bytes32` and that the `recipient` parameter is `bytes32` (raw 32-byte Solana pubkey, not base58 string).

## Risks if these are missed

- If the relayer encodes a string-based payload, `mintWrapped` fails on the first call (Borsh size mismatch).
- If the ATA pre-instruction is forgotten, `mintWrapped` fails with `AccountNotInitialized`.
- If `ETH_TOKEN_ADDRESS` doesn't match what was passed to `initialize`, every mint fails with `InvalidSource`.
- If `BridgeConfig` was initialized with placeholder addresses (zeros), every real mint will fail with `InvalidSource` until the program is redeployed/reinitialized with real addresses (see Devnet section above for re-initialization workaround).
