import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
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
  "event Locked(uint64 indexed nonce, address indexed sender, bytes32 recipient, address token, uint256 amount, string sourceChain, string targetChain, bytes32 sourceTxHash)"
];

export class EthListener extends EventEmitter {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private config: Config;
  private db: RelayerDB;
  private isRunning: boolean = false;

  // Track every active sleep timer so stop() can clear all of them at once.
  // The previous single-handle approach was overwritten whenever a second
  // sleep started (poll loop + waitForConfirmations running concurrently),
  // which meant stop() could leave a timer dangling and shutdown stalled.
  private activeTimers: Set<NodeJS.Timeout> = new Set();

  // Resolvers for in-flight sleeps so stop() can wake them immediately rather
  // than waiting up to ETH_CONFIRMATIONS * 5s for the current sleep to elapse.
  private sleepResolvers: Set<() => void> = new Set();

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

    // Clear every active timer and wake every active sleep. Without this, a
    // listener in the middle of waitForConfirmations would sit for another
    // 5–10s before noticing isRunning flipped to false.
    for (const t of this.activeTimers) clearTimeout(t);
    this.activeTimers.clear();
    for (const r of this.sleepResolvers) r();
    this.sleepResolvers.clear();

    log({ event: 'eth_listener_stopped' });
  }

  private async pollLoop(fromBlock: number): Promise<void> {
    let currentFromBlock = fromBlock;
    let consecutiveErrors = 0;

    while (this.isRunning) {
      try {
        const processedUntil = await this.pollForEvents(currentFromBlock);
        if (processedUntil >= currentFromBlock) {
          currentFromBlock = processedUntil + 1;
        }
        consecutiveErrors = 0;

        if (this.isRunning) {
          await this.sleep(this.config.POLL_INTERVAL_MS);
        }
      } catch (error: any) {
        consecutiveErrors++;
        // Exponential backoff up to 5 minutes — protects against RPC outages
        // and rate limits. Without escalation the loop hammers a dead RPC at
        // 2× POLL_INTERVAL forever, which gets us ratelimited harder.
        const wait = Math.min(
          this.config.POLL_INTERVAL_MS * Math.pow(2, consecutiveErrors),
          5 * 60_000
        );
        log({
          event: 'eth_polling_error',
          level: 'error',
          error: error.message,
          from_block: currentFromBlock,
          consecutive_errors: consecutiveErrors,
          backoff_ms: wait
        });
        if (this.isRunning) {
          await this.sleep(wait);
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
        fromBlock + 999 // Limit to prevent RPC timeouts
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
          ethers.id("Locked(uint64,address,bytes32,address,uint256,string,string,bytes32)")
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

      // Track whether every log in the batch was successfully handed off.
      // If any failed, we do NOT advance lastProcessedBlock past the failing
      // block — next poll will re-scan and (because hasMessage is keyed on
      // nonce) successful ones are skipped, failed ones get another shot.
      let allOk = true;
      let lastOkBlock = fromBlock - 1;

      for (const logEntry of logs) {
        const ok = await this.processLogEntry(logEntry);
        if (!ok) {
          allOk = false;
          // Re-scan from this block next time. Anything we already inserted
          // is dedup'd by the unique-nonce constraint in db.insertMessage.
          const stallBlock = logEntry.blockNumber ?? fromBlock;
          if (stallBlock > 0) lastOkBlock = Math.min(lastOkBlock, stallBlock - 1);
          break;
        }
        lastOkBlock = Math.max(lastOkBlock, logEntry.blockNumber ?? lastOkBlock);
      }

      // If everything processed cleanly we can advance to toBlock. Otherwise
      // advance only as far as the last fully-handled block so the failed
      // entry gets re-fetched.
      const advanceTo = allOk ? toBlock : Math.max(fromBlock - 1, lastOkBlock);
      this.db.saveLastProcessedBlock(advanceTo);

      if (!allOk) {
        log({
          event: 'block_scan_partial',
          level: 'warn',
          from_block: fromBlock,
          attempted_to: toBlock,
          advanced_to: advanceTo
        });
      }

      return advanceTo;

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

  private async processLogEntry(logEntry: ethers.Log): Promise<boolean> {
    // Returns true if processing reached a stable state (handed off OR known
    // unprocessable), false if a transient error means we should re-scan.
    let parsedLog;
    try {
      parsedLog = this.contract.interface.parseLog({
        topics: logEntry.topics as string[],
        data: logEntry.data
      });
    } catch (e: any) {
      // ABI decode failed. This is permanent — re-fetching the same log won't
      // help. Log loudly and move past it so we don't stall the block pointer.
      log({
        event: 'log_parse_failed',
        level: 'error',
        tx_hash: logEntry.transactionHash,
        block: logEntry.blockNumber,
        error: e.message
      });
      return true;
    }

    if (!parsedLog) {
      log({
        event: 'log_parse_null',
        level: 'warn',
        tx_hash: logEntry.transactionHash,
        block: logEntry.blockNumber
      });
      return true;
    }

    try {
      const args = parsedLog.args;
      const nonce = args.nonce.toString();
      const sourceTxHash = logEntry.transactionHash;

      log({
        event: 'event_detected',
        nonce,
        sender: args.sender,
        recipient: args.recipient,
        token: args.token,
        amount: args.amount.toString(),
        source_chain: args.sourceChain,
        target_chain: args.targetChain,
        tx_hash: sourceTxHash,
        block: logEntry.blockNumber
      });

      if (this.db.hasMessage(nonce)) {
        log({
          event: 'event_already_processed',
          level: 'debug',
          nonce,
          tx_hash: sourceTxHash
        });
        return true;
      }

      // Wait for confirmations. If this fails (RPC error), return false so the
      // block pointer doesn't advance past us — we'll retry on the next poll.
      const confirmed = await this.waitForConfirmations(sourceTxHash, logEntry.blockNumber || 0);
      if (!confirmed) {
        return false;
      }

      const bridgeMessage = this.createBridgeMessage(args, sourceTxHash);
      this.db.insertMessage(bridgeMessage);

      log({
        event: 'confirmations_waited',
        nonce,
        confirmations: this.config.ETH_CONFIRMATIONS,
        tx_hash: sourceTxHash
      });

      this.emit('message', bridgeMessage);
      return true;

    } catch (error: any) {
      // Transient processing error (DB hiccup, etc.) — let the next poll re-do
      // this range. insertMessage is dedup'd on nonce so we won't double-emit.
      log({
        event: 'log_processing_error',
        level: 'error',
        error: error.message,
        tx_hash: logEntry.transactionHash,
        block: logEntry.blockNumber
      });
      return false;
    }
  }

  private async waitForConfirmations(txHash: string, logBlockNumber: number): Promise<boolean> {
    const targetConfirmations = this.config.ETH_CONFIRMATIONS;
    // Cap how long we'll sit on a single event. If the chain isn't producing
    // blocks fast enough to confirm within this window, return false and let
    // the next poll pick it up — don't hold the entire listener loop hostage.
    const maxWaitMs = Math.max(60_000, targetConfirmations * 15_000);
    const deadline = Date.now() + maxWaitMs;
    let consecutiveErrors = 0;

    while (this.isRunning) {
      if (Date.now() > deadline) {
        log({
          event: 'confirmation_wait_timeout',
          level: 'warn',
          tx_hash: txHash,
          waited_ms: maxWaitMs
        });
        return false;
      }

      try {
        const currentBlock = await this.provider.getBlockNumber();
        consecutiveErrors = 0;
        const confirmations = currentBlock - logBlockNumber + 1;

        if (confirmations >= targetConfirmations) {
          log({
            event: 'confirmations_reached',
            tx_hash: txHash,
            confirmations,
            required: targetConfirmations
          });
          return true;
        }

        log({
          event: 'waiting_confirmations',
          level: 'debug',
          tx_hash: txHash,
          confirmations,
          required: targetConfirmations
        });

        await this.sleep(5000);

      } catch (error: any) {
        consecutiveErrors++;
        log({
          event: 'confirmation_check_error',
          level: 'error',
          error: error.message,
          tx_hash: txHash,
          consecutive_errors: consecutiveErrors
        });
        // After 3 consecutive RPC failures, give up on this log and let the
        // outer poll loop retry the whole block range — that path has its own
        // backoff and is the right place to handle prolonged RPC outages.
        if (consecutiveErrors >= 3) {
          return false;
        }
        await this.sleep(10000);
      }
    }
    // Loop exited because isRunning went false (shutdown).
    return false;
  }

  private createBridgeMessage(args: any, sourceTxHash: string): BridgeMessage {
    const nonce = args.nonce.toString();
    const id = crypto
      .createHash('sha256')
      .update(nonce + sourceTxHash)
      .digest('hex');

    const now = Date.now();

    return {
      id,
      nonce,
      sender: args.sender,
      recipient: args.recipient,
      token: args.token,
      amount: args.amount.toString(),
      sourceChain: args.sourceChain,
      targetChain: args.targetChain,
      sourceTxHash,
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  private sleep(ms: number): Promise<void> {
    // Re-entrant safe: each call gets its own timer + resolver, both tracked
    // so stop() can wake them. Resolves either when the timer fires or when
    // stop() forcibly drains the resolver set.
    return new Promise(resolve => {
      const wake = () => {
        this.sleepResolvers.delete(wake);
        resolve();
      };
      const t = setTimeout(() => {
        this.activeTimers.delete(t);
        wake();
      }, ms);
      this.activeTimers.add(t);
      this.sleepResolvers.add(wake);
    });
  }
}
