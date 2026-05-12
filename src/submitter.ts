import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  Program,
  AnchorProvider,
  Wallet,
  BN,
  utils
} from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import * as fs from 'fs';
import { Config, BridgeMessage } from './types';
import { RelayerDB } from './db';
import { classify, FailureKind, backoffMs } from './errors';
import idl from '../idl/bridge.json';

function log(context: any): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: context.level || 'info',
    ...context
  }));
}

// Hard ceiling for waiting on a single tx to confirm. If the blockhash expires
// or the RPC stalls past this, we abandon the wait and let the retry loop
// re-submit with a fresh blockhash rather than blocking the submitter forever.
const CONFIRM_TIMEOUT_MS = 60_000;

// Minimum balance below which we stop attempting submissions entirely. Burning
// retries while the relayer is empty just spams logs.
const MIN_OPERATIONAL_SOL = 0.01;

const MAX_RETRIES = 5;

export class SolanaSubmitter {
  private connection: Connection;
  private relayerKeypair: Keypair;
  private program: Program;
  private config: Config;
  private db: RelayerDB;
  private programId: PublicKey;
  private wrappedMint: PublicKey;

  // Circuit-breaker state. When set in the future, submit() short-circuits and
  // marks the attempt as a transient failure without touching the RPC. This
  // protects against thundering-herd retries when the relayer wallet is empty
  // or the RPC is rate-limiting us.
  private pausedUntil: number = 0;

  constructor(config: Config, db: RelayerDB) {
    this.config = config;
    this.db = db;

    this.connection = new Connection(config.SOL_RPC_URL, 'confirmed');
    this.programId = new PublicKey(config.SOL_PROGRAM_ID);
    this.wrappedMint = new PublicKey(config.SOL_WRAPPED_MINT);

    // Load relayer keypair
    const keypairData = JSON.parse(fs.readFileSync(config.SOL_RELAYER_KEYPAIR, 'utf8'));
    this.relayerKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));

    // Initialize Anchor program
    const wallet = new Wallet(this.relayerKeypair);
    const provider = new AnchorProvider(
      this.connection,
      wallet,
      { commitment: 'confirmed', skipPreflight: false }
    );

    this.program = new Program(idl as any, this.programId, provider);

    log({
      event: 'solana_submitter_initialized',
      relayer_pubkey: this.relayerKeypair.publicKey.toBase58(),
      program_id: this.programId.toBase58(),
      wrapped_mint: this.wrappedMint.toBase58(),
      rpc_url: config.SOL_RPC_URL.split('/').slice(0, 3).join('/') + '/***'
    });
  }

  async submit(msg: BridgeMessage): Promise<void> {
    // Circuit breaker: if we're paused (e.g. low balance), don't even try.
    // We don't bump retryCount in this case — the message isn't failing on its
    // own merits, the relayer is just temporarily incapable.
    if (Date.now() < this.pausedUntil) {
      log({
        event: 'solana_submission_skipped_paused',
        level: 'warn',
        id: msg.id,
        nonce: msg.nonce,
        paused_until: new Date(this.pausedUntil).toISOString()
      });
      return;
    }

    // Validate the payload up front. A malformed recipient pubkey is permanent —
    // retrying it 5 times accomplishes nothing. Do this BEFORE we flip status to
    // 'submitted' so a poison message never enters the "in flight" state.
    let recipientPubkey: PublicKey;
    try {
      recipientPubkey = new PublicKey(msg.recipient);
    } catch (e: any) {
      this.db.markDead(msg.id, `invalid recipient: ${e.message}`);
      log({
        event: 'solana_payload_invalid',
        level: 'error',
        id: msg.id,
        nonce: msg.nonce,
        recipient: msg.recipient,
        error: e.message
      });
      return;
    }

    log({
      event: 'solana_submission_start',
      id: msg.id,
      nonce: msg.nonce,
      recipient: msg.recipient,
      amount: msg.amount,
      attempt: msg.retryCount + 1
    });

    // Pre-flight balance check. If we're below the operational floor, pause the
    // submitter for a minute rather than burning retries.
    try {
      const balance = await this.connection.getBalance(this.relayerKeypair.publicKey);
      if (balance < MIN_OPERATIONAL_SOL * LAMPORTS_PER_SOL) {
        this.pausedUntil = Date.now() + 60_000;
        log({
          event: 'solana_submitter_paused_low_balance',
          level: 'error',
          id: msg.id,
          balance_sol: balance / LAMPORTS_PER_SOL,
          min_required_sol: MIN_OPERATIONAL_SOL,
          paused_for_ms: 60_000
        });
        return;
      }
    } catch (e: any) {
      // Balance check itself failed — treat as transient and let the retry loop
      // handle it. Don't bump retryCount yet; we haven't actually attempted.
      log({
        event: 'solana_balance_check_failed',
        level: 'warn',
        id: msg.id,
        error: e.message
      });
      return;
    }

    // Mark in-flight only after pre-flight passes. If we crash between here and
    // a terminal status, recoverStuckSubmitted() on next boot will flip this
    // back to 'pending'.
    this.db.updateStatus(msg.id, 'submitted');

    try {
      const [processedMessagePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("processed"), Buffer.from(msg.nonce)],
        this.programId
      );

      const recipientAta = await getAssociatedTokenAddress(
        this.wrappedMint,
        recipientPubkey
      );

      const bridgePayload = {
        nonce: new BN(msg.nonce),
        sender: msg.sender,
        recipient: msg.recipient,
        token: msg.token,
        amount: new BN(msg.amount),
        sourceChain: msg.sourceChain,
        targetChain: msg.targetChain,
        sourceTxHash: msg.sourceTxHash
      };

      log({
        event: 'solana_accounts_derived',
        id: msg.id,
        processed_message_pda: processedMessagePda.toBase58(),
        recipient_ata: recipientAta.toBase58(),
        recipient: recipientPubkey.toBase58()
      });

      const tx = await this.program.methods
        .mintWrapped(bridgePayload)
        .accounts({
          relayer: this.relayerKeypair.publicKey,
          processedMessage: processedMessagePda,
          wrappedMint: this.wrappedMint,
          recipient: recipientPubkey,
          recipientTokenAccount: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId
        })
        .transaction();

      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.relayerKeypair.publicKey;
      tx.sign(this.relayerKeypair);

      const signature = await this.connection.sendRawTransaction(
        tx.serialize(),
        {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3
        }
      );

      log({
        event: 'solana_transaction_sent',
        id: msg.id,
        signature,
        nonce: msg.nonce
      });

      // Wrap confirmation in a timeout. confirmTransaction can hang past
      // lastValidBlockHeight in some web3.js versions / RPC providers; we
      // don't want that to pin a worker indefinitely.
      const confirmation = await this.withTimeout(
        this.connection.confirmTransaction({
          signature,
          blockhash,
          lastValidBlockHeight
        }),
        CONFIRM_TIMEOUT_MS,
        'confirmTransaction'
      );

      if (confirmation.value.err) {
        // Construct an Error that carries the on-chain err so classify() can
        // see "already processed" style program errors.
        const e: any = new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        e.logs = (confirmation.value as any)?.logs || [];
        throw e;
      }

      this.db.updateStatus(msg.id, 'delivered');
      log({
        event: 'solana_delivered',
        id: msg.id,
        signature,
        nonce: msg.nonce,
        recipient: msg.recipient,
        amount: msg.amount
      });

    } catch (error: any) {
      const c = classify(error);
      const nextAttempt = msg.retryCount + 1;

      switch (c.kind) {
        case FailureKind.ALREADY_PROCESSED:
          // The bridge state is consistent — somebody (us, on a prior run, or
          // another relayer) already minted for this nonce. Don't retry; mark
          // delivered so it stops showing up in the queue.
          this.db.updateStatus(msg.id, 'delivered');
          log({
            event: 'solana_already_processed',
            level: 'warn',
            id: msg.id,
            nonce: msg.nonce,
            reason: c.reason
          });
          return;

        case FailureKind.PERMANENT:
          // Hopeless — program rejected the payload for a reason that won't
          // change without operator action. Park it.
          this.db.markDead(msg.id, c.reason);
          log({
            event: 'solana_failed_permanent',
            level: 'error',
            id: msg.id,
            nonce: msg.nonce,
            reason: c.reason,
            error: error.message
          });
          return;

        case FailureKind.INSUFFICIENT_FUNDS:
          // Pause the submitter; don't bump retryCount (this isn't the
          // message's fault). The retry loop will skip submissions while
          // pausedUntil is in the future.
          this.pausedUntil = Date.now() + 60_000;
          log({
            event: 'solana_submitter_paused_funds',
            level: 'error',
            id: msg.id,
            nonce: msg.nonce,
            error: error.message
          });
          return;

        case FailureKind.TRANSIENT:
        default:
          this.db.updateStatus(msg.id, 'failed', nextAttempt);
          log({
            event: 'solana_failed',
            level: 'error',
            id: msg.id,
            nonce: msg.nonce,
            error: error.message,
            retry_count: nextAttempt,
            kind: c.kind
          });
          if (nextAttempt >= MAX_RETRIES) {
            // Exhausted: move to 'dead' so the retry loop stops scanning it
            // and operators have a clear queue of human-attention items.
            this.db.markDead(msg.id, `retry budget exhausted after ${MAX_RETRIES} attempts: ${c.reason}`);
            log({
              event: 'retry_exhausted',
              level: 'warn',
              id: msg.id,
              nonce: msg.nonce,
              final_error: error.message
            });
          }
          return;
      }
    }
  }

  // Race a promise against a timeout. Rejects with a descriptive error if the
  // timeout wins so classify() routes it as transient.
  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      p.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  async retryFailed(): Promise<void> {
    try {
      // Honor circuit breaker. Logging is cheap; spamming retries while paused
      // is not.
      if (Date.now() < this.pausedUntil) {
        log({
          event: 'retry_skipped_paused',
          level: 'debug',
          paused_until: new Date(this.pausedUntil).toISOString()
        });
        return;
      }

      const undeliveredMessages = this.db.getUndelivered(60_000, MAX_RETRIES);

      if (undeliveredMessages.length === 0) {
        log({
          event: 'retry_no_pending_messages',
          level: 'debug'
        });
        return;
      }

      log({
        event: 'retry_started',
        count: undeliveredMessages.length
      });

      let processed = 0;
      for (const message of undeliveredMessages) {
        // Per-message backoff: only retry if enough time has passed since the
        // last attempt, scaled by retryCount. A message that just failed 200ms
        // ago shouldn't be tried again on the very next tick of the loop.
        const waitNeeded = backoffMs(message.retryCount);
        const sinceLast = Date.now() - message.updatedAt;
        if (sinceLast < waitNeeded) {
          log({
            event: 'retry_deferred_backoff',
            level: 'debug',
            id: message.id,
            retry_count: message.retryCount,
            wait_remaining_ms: waitNeeded - sinceLast
          });
          continue;
        }

        log({
          event: 'retry_attempted',
          id: message.id,
          nonce: message.nonce,
          retry_count: message.retryCount,
          status: message.status
        });

        // submit() handles all its own errors internally and never throws, so
        // a single bad message can't abort the batch. But if that ever changes
        // (or an unexpected error slips through), isolate it here.
        try {
          await this.submit(message);
        } catch (e: any) {
          log({
            event: 'retry_submit_unexpected_error',
            level: 'error',
            id: message.id,
            error: e.message
          });
        }
        processed++;

        // If submit() paused us mid-batch (e.g. balance dropped), stop the
        // batch — no point continuing.
        if (Date.now() < this.pausedUntil) {
          log({ event: 'retry_batch_aborted_paused', level: 'warn' });
          break;
        }

        // Small inter-message delay to avoid hammering the RPC.
        await this.sleep(250);
      }

      log({
        event: 'retry_batch_completed',
        scanned: undeliveredMessages.length,
        processed
      });

    } catch (error: any) {
      log({
        event: 'retry_batch_error',
        level: 'error',
        error: error.message
      });
    }
  }

  async checkRelayerBalance(): Promise<number> {
    try {
      const balance = await this.connection.getBalance(this.relayerKeypair.publicKey);
      const solBalance = balance / LAMPORTS_PER_SOL;

      log({
        event: 'relayer_balance_checked',
        balance_lamports: balance,
        balance_sol: solBalance,
        pubkey: this.relayerKeypair.publicKey.toBase58()
      });

      if (solBalance < 0.1) {
        log({
          event: 'relayer_balance_low',
          level: 'warn',
          balance_sol: solBalance,
          threshold: 0.1
        });
      }

      return solBalance;

    } catch (error: any) {
      log({
        event: 'relayer_balance_check_error',
        level: 'error',
        error: error.message
      });
      return 0;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getRelayerPublicKey(): string {
    return this.relayerKeypair.publicKey.toBase58();
  }
}
