export interface BridgeMessage {
  id: string;                // sha256 hash of nonce + sourceTxHash
  nonce: string;             // bigint serialized as string
  sender: string;
  recipient: string;         // base58 Solana pubkey (normalized from bytes32 event field)
  token: string;
  amount: string;            // bigint serialized as string
  sourceChain: string;
  targetChain: string;
  sourceTxHash: string;
  logIndex: number;          // Ethereum log index for replay protection
  status: 'pending' | 'submitted' | 'delivered' | 'failed';
  retryCount: number;
  createdAt: number;         // unix ms
  updatedAt: number;
}

export interface Config {
  ETH_RPC_URL: string;
  ETH_BRIDGE_ADDRESS: string;
  ETH_TOKEN_ADDRESS: string;
  ETH_RELAYER_PRIVATE_KEY?: string;  // optional: only needed for markRelayed callback
  ETH_CONFIRMATIONS: number;
  ETH_START_BLOCK: number;
  SOL_RPC_URL: string;
  SOL_PROGRAM_ID: string;
  SOL_WRAPPED_MINT: string;
  SOL_RELAYER_KEYPAIR: string;
  SOL_BRIDGE_CONFIG?: string;
  SOL_MINT_AUTHORITY?: string;
  SOL_AUTHORIZED_RELAYER: string;
  RETRY_INTERVAL_MS: number;
  POLL_INTERVAL_MS: number;
  DB_PATH: string;
}

export interface LogContext {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  [key: string]: any;
}
