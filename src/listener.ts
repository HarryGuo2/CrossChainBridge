import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bs58 = require('bs58') as { encode: (buf: Buffer) => string; decode: (str: string) => Buffer };
import { Config, BridgeMessage } from './types';
import { RelayerDB } from './db';

function log(context: any): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: context.level || 'info',
    ...context
  }));
}

const BRIDGE_ABI = [
  "event TokensLocked(address indexed token, address indexed sender, bytes32 indexed recipient, uint256 amount, uint256 nonce)"
];

export class EthListener extends EventEmitter {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private config: Config;
  private db: RelayerDB;
  private isRunning: boolean = false;
  private pollTimeout: NodeJS.Timeout | null = null;

  constructor(config: Config, db: RelayerDB) {
    super();
    this.config = config;
    this.db = db;

    this.provider = new ethers.JsonRpcProvider(config.ETH_RPC_URL);
    this.contract = new ethers.Contract(config.ETH_BRIDGE_ADDRESS, BRIDGE_ABI, this.provider);

    log({
      event: 'eth_listener_initialized',
      bridge_address: config.ETH_BRIDGE_ADDRESS,
      confirmations: config.ETH_CONFIRMATIONS,
      poll_interval: config.POLL_INTERVAL_MS
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      log({ event: 'eth_listener_already_running', level: 'warn' });
      return;
    }

    this.isRunning = true;
    log({ event: 'eth_listener_starting' });

    // Get starting block
    let fromBlock = this.db.getLastProcessedBlock();
    if (fromBlock === 0) {
      fromBlock = this.config.ETH_START_BLOCK;
      log({
        event: 'eth_listener_first_run',
        start_block: fromBlock
      });
    } else {
      // Resume from next block after last processed
      fromBlock += 1;
      log({
        event: 'eth_listener_resuming',
        from_block: fromBlock
      });
    }

    await this.pollLoop(fromBlock);
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    log({ event: 'eth_listener_stopping' });
    this.isRunning = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }

    log({ event: 'eth_listener_stopped' });
  }

  private async pollLoop(fromBlock: number): Promise<void> {
    let currentFromBlock = fromBlock;
    const MAX_LAG = 100;

    while (this.isRunning) {
      try {
        // Free-tier eth_getLogs is capped at 10 blocks per call. If we are too far
        // behind the chain head we will never catch up at 10 blocks per poll, so
        // jump close to head and let any older events be queried via Etherscan
        // backfill (out of scope for live polling).
        try {
          const head = await this.provider.getBlockNumber();
          if (head - currentFromBlock > MAX_LAG) {
            const jumpTo = Math.max(head - 10, currentFromBlock);
            log({
              event: 'eth_listener_jump_ahead',
              level: 'warn',
              from_block: currentFromBlock,
              to_block: jumpTo,
              chain_head: head,
              reason: 'lag_exceeds_threshold'
            });
            currentFromBlock = jumpTo;
            this.db.saveLastProcessedBlock(jumpTo - 1);
          }
        } catch (_) {
          // RPC hiccup — try again next iteration
        }

        const processedUntil = await this.pollForEvents(currentFromBlock);
        if (processedUntil > currentFromBlock) {
          currentFromBlock = processedUntil + 1;
        }

        // Wait for next poll
        if (this.isRunning) {
          await this.sleep(this.config.POLL_INTERVAL_MS);
        }
      } catch (error: any) {
        log({
          event: 'eth_polling_error',
          level: 'error',
          error: error.message,
          from_block: currentFromBlock
        });

        // Wait before retrying on error
        if (this.isRunning) {
          await this.sleep(Math.min(this.config.POLL_INTERVAL_MS * 2, 30000));
        }
      }
    }
  }

  private async pollForEvents(fromBlock: number): Promise<number> {
    try {
      const currentBlock = await this.provider.getBlockNumber();

      if (currentBlock < fromBlock) {
        log({
          event: 'eth_waiting_for_blocks',
          level: 'debug',
          current_block: currentBlock,
          from_block: fromBlock
        });
        return fromBlock - 1;
      }

      const toBlock = Math.min(
        currentBlock - this.config.ETH_CONFIRMATIONS,
        fromBlock + 9 // Limit to 10 blocks for Alchemy Free Tier
      );

      if (toBlock < fromBlock) {
        log({
          event: 'eth_waiting_confirmations',
          level: 'debug',
          current_block: currentBlock,
          confirmations_needed: this.config.ETH_CONFIRMATIONS
        });
        return fromBlock - 1;
      }

      log({
        event: 'block_scanned',
        from_block: fromBlock,
        to_block: toBlock,
        current_block: currentBlock
      });

      const filter = {
        address: this.config.ETH_BRIDGE_ADDRESS,
        topics: [
          ethers.id("TokensLocked(address,address,bytes32,uint256,uint256)")
        ],
        fromBlock,
        toBlock
      };

      const logs = await this.provider.getLogs(filter);

      log({
        event: 'events_fetched',
        count: logs.length,
        from_block: fromBlock,
        to_block: toBlock
      });

      for (const logEntry of logs) {
        await this.processLogEntry(logEntry);
      }

      // Save progress
      this.db.saveLastProcessedBlock(toBlock);

      return toBlock;

    } catch (error: any) {
      log({
        event: 'block_scan_error',
        level: 'error',
        error: error.message,
        from_block: fromBlock
      });
      throw error;
    }
  }

  private async processLogEntry(logEntry: ethers.Log): Promise<void> {
    try {
      const parsedLog = this.contract.interface.parseLog({
        topics: logEntry.topics as string[],
        data: logEntry.data
      });

      if (!parsedLog) {
        log({
          event: 'log_parse_failed',
          level: 'warn',
          tx_hash: logEntry.transactionHash,
          block: logEntry.blockNumber
        });
        return;
      }

      const args = parsedLog.args;
      const nonce = args.nonce.toString();
      const sourceTxHash = logEntry.transactionHash;
      const logIndex = logEntry.index ?? 0;

      log({
        event: 'event_detected',
        nonce,
        sender: args.sender,
        recipient: args.recipient,
        token: args.token,
        amount: args.amount.toString(),
        tx_hash: sourceTxHash,
        log_index: logIndex,
        block: logEntry.blockNumber
      });

      // Check if already processed
      if (this.db.hasMessage(nonce)) {
        log({
          event: 'event_already_processed',
          level: 'debug',
          nonce,
          tx_hash: sourceTxHash
        });
        return;
      }

      // Wait for confirmations
      await this.waitForConfirmations(sourceTxHash, logEntry.blockNumber || 0);

      // Create bridge message
      const bridgeMessage = this.createBridgeMessage(args, sourceTxHash, logIndex);

      // Insert into database
      this.db.insertMessage(bridgeMessage);

      log({
        event: 'confirmations_waited',
        nonce,
        confirmations: this.config.ETH_CONFIRMATIONS,
        tx_hash: sourceTxHash
      });

      // Emit event for submitter to pick up
      this.emit('message', bridgeMessage);

    } catch (error: any) {
      log({
        event: 'log_processing_error',
        level: 'error',
        error: error.message,
        tx_hash: logEntry.transactionHash,
        block: logEntry.blockNumber
      });
    }
  }

  private async waitForConfirmations(txHash: string, logBlockNumber: number): Promise<void> {
    const targetConfirmations = this.config.ETH_CONFIRMATIONS;

    while (this.isRunning) {
      try {
        const currentBlock = await this.provider.getBlockNumber();
        const confirmations = currentBlock - logBlockNumber + 1;

        if (confirmations >= targetConfirmations) {
          log({
            event: 'confirmations_reached',
            tx_hash: txHash,
            confirmations,
            required: targetConfirmations
          });
          return;
        }

        log({
          event: 'waiting_confirmations',
          level: 'debug',
          tx_hash: txHash,
          confirmations,
          required: targetConfirmations
        });

        await this.sleep(5000); // Wait 5 seconds before checking again

      } catch (error: any) {
        log({
          event: 'confirmation_check_error',
          level: 'error',
          error: error.message,
          tx_hash: txHash
        });
        await this.sleep(10000); // Wait longer on error
      }
    }
  }

  private createBridgeMessage(args: any, sourceTxHash: string, logIndex: number): BridgeMessage {
    const nonce = args.nonce.toString();
    const id = crypto
      .createHash('sha256')
      .update(nonce + sourceTxHash)
      .digest('hex');

    const now = Date.now();

    return {
      id,
      nonce,
      sender: (args.sender as string).toLowerCase(),
      recipient: this.decodeRecipient(args.recipient),
      token: args.token,
      amount: args.amount.toString(),
      sourceChain: 'ethereum',
      targetChain: 'solana',
      sourceTxHash,
      logIndex,
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  private decodeRecipient(recipientBytes32: string): string {
    return bs58.encode(Buffer.from((recipientBytes32 as string).slice(2), 'hex'));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.pollTimeout = setTimeout(resolve, ms);
    });
  }
}
