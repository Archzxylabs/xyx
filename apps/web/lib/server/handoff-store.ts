import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type HandoffKind = 'terms' | 'delivery' | 'evidence';
export interface StoredHandoff { id: string; kind: HandoffKind; iv: string; ciphertext: string; createdAt: number; expiresAt: number }
export interface NewHandoff { kind: HandoffKind; iv: string; ciphertext: string; expiresAt: number }

const ID = /^[A-Za-z0-9_-]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_CIPHERTEXT_LENGTH = 96 * 1024;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ACTIVE_HANDOFFS = 2_000;

export class HandoffStore {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS encrypted_handoffs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('terms', 'delivery', 'evidence')),
        iv TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS encrypted_handoffs_expiry ON encrypted_handoffs(expires_at);
    `);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
  }

  create(input: NewHandoff, now = Math.floor(Date.now() / 1000)): StoredHandoff {
    if (!['terms', 'delivery', 'evidence'].includes(input.kind)) throw new Error('HANDOFF_KIND_INVALID');
    if (!BASE64URL.test(input.iv) || input.iv.length > 64) throw new Error('HANDOFF_IV_INVALID');
    if (!BASE64URL.test(input.ciphertext) || input.ciphertext.length > MAX_CIPHERTEXT_LENGTH) throw new Error('HANDOFF_CIPHERTEXT_INVALID');
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + MAX_TTL_SECONDS) throw new Error('HANDOFF_EXPIRY_INVALID');
    this.database.prepare('DELETE FROM encrypted_handoffs WHERE expires_at <= ?').run(now);
    const count = this.database.prepare('SELECT count(*) AS count FROM encrypted_handoffs').get() as { count: number };
    if (count.count >= MAX_ACTIVE_HANDOFFS) throw new Error('HANDOFF_CAPACITY_REACHED');
    const id = randomBytes(24).toString('base64url');
    this.database.prepare('INSERT INTO encrypted_handoffs(id, kind, iv, ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.kind, input.iv, input.ciphertext, now, input.expiresAt);
    return { id, ...input, createdAt: now };
  }

  read(id: string, now = Math.floor(Date.now() / 1000)): StoredHandoff | null {
    if (!ID.test(id)) throw new Error('HANDOFF_ID_INVALID');
    const row = this.database.prepare('SELECT id, kind, iv, ciphertext, created_at, expires_at FROM encrypted_handoffs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    if (expiresAt <= now) {
      this.database.prepare('DELETE FROM encrypted_handoffs WHERE id = ?').run(id);
      return null;
    }
    return { id: String(row.id), kind: String(row.kind) as HandoffKind, iv: String(row.iv), ciphertext: String(row.ciphertext), createdAt: Number(row.created_at), expiresAt };
  }

  close(): void { this.database.close(); }
}

let productionStore: HandoffStore | undefined;
export function handoffStore(): HandoffStore {
  if (productionStore) return productionStore;
  const filename = process.env.XYX_HANDOFF_DATABASE_PATH
    ? path.resolve(process.env.XYX_HANDOFF_DATABASE_PATH)
    : path.resolve(process.cwd(), '.xyx-data', 'handoffs.sqlite');
  productionStore = new HandoffStore(filename);
  return productionStore;
}
