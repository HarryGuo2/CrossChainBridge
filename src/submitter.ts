import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  Program,
  AnchorProvider,
  Wallet,
  BN
} from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { Config, BridgeMessage } from './types';
import { RelayerDB } from './db';
import idl from '../idl/bridge.json';

function log(context: any): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: context.level || 'info',
    ...context
  }));
}

export class SolanaSubmitter {
  private connection: Connection;
  private relayerKeypair: Keypair;
  private program: Program;
  private db: RelayerDB;
  private programId: PublicKey;
  private wrappedMint: PublicKey;
  private ethBridge: ethers.Contract;

  private static readonly ETH_BRIDGE_ABI = [
    'function markRelayed(uint64 nonce, bytes32 solanaTxHash) external'
  ];

  constructor(config: Config, db: RelayerDB) {
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

    const ethProvider = new ethers.JsonRpcProvider(config.ETH_RPC_URL);
    const ethSigner = new ethers.Wallet(config.ETH_RELAYER_PRIVATE_KEY, ethProvider);
    this.ethBridge = new ethers.Contract(
      config.ETH_BRIDGE_ADDRESS,
      SolanaSubmitter.ETH_BRIDGE_ABI,
      ethSigner
    );

    log({
      event: 'solana_submitter_initialized',
      relayer_pubkey: this.relayerKeypair.publicKey.toBase58(),
      program_id: this.programId.toBase58(),
      wrapped_mint: this.wrappedMint.toBase58(),
      rpc_url: config.SOL_RPC_URL.split('/').slice(0, 3).join('/') + '/***'
    });
  }

  async submit(msg: BridgeMessage): Promise<void> {
    try {
      log({
        event: 'solana_submission_start',
        id: msg.id,
        nonce: msg.nonce,
        recipient: msg.recipient,
        amount: msg.amount
      });

      // Update status to submitted
      this.db.updateStatus(msg.id, 'submitted');

      // Check relayer balance
      const balance = await this.connection.getBalance(this.relayerKeypair.publicKey);
      if (balance < 0.01 * LAMPORTS_PER_SOL) {
        throw new Error(`Insufficient relayer balance: ${balance / LAMPORTS_PER_SOL} SOL`);
      }

      // Derive accounts
      const recipientPubkey = new PublicKey(msg.recipient);

      const [processedMessagePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("processed"), Buffer.from(msg.nonce)],
        this.programId
      );

      const recipientAta = await getAssociatedTokenAddress(
        this.wrappedMint,
        recipientPubkey
      );

      // Build bridge payload
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

      // Create transaction
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

      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.relayerKeypair.publicKey;

      // Sign and send transaction
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

      // Confirm transaction
      const confirmation = await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      });

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      // Update status to delivered
      this.db.updateStatus(msg.id, 'delivered');

      log({
        event: 'solana_delivered',
        id: msg.id,
        signature,
        nonce: msg.nonce,
        recipient: msg.recipient,
        amount: msg.amount
      });

      await this.markRelayedOnEthereum(msg.nonce, signature);

    } catch (error: any) {
      // Update status to failed and increment retry count
      this.db.updateStatus(msg.id, 'failed', msg.retryCount + 1);

      log({
        event: 'solana_failed',
        level: 'error',
        id: msg.id,
        nonce: msg.nonce,
        error: error.message,
        retry_count: msg.retryCount + 1
      });

      // Check if retries exhausted
      if (msg.retryCount + 1 >= 5) {
        log({
          event: 'retry_exhausted',
          level: 'warn',
          id: msg.id,
          nonce: msg.nonce,
          final_error: error.message
        });
      }
    }
  }

  async retryFailed(): Promise<void> {
    try {
      const undeliveredMessages = this.db.getUndelivered();

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

      for (const message of undeliveredMessages) {
        log({
          event: 'retry_attempted',
          id: message.id,
          nonce: message.nonce,
          retry_count: message.retryCount,
          status: message.status
        });

        await this.submit(message);

        // Small delay between retries to avoid overwhelming the network
        await this.sleep(1000);
      }

      log({
        event: 'retry_batch_completed',
        count: undeliveredMessages.length
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

  private async markRelayedOnEthereum(nonce: string, solanaSignature: string): Promise<void> {
    try {
      const solanaTxHash = ethers.keccak256(ethers.toUtf8Bytes(solanaSignature));
      const tx = await this.ethBridge.markRelayed(BigInt(nonce), solanaTxHash);
      const receipt = await tx.wait();

      log({
        event: 'ethereum_mark_relayed_success',
        nonce,
        eth_tx_hash: tx.hash,
        eth_block_number: receipt?.blockNumber,
        solana_signature: solanaSignature,
        solana_signature_hash: solanaTxHash
      });
    } catch (error: any) {
      log({
        event: 'ethereum_mark_relayed_failed',
        level: 'error',
        nonce,
        solana_signature: solanaSignature,
        error: error.message
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getRelayerPublicKey(): string {
    return this.relayerKeypair.publicKey.toBase58();
  }
}
