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

**Note on `msg.logIndex`:** `BridgeMessage` in `src/types.ts` does not currently have a `logIndex` field. The relayer team must add `logIndex?: number` to the `BridgeMessage` interface and populate it from the Ethereum event log inside `src/listener.ts` (use `log.index` from the `ethers` `Log` object when processing each matched event). Without this, `sourceLogIndex` will always be 0, which is acceptable for correctness but loses provenance information.

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

## Required additions to `Config` interface and `loadConfig()` in the relayer

The four env vars listed below are referenced in `src/submitter.ts` but are **not yet present** in `src/types.ts` (`Config` interface) or `src/config.ts` (`loadConfig()`). The relayer team must add them before the submitter will compile and work end-to-end:

| Env var | Type | Notes |
|---|---|---|
| `ETH_TOKEN_ADDRESS` | `string` | The bound ERC-20 address from Yang's Sepolia deployment. Validated as a 42-char `0x…` hex string (same as `ETH_BRIDGE_ADDRESS`). |
| `SOL_BRIDGE_CONFIG` | `string` (optional) | Base58 PDA address `["config"]`. The relayer can derive this from `SOL_PROGRAM_ID` if omitted. |
| `SOL_MINT_AUTHORITY` | `string` (optional) | Base58 PDA address `["mint_authority"]`. Derivable from `SOL_PROGRAM_ID` if omitted. |
| `SOL_AUTHORIZED_RELAYER` | `string` | The relayer keypair's public key; must match what was passed to `initialize`. Used to sanity-check the loaded keypair at startup. |

Add these to the `Config` interface in `src/types.ts`:

```typescript
ETH_TOKEN_ADDRESS: string;
SOL_BRIDGE_CONFIG?: string;
SOL_MINT_AUTHORITY?: string;
SOL_AUTHORIZED_RELAYER: string;
```

And wire them up in `loadConfig()` in `src/config.ts`:

```typescript
ETH_TOKEN_ADDRESS: getEnvVar('ETH_TOKEN_ADDRESS'),
SOL_BRIDGE_CONFIG: process.env['SOL_BRIDGE_CONFIG'],        // optional
SOL_MINT_AUTHORITY: process.env['SOL_MINT_AUTHORITY'],      // optional
SOL_AUTHORIZED_RELAYER: getEnvVar('SOL_AUTHORIZED_RELAYER'),
```

## What `.env` keys the relayer must add

```
ETH_TOKEN_ADDRESS=0x...        # the bound ERC-20 from Yang's deployment
SOL_BRIDGE_CONFIG=...          # printed at end of `anchor:initialize`
SOL_MINT_AUTHORITY=...         # printed at end of `anchor:initialize`
SOL_AUTHORIZED_RELAYER=...     # the relayer pubkey we initialized BridgeConfig with
```

## Devnet deployment artifacts

**Status as of 2026-04-29: Deployed and updated on Devnet.** Program deployed with signature `5mhZbZiWSuunNUDQcdQo9pmNFRUfb2wb2kyPzEJ1eFSa33BPbCpTy6A9dtPSu9Kj3evGfCyJDXzPhN5s8GYnMjaT`. BridgeConfig source addresses set to Yang's deployed Sepolia contracts via `set_source_binding` (upgrade sig: `3wti7gzUShGnwEKCNyZLioZu6rkdhzb5TS88Vz2oDmq8ncrANxBQBYvmRLzLJjqGSFJE2j2Mw1VpXx16hfScjgWZ`): bridge `0xb2f3b8465c6ab97ba8a7d5bb813a914d29a5dd24`, token `0xd5f971eb46775dbd815ab866dfe888492acf7062`. To rebind source addresses in the future without redeploying, run `npm run anchor:update-source` (see `migrations/update-source-binding.ts`) with the appropriate `ETH_BRIDGE_ADDRESS`, `ETH_TOKEN_ADDRESS`, `SOURCE_CHAIN_ID`, `ANCHOR_PROVIDER_URL`, and `ANCHOR_WALLET` environment variables.

```
SOL_PROGRAM_ID=FaWcnbmoyN1SWfUaio4cJAC2HokPgukzKhhk1hZrh4De
SOL_WRAPPED_MINT=GbYLimSgAdNio4DpVo3Ha8nren1sss6466Sbec2GKxjp
SOL_BRIDGE_CONFIG=5hej1qy8eTZKtQTKQvYFmiMs79HGxiD3ncaSko4fiYpB
SOL_MINT_AUTHORITY=J3WfJCAnB3ynPmHb9eaHrUdER4F79NZSZLc9WjBToq54
SOL_AUTHORIZED_RELAYER=DXMeqSthTy7Cf2E4mpSheTduDDKq9saddTPsnkVs4ziT
```

The `SOL_AUTHORIZED_RELAYER` is currently the same key as the deployer (single-key Devnet convenience). When Leah & Harry are ready with their dedicated relayer keypair, run:

```bash
solana config set --url devnet
# Use the deployer (admin) keypair to rotate the relayer:
anchor run rotate-relayer  # OR call set_relayer manually via TS, no script wrapper exists yet
```

Or the manual TS one-liner:
```typescript
await program.methods.setRelayer(new PublicKey('<NEW_RELAYER_PUBKEY>'))
  .accounts({ admin: admin.publicKey, config: configPda })
  .rpc();
```

## What Yang needs to share

- Sepolia `EthBridge.sol` deployed address (20-byte hex).
- Sepolia `TestToken.sol` (the bound ERC-20) deployed address (20-byte hex).
- Confirmation that the `Locked` event includes `sourceTxHash` as `bytes32` and that the `recipient` parameter is `bytes32` (raw 32-byte Solana pubkey, not base58 string).

## Risks if these are missed

- If the relayer encodes a string-based payload, `mintWrapped` fails on the first call (Borsh size mismatch).
- If the ATA pre-instruction is forgotten, `mintWrapped` fails with `AccountNotInitialized`.
- If `ETH_TOKEN_ADDRESS` doesn't match what was passed to `initialize`, every mint fails with `InvalidSource`.
- If `BridgeConfig` source addresses ever need updating (e.g., contract redeployment on Sepolia), run `npm run anchor:update-source` — no program redeploy needed.
