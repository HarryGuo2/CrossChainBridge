# Cross-Chain Bridge Relayer

A production-quality TypeScript relayer service for bridging tokens between Ethereum (Sepolia testnet) and Solana (Devnet).

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Ethereum      │    │     Relayer     │    │     Solana      │
│   (Sepolia)     │────│   (TypeScript)  │────│   (Devnet)      │
│                 │    │                 │    │                 │
│ EthBridge.sol   │    │ • Event Monitor │    │ Anchor Program  │
│ Locked events   │    │ • SQLite DB     │    │ mintWrapped()   │
│                 │    │ • Retry Logic   │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Features

- **Reliable Event Monitoring**: Polls Ethereum for `Locked` events with configurable confirmations
- **SQLite Persistence**: Stores all bridge messages with status tracking and retry logic
- **Automatic Retries**: Failed transactions are retried up to 5 times with exponential backoff
- **Graceful Shutdown**: Handles SIGINT/SIGTERM signals for clean shutdown
- **Production Logging**: Structured JSON logs for all events and errors
- **Duplicate Protection**: Prevents processing the same nonce multiple times
- **Balance Monitoring**: Tracks relayer SOL balance and warns when low

## Project Structure

```
src/
├── index.ts          # Entry point, starts the relayer
├── listener.ts       # Listens to Ethereum Locked events
├── submitter.ts      # Submits messages to Solana
├── db.ts             # SQLite persistence layer
├── types.ts          # Shared types and BridgeMessage interface
└── config.ts         # Loads and validates all env vars

idl/
└── bridge.json       # Anchor program IDL

.env.example          # Template for environment variables
```

## How to Run

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Environment

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
# Ethereum Configuration
ETH_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
ETH_BRIDGE_ADDRESS=0x1234567890123456789012345678901234567890
ETH_CONFIRMATIONS=3
ETH_START_BLOCK=5000000

# Solana Configuration
SOL_RPC_URL=https://api.devnet.solana.com
SOL_PROGRAM_ID=YourProgram1111111111111111111111111111111111
SOL_WRAPPED_MINT=YourMint111111111111111111111111111111111111
SOL_RELAYER_KEYPAIR=./relayer-keypair.json

# Relayer Configuration
RETRY_INTERVAL_MS=30000
POLL_INTERVAL_MS=10000
DB_PATH=./relayer.db
```

### 3. Set Up Solana Keypair

Create a relayer keypair for Solana:

```bash
solana-keygen new --outfile relayer-keypair.json
```

Fund the keypair with some SOL for transaction fees:

```bash
solana airdrop 1 $(solana-keygen pubkey relayer-keypair.json) --url devnet
```

### 4. Build and Start

**Development mode:**
```bash
npm run dev
```

**Production mode:**
```bash
npm run build
npm start
```

The relayer will start monitoring Ethereum events and automatically bridge them to Solana.

## How to Test

### 1. Deploy Test Contracts

Deploy the EthBridge.sol contract to Sepolia and the Anchor program to Solana Devnet.

### 2. Send Test Transaction

Call the `lockTokens` function on your Ethereum bridge contract:

```solidity
// Example lock transaction
bridgeContract.lockTokens(
    recipient,        // Solana pubkey as bytes32
    tokenAddress,     // ERC20 token address
    amount,          // Amount to bridge
    "solana"         // Target chain
);
```

### 3. Watch Relayer Logs

The relayer will log each step:

```json
{"timestamp":"2024-01-15T10:30:00.000Z","level":"info","event":"event_detected","nonce":"1","sender":"0x...","recipient":"Base58Address","amount":"1000000"}
{"timestamp":"2024-01-15T10:30:15.000Z","level":"info","event":"confirmations_waited","nonce":"1","confirmations":3}
{"timestamp":"2024-01-15T10:30:20.000Z","level":"info","event":"solana_delivered","nonce":"1","signature":"5uH..."}
```

### 4. Verify Bridge Completion

Check that:
- The message was inserted into the SQLite database
- The Solana transaction succeeded
- Wrapped tokens were minted to the recipient
- The ProcessedMessage PDA was created on Solana

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `ETH_RPC_URL` | Ethereum Sepolia RPC endpoint | `https://eth-sepolia.g.alchemy.com/v2/...` |
| `ETH_BRIDGE_ADDRESS` | Deployed bridge contract address | `0x1234...` |
| `ETH_START_BLOCK` | Block to start scanning from | `5000000` |
| `SOL_RPC_URL` | Solana RPC endpoint | `https://api.devnet.solana.com` |
| `SOL_PROGRAM_ID` | Anchor program ID | `YourProgram111...` |
| `SOL_WRAPPED_MINT` | Wrapped token mint address | `YourMint111...` |
| `SOL_RELAYER_KEYPAIR` | Path to relayer keypair | `./relayer-keypair.json` |

### Optional Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ETH_CONFIRMATIONS` | `3` | Block confirmations to wait |
| `RETRY_INTERVAL_MS` | `30000` | Retry failed messages interval |
| `POLL_INTERVAL_MS` | `10000` | Ethereum polling interval |
| `DB_PATH` | `./relayer.db` | SQLite database path |

## Error Handling

The relayer implements comprehensive error handling:

- **Network Errors**: Retries with exponential backoff
- **Transaction Failures**: Marks messages as failed and retries up to 5 times
- **Duplicate Messages**: Skips already processed nonces
- **Low Balance**: Warns when relayer balance is low
- **Graceful Shutdown**: Saves progress on SIGINT/SIGTERM

## Database Schema

### Messages Table

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,              -- sha256(nonce + sourceTxHash)
  nonce TEXT UNIQUE NOT NULL,       -- Bridge transaction nonce
  sender TEXT NOT NULL,             -- Ethereum sender address
  recipient TEXT NOT NULL,          -- Solana recipient pubkey
  token TEXT NOT NULL,              -- Ethereum token address
  amount TEXT NOT NULL,             -- Amount as string
  sourceChain TEXT NOT NULL,        -- "ethereum"
  targetChain TEXT NOT NULL,        -- "solana"
  sourceTxHash TEXT NOT NULL,       -- Ethereum tx hash
  status TEXT NOT NULL,             -- pending|submitted|delivered|failed
  retryCount INTEGER DEFAULT 0,     -- Retry attempts
  createdAt INTEGER NOT NULL,       -- Unix timestamp
  updatedAt INTEGER NOT NULL        -- Unix timestamp
);
```

### Key-Value Table

```sql
CREATE TABLE key_value (
  key TEXT PRIMARY KEY,             -- Configuration key
  value TEXT NOT NULL,              -- Configuration value
  updatedAt INTEGER NOT NULL        -- Unix timestamp
);
```

## Production Considerations

- **Monitoring**: Set up log aggregation and alerting
- **Backup**: Regular database backups
- **Security**: Secure keypair storage and access controls
- **Scaling**: Consider multiple relayers for redundancy
- **Upgrades**: Implement rolling deployments

## License

MIT License - see LICENSE file for details.