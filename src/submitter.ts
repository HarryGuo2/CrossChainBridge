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
  createAssociatedTokenAccountIdempotentInstruction
} from '@solana/spl-token';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { Config, BridgeMessage } from './types';
import { RelayerDB } from './db';
import idl from '../idl/bridge.json';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bs58 = require('bs58') as { encode: (buf: Buffer) => string; decode: (str: string) => Uint8Array };

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
  private config: Config;
  private programId: PublicKey;
  private wrappedMint: PublicKey;
  private ethBridge: ethers.Contract | null;

  private static readonly ETH_BRIDGE_ABI = [
    'function markRelayed(uint64 nonce, bytes32 solanaTxHash) external'
  ];

  constructor(config: Config, db: RelayerDB) {
    this.db = db;
    this.config = config;

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

    // Ethereum signer is optional — only needed for the markRelayed callback
    if (config.ETH_RELAYER_PRIVATE_KEY) {
      const ethProvider = new ethers.JsonRpcProvider(config.ETH_RPC_URL);
      const ethSigner = new ethers.Wallet(config.ETH_RELAYER_PRIVATE_KEY, ethProvider);
      this.ethBridge = new ethers.Contract(
        config.ETH_BRIDGE_ADDRESS,
        SolanaSubmitter.ETH_BRIDGE_ABI,
        ethSigner
      );
    } else {
      this.ethBridge = null;
      log({ event: 'eth_mark_relayed_disabled', level: 'warn', reason: 'ETH_RELAYER_PRIVATE_KEY not set' });
    }

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

      const SOURCE_CHAIN_ID = 1;

      // Decode byte buffers from message fields
      const sourceBridgeBytes = Buffer.from(this.config.ETH_BRIDGE_ADDRESS.replace(/^0x/, ''), 'hex');
      const sourceTokenBytes  = Buffer.from(this.config.ETH_TOKEN_ADDRESS.replace(/^0x/, ''), 'hex');
      const senderBytes       = Buffer.from(msg.sender.replace(/^0x/, ''), 'hex');
      const recipientSolBytes = Buffer.from(bs58.decode(msg.recipient));
      const sourceTxHashBytes = Buffer.from(msg.sourceTxHash.replace(/^0x/, ''), 'hex');

      if (sourceBridgeBytes.length !== 20) throw new Error('ETH_BRIDGE_ADDRESS must be 20 bytes');
      if (sourceTokenBytes.length !== 20)  throw new Error('ETH_TOKEN_ADDRESS must be 20 bytes');
      if (senderBytes.length !== 20)       throw new Error('sender must be 20 bytes');
      if (recipientSolBytes.length !== 32) throw new Error('recipient (base58) must decode to 32 bytes');
      if (sourceTxHashBytes.length !== 32) throw new Error('sourceTxHash must be 32 bytes');

      // Ethereum bUSD = 18 decimals; Solana wrapped mint = 6 decimals.
      // Rescale by 10^12 before fitting into the u64 payload.
      const SCALE_DIVISOR = BigInt(10) ** BigInt(12);
      const rawAmount = BigInt(msg.amount);
      if (rawAmount % SCALE_DIVISOR !== BigInt(0)) {
        log({ event: 'amount_truncated', level: 'warn', raw: msg.amount, scale_divisor: SCALE_DIVISOR.toString() });
      }
      const scaledAmount = rawAmount / SCALE_DIVISOR;
      const amountBN = new BN(scaledAmount.toString());
      if (amountBN.bitLength() > 64) throw new Error(`scaled amount ${scaledAmount} exceeds u64::MAX`);

      // Build the fixed-width binary BridgePayload
      const bridgePayload = {
        version: 1,
        sourceChainId: SOURCE_CHAIN_ID,
        sourceBridge: Array.from(sourceBridgeBytes),
        sourceToken:  Array.from(sourceTokenBytes),
        nonce:  new BN(msg.nonce),
        amount: amountBN,
        senderEth:    Array.from(senderBytes),
        recipientSol: Array.from(recipientSolBytes),
        sourceTxHash: Array.from(sourceTxHashBytes),
        sourceLogIndex: msg.logIndex ?? 0,
      };

      // Derive the ProcessedMessage PDA: ["processed", chainLE2, bridge20, nonceLE8]
      const chainBuf = Buffer.alloc(2);
      chainBuf.writeUInt16LE(SOURCE_CHAIN_ID, 0);
      const nonceBuf = Buffer.alloc(8);
      nonceBuf.writeBigUInt64LE(BigInt(msg.nonce), 0);
      const [processedMessagePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('processed'), chainBuf, sourceBridgeBytes, nonceBuf],
        this.programId
      );

      // Derive BridgeConfig and mintAuthority PDAs deterministically
      const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('config')],
        this.programId
      );
      const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('mint_authority')],
        this.programId
      );

      const recipientPubkey = new PublicKey(msg.recipient);
      const recipientAta = await getAssociatedTokenAddress(
        this.wrappedMint,
        recipientPubkey
      );

      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        this.relayerKeypair.publicKey,
        recipientAta,
        recipientPubkey,
        this.wrappedMint
      );

      log({
        event: 'solana_accounts_derived',
        id: msg.id,
        config_pda: configPda.toBase58(),
        processed_message_pda: processedMessagePda.toBase58(),
        mint_authority_pda: mintAuthorityPda.toBase58(),
        recipient_ata: recipientAta.toBase58(),
        recipient: recipientPubkey.toBase58()
      });

      const signature = await this.program.methods
        .mintWrapped(bridgePayload)
        .accounts({
          relayer: this.relayerKeypair.publicKey,
          config: configPda,
          processedMessage: processedMessagePda,
          wrappedMint: this.wrappedMint,
          mintAuthority: mintAuthorityPda,
          recipient: recipientPubkey,
          recipientTokenAccount: recipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([createAtaIx])
        .signers([this.relayerKeypair])
        .rpc();

      log({
        event: 'solana_transaction_sent',
        id: msg.id,
        signature,
        nonce: msg.nonce
      });

      // Confirm transaction
      const { lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      const { blockhash } = await this.connection.getLatestBlockhash();
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
    if (!this.ethBridge) {
      log({ event: 'eth_mark_relayed_skipped', level: 'warn', nonce, reason: 'no ETH signer configured' });
      return;
    }
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
