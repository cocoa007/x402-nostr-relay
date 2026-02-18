/**
 * SQLite-backed event store with NIP-01 filter querying.
 * Falls back to in-memory if SQLite unavailable.
 */

import { matchFilter } from './filters.mjs';

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = `${DATA_DIR}/relay.db`;

let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  Database = null;
}

export class EventStore {
  constructor() {
    this.db = null;
    this.memory = new Map(); // fallback

    if (Database) {
      try {
        this.db = new Database(DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this._initDb();
        console.log(`📦 SQLite store: ${DB_PATH}`);
      } catch (err) {
        console.log(`⚠️ SQLite failed (${err.message}), using in-memory store`);
        this.db = null;
      }
    } else {
      console.log('⚠️ better-sqlite3 not available, using in-memory store');
    }
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        kind INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        sig TEXT NOT NULL DEFAULT '',
        raw TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind ON events(pubkey, kind);

      CREATE TABLE IF NOT EXISTS payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_pubkey TEXT NOT NULL,
        amount INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        payment_address TEXT,
        payment_type TEXT,
        payment_source TEXT,
        forward_tx TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_payouts_recipient ON payouts(recipient_pubkey);
      CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

      CREATE TABLE IF NOT EXISTS used_tx_ids (
        tx_id TEXT PRIMARY KEY,
        used_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  }

  add(event) {
    if (this.db) return this._addDb(event);
    return this._addMemory(event);
  }

  _addDb(event) {
    // Check duplicate
    const existing = this.db.prepare('SELECT id FROM events WHERE id = ?').get(event.id);
    if (existing) return false;

    // Replaceable events (kinds 0, 3, 10000-19999)
    if (event.kind === 0 || event.kind === 3 ||
        (event.kind >= 10000 && event.kind < 20000)) {
      const old = this.db.prepare(
        'SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ?'
      ).get(event.pubkey, event.kind);
      if (old) {
        if (old.created_at >= event.created_at) return false;
        this.db.prepare('DELETE FROM events WHERE id = ?').run(old.id);
      }
    }

    // Parameterized replaceable (30000-39999)
    if (event.kind >= 30000 && event.kind < 40000) {
      const dTag = (event.tags || []).find(t => t[0] === 'd')?.[1] || '';
      const rows = this.db.prepare(
        'SELECT id, created_at, tags FROM events WHERE pubkey = ? AND kind = ?'
      ).all(event.pubkey, event.kind);
      for (const row of rows) {
        const rowTags = JSON.parse(row.tags || '[]');
        const rowD = rowTags.find(t => t[0] === 'd')?.[1] || '';
        if (rowD === dTag) {
          if (row.created_at >= event.created_at) return false;
          this.db.prepare('DELETE FROM events WHERE id = ?').run(row.id);
        }
      }
    }

    // Ephemeral — don't store
    if (event.kind >= 20000 && event.kind < 30000) return true;

    this.db.prepare(`
      INSERT INTO events (id, pubkey, kind, created_at, content, tags, sig, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.pubkey, event.kind, event.created_at,
      event.content || '', JSON.stringify(event.tags || []),
      event.sig || '', JSON.stringify(event)
    );
    return true;
  }

  _addMemory(event) {
    if (this.memory.has(event.id)) return false;
    if (event.kind === 0 || event.kind === 3 ||
        (event.kind >= 10000 && event.kind < 20000)) {
      for (const [id, ex] of this.memory) {
        if (ex.pubkey === event.pubkey && ex.kind === event.kind) {
          if (ex.created_at >= event.created_at) return false;
          this.memory.delete(id);
        }
      }
    }
    if (event.kind >= 30000 && event.kind < 40000) {
      const dTag = (event.tags || []).find(t => t[0] === 'd')?.[1] || '';
      for (const [id, ex] of this.memory) {
        if (ex.pubkey === event.pubkey && ex.kind === event.kind) {
          const exD = (ex.tags || []).find(t => t[0] === 'd')?.[1] || '';
          if (exD === dTag) {
            if (ex.created_at >= event.created_at) return false;
            this.memory.delete(id);
          }
        }
      }
    }
    if (event.kind >= 20000 && event.kind < 30000) return true;
    this.memory.set(event.id, event);
    return true;
  }

  query(filter) {
    if (this.db) return this._queryDb(filter);
    return this._queryMemory(filter);
  }

  _queryDb(filter) {
    // Build SQL query from NIP-01 filter
    const conditions = [];
    const params = [];

    if (filter.ids?.length) {
      const clauses = filter.ids.map(id => {
        params.push(id + '%');
        return 'id LIKE ?';
      });
      conditions.push(`(${clauses.join(' OR ')})`);
    }
    if (filter.authors?.length) {
      const clauses = filter.authors.map(a => {
        params.push(a + '%');
        return 'pubkey LIKE ?';
      });
      conditions.push(`(${clauses.join(' OR ')})`);
    }
    if (filter.kinds?.length) {
      conditions.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }
    if (filter.since != null) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter.until != null) {
      conditions.push('created_at <= ?');
      params.push(filter.until);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit > 0 ? `LIMIT ${Math.min(filter.limit, 5000)}` : 'LIMIT 5000';
    const sql = `SELECT raw FROM events ${where} ORDER BY created_at DESC ${limit}`;

    const rows = this.db.prepare(sql).all(...params);
    let events = rows.map(r => JSON.parse(r.raw));

    // Apply tag filters in JS (complex to do in SQL)
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith('#') && Array.isArray(values)) {
        const tagName = key.slice(1);
        events = events.filter(e =>
          (e.tags || []).some(t => t[0] === tagName && values.includes(t[1]))
        );
      }
    }

    return events;
  }

  _queryMemory(filter) {
    const results = [];
    for (const event of this.memory.values()) {
      if (matchFilter(event, filter)) results.push(event);
    }
    results.sort((a, b) => b.created_at - a.created_at);
    if (filter.limit > 0) return results.slice(0, filter.limit);
    return results;
  }

  // --- Payout tracking (SQLite only) ---

  recordPayout(recipientPubkey, amount, eventId, paymentAddress) {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO payouts (recipient_pubkey, amount, event_id, payment_address, payment_type, payment_source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      recipientPubkey, amount, eventId,
      paymentAddress?.address || null,
      paymentAddress?.type || null,
      paymentAddress?.source || null
    );
  }

  updatePayoutTx(eventId, txId, status = 'sent') {
    if (!this.db) return;
    this.db.prepare('UPDATE payouts SET forward_tx = ?, status = ? WHERE event_id = ?')
      .run(txId, status, eventId);
  }

  getPendingPayouts() {
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM payouts WHERE status = ? ORDER BY created_at DESC')
      .all('pending');
  }

  getAllPayouts() {
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM payouts ORDER BY created_at DESC LIMIT 100').all();
  }

  // --- Replay protection (SQLite) ---

  isUsedTx(txId) {
    if (!this.db) return false;
    return !!this.db.prepare('SELECT tx_id FROM used_tx_ids WHERE tx_id = ?').get(txId);
  }

  markTxUsed(txId) {
    if (!this.db) return;
    this.db.prepare('INSERT OR IGNORE INTO used_tx_ids (tx_id) VALUES (?)').run(txId);
  }

  get size() {
    if (this.db) {
      return this.db.prepare('SELECT COUNT(*) as count FROM events').get().count;
    }
    return this.memory.size;
  }
}
