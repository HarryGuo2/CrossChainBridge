import Database from 'better-sqlite3';
import { BridgeMessage } from './types';
import * as path from 'path';

function log(context: any): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    ...context
  }));
}

export class RelayerDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    const resolvedPath = path.resolve(dbPath);
    log({ event: 'db_connecting', path: resolvedPath });

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 1000');
    this.db.pragma('temp_store = MEMORY');

    this.migrate();
    log({ event: 'db_connected', path: resolvedPath });
  }

  private migrate(): void {
    log({ event: 'db_migration_start' });

    // Create messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        nonce TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        token TEXT NOT NULL,
        amount TEXT NOT NULL,
        sourceChain TEXT NOT NULL,
        targetChain TEXT NOT NULL,
        sourceTxHash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'submitted', 'delivered', 'failed', 'dead')),
        retryCount INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    // Migrate older DBs whose CHECK constraint lacks 'dead'. SQLite can't ALTER
    // a CHECK in place, so we detect via sqlite_master and rebuild only if
    // needed. Idempotent and safe to run every boot.
    try {
      const tblSql = (this.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'`)
        .get() as any)?.sql || '';
      if (tblSql && !tblSql.includes("'dead'")) {
        log({ event: 'db_migrating_dead_status' });
        this.db.exec(`
          BEGIN;
          CREATE TABLE messages_new (
            id TEXT PRIMARY KEY,
            nonce TEXT NOT NULL,
            sender TEXT NOT NULL,
            recipient TEXT NOT NULL,
            token TEXT NOT NULL,
            amount TEXT NOT NULL,
            sourceChain TEXT NOT NULL,
            targetChain TEXT NOT NULL,
            sourceTxHash TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'submitted', 'delivered', 'failed', 'dead')),
            retryCount INTEGER NOT NULL DEFAULT 0,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
          );
          INSERT INTO messages_new SELECT * FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_new RENAME TO messages;
          COMMIT;
        `);
      }
    } catch (e: any) {
      log({ event: 'db_migration_dead_skip', level: 'warn', error: e.message });
    }

    // Create indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
      CREATE INDEX IF NOT EXISTS idx_messages_nonce ON messages(nonce);
      CREATE INDEX IF NOT EXISTS idx_messages_retry ON messages(retryCount, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_nonce_unique ON messages(nonce);
    `);

    // Create key_value table for metadata
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS key_value (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    log({ event: 'db_migration_complete' });
  }

  insertMessage(msg: BridgeMessage): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, nonce, sender, recipient, token, amount, sourceChain,
        targetChain, sourceTxHash, status, retryCount, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        msg.id,
        msg.nonce,
        msg.sender,
        msg.recipient,
        msg.token,
        msg.amount,
        msg.sourceChain,
        msg.targetChain,
        msg.sourceTxHash,
        msg.status,
        msg.retryCount,
        msg.createdAt,
        msg.updatedAt
      );

      log({
        event: 'message_inserted',
        id: msg.id,
        nonce: msg.nonce,
        status: msg.status
      });
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        log({
          event: 'message_duplicate_skipped',
          id: msg.id,
          nonce: msg.nonce
        });
        return;
      }
      throw error;
    }
  }

  updateStatus(id: string, status: string, retryCount?: number): void {
    const now = Date.now();

    let query: string;
    let params: any[];

    if (retryCount !== undefined) {
      query = `UPDATE messages SET status = ?, retryCount = ?, updatedAt = ? WHERE id = ?`;
      params = [status, retryCount, now, id];
    } else {
      query = `UPDATE messages SET status = ?, updatedAt = ? WHERE id = ?`;
      params = [status, now, id];
    }

    const stmt = this.db.prepare(query);
    const result = stmt.run(...params);

    if (result.changes === 0) {
      log({
        event: 'message_update_failed',
        level: 'warn',
        id,
        status,
        retryCount,
        reason: 'message_not_found'
      });
      return;
    }

    log({
      event: 'message_status_updated',
      id,
      status,
      retryCount: retryCount || 'unchanged'
    });
  }

  // Returns messages that still need work. Includes:
  //   - pending  (just inserted, never tried)
  //   - failed   (transient failure, still under retry cap)
  //   - submitted that have been stuck for `stuckAfterMs` — these are messages
  //     where we updated status to 'submitted' but crashed (or the RPC hung)
  //     before reaching 'delivered' or 'failed'. Without this clause they sit
  //     forever invisible to the retry loop.
  getUndelivered(stuckAfterMs: number = 60_000, maxRetries: number = 5): BridgeMessage[] {
    const stuckBefore = Date.now() - stuckAfterMs;
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE retryCount < ?
        AND (
          status = 'pending'
          OR status = 'failed'
          OR (status = 'submitted' AND updatedAt < ?)
        )
      ORDER BY createdAt ASC
    `);

    const rows = stmt.all(maxRetries, stuckBefore) as any[];
    const messages = rows.map(row => ({
      id: row.id,
      nonce: row.nonce,
      sender: row.sender,
      recipient: row.recipient,
      token: row.token,
      amount: row.amount,
      sourceChain: row.sourceChain,
      targetChain: row.targetChain,
      sourceTxHash: row.sourceTxHash,
      status: row.status as BridgeMessage['status'],
      retryCount: row.retryCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));

    log({
      event: 'undelivered_messages_fetched',
      count: messages.length
    });

    return messages;
  }

  // Recover orphaned 'submitted' rows on startup: anything stuck in 'submitted'
  // when we boot is by definition an unfinished previous run. Flip them back to
  // 'pending' so the retry loop picks them up. We don't increment retryCount —
  // the previous attempt didn't actually fail, it was interrupted.
  recoverStuckSubmitted(): number {
    const stmt = this.db.prepare(`
      UPDATE messages
      SET status = 'pending', updatedAt = ?
      WHERE status = 'submitted'
    `);
    const result = stmt.run(Date.now());
    if (result.changes > 0) {
      log({
        event: 'stuck_submitted_recovered',
        level: 'warn',
        count: result.changes
      });
    }
    return result.changes;
  }

  // Mark a message as permanently undeliverable. Used for things like malformed
  // recipient pubkeys, where retrying just burns fees and log space.
  markDead(id: string, reason: string): void {
    const stmt = this.db.prepare(`
      UPDATE messages SET status = 'dead', updatedAt = ? WHERE id = ?
    `);
    const result = stmt.run(Date.now(), id);
    if (result.changes > 0) {
      log({
        event: 'message_marked_dead',
        level: 'warn',
        id,
        reason
      });
    }
  }

  getLastProcessedBlock(): number {
    const stmt = this.db.prepare(`SELECT value FROM key_value WHERE key = 'lastProcessedBlock'`);
    const row = stmt.get() as any;

    if (!row) {
      log({
        event: 'last_processed_block_not_found',
        returning: 0
      });
      return 0;
    }

    const block = parseInt(row.value, 10);
    log({
      event: 'last_processed_block_retrieved',
      block
    });

    return block;
  }

  saveLastProcessedBlock(block: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO key_value (key, value, updatedAt)
      VALUES ('lastProcessedBlock', ?, ?)
    `);

    stmt.run(block.toString(), Date.now());

    log({
      event: 'last_processed_block_saved',
      block
    });
  }

  hasMessage(nonce: string): boolean {
    const stmt = this.db.prepare(`SELECT 1 FROM messages WHERE nonce = ? LIMIT 1`);
    const result = stmt.get(nonce);
    return !!result;
  }

  getStats(): { total: number; pending: number; submitted: number; delivered: number; failed: number; dead: number } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) as dead
      FROM messages
    `);

    const result = stmt.get() as any;
    return {
      total: result.total || 0,
      pending: result.pending || 0,
      submitted: result.submitted || 0,
      delivered: result.delivered || 0,
      failed: result.failed || 0,
      dead: result.dead || 0
    };
  }

  close(): void {
    log({ event: 'db_closing' });
    this.db.close();
    log({ event: 'db_closed' });
  }
}
