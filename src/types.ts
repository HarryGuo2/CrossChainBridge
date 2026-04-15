export interface BridgeMessage {
  id: string;                // sha256 hash of nonce + sourceTxHash
  nonce: string;             // bigint serialized as string
  sender: string;
  recipient: string;         // base58 Solana pubkey
  token: string;
  amount: string;            // bigint serialized as string
  sourceChain: string;
  targetChain: string;
  sourceTxHash: string;
  status: 'pending' | 'submitted' | 'delivered' | 'failed';
  retryCount: number;
  createdAt: number;         // unix ms
  updatedAt: number;
}

export interface Config {
  ETH_RPC_URL: string;
  ETH_BRIDGE_ADDRESS: string;
  ETH_CONFIRMATIONS: number;
  ETH_START_BLOCK: number;
  SOL_RPC_URL: string;
  SOL_PROGRAM_ID: string;
  SOL_WRAPPED_MINT: string;
  SOL_RELAYER_KEYPAIR: string;
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