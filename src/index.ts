import { loadConfig } from './config';
import { RelayerDB } from './db';
import { EthListener } from './listener';
import { SolanaSubmitter } from './submitter';

function log(context: any): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: context.level || 'info',
    ...context
  }));
}

function printBanner(): void {
  console.log('\n🌉 Cross-Chain Bridge Relayer v1.0.0');
  console.log('=====================================');
  console.log('Production-quality Ethereum ↔ Solana bridge\n');
}

async function main(): Promise<void> {
  let db: RelayerDB | null = null;
  let listener: EthListener | null = null;
  let retryInterval: NodeJS.Timeout | null = null;

  try {
    printBanner();

    // Load and validate configuration
    const config = loadConfig();

    // Initialize database
    db = new RelayerDB(config.DB_PATH);

    // Initialize components
    listener = new EthListener(config, db);
    const submitter = new SolanaSubmitter(config, db);

    // Check relayer balance
    await submitter.checkRelayerBalance();

    // Wire listener to submitter
    listener.on('message', async (message) => {
      try {
        await submitter.submit(message);
      } catch (error: any) {
        log({
          event: 'message_submission_error',
          level: 'error',
          error: error.message,
          message_id: message.id
        });
      }
    });

    // Start retry loop
    retryInterval = setInterval(async () => {
      try {
        await submitter.retryFailed();
      } catch (error: any) {
        log({
          event: 'retry_loop_error',
          level: 'error',
          error: error.message
        });
      }
    }, config.RETRY_INTERVAL_MS);

    // Log startup info
    const stats = db.getStats();
    log({
      event: 'relayer_started',
      config: {
        eth_bridge: config.ETH_BRIDGE_ADDRESS,
        eth_confirmations: config.ETH_CONFIRMATIONS,
        eth_start_block: config.ETH_START_BLOCK,
        sol_program: config.SOL_PROGRAM_ID,
        sol_mint: config.SOL_WRAPPED_MINT,
        poll_interval_ms: config.POLL_INTERVAL_MS,
        retry_interval_ms: config.RETRY_INTERVAL_MS,
        db_path: config.DB_PATH
      },
      stats,
      relayer_pubkey: submitter.getRelayerPublicKey()
    });

    // Setup graceful shutdown
    const shutdown = async (signal: string) => {
      log({
        event: 'shutdown_initiated',
        signal
      });

      // Stop listener
      if (listener) {
        listener.stop();
      }

      // Clear retry interval
      if (retryInterval) {
        clearInterval(retryInterval);
      }

      // Close database
      if (db) {
        db.close();
      }

      log({ event: 'shutdown_complete' });
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle unhandled rejections and exceptions
    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      log({
        event: 'unhandled_rejection',
        level: 'error',
        reason: reason?.message || reason,
        promise: promise.toString()
      });
    });

    process.on('uncaughtException', (error: Error) => {
      log({
        event: 'uncaught_exception',
        level: 'error',
        error: error.message,
        stack: error.stack
      });

      // Attempt graceful shutdown on uncaught exception
      shutdown('UNCAUGHT_EXCEPTION');
    });

    // Start the listener (this will run indefinitely)
    await listener.start();

  } catch (error: any) {
    log({
      event: 'startup_error',
      level: 'error',
      error: error.message,
      stack: error.stack
    });

    // Cleanup on startup error
    if (retryInterval) {
      clearInterval(retryInterval);
    }

    if (db) {
      try {
        db.close();
      } catch (closeError: any) {
        log({
          event: 'db_close_error',
          level: 'error',
          error: closeError.message
        });
      }
    }

    process.exit(1);
  }
}

// Handle environment variable loading
try {
  require('dotenv').config();
} catch (error) {
  // dotenv is optional, continue without it
}

// Start the relayer
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}