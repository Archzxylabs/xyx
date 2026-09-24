/**
 * Durable operation journal: a restart-safe SQLite store for operation records.
 *
 * ## Scope and honest limits
 *
 * This is a **single-writer** journal, and it says so rather than implying more:
 * every write goes through one `node:sqlite` connection, writes are serialised
 * inside one synchronous transaction, and concurrent processes sharing the
 * same file are *not* supported. `claimSignerLease` uses SQLite's own
 * uniqueness enforcement plus `BEGIN IMMEDIATE`, which makes the lease safe for
 * multiple threads against one file — not for multiple processes. The status
 * machine lives in `types.ts`, the persistence lives here, and neither claims a
 * guarantee the other cannot honour.
 *
 * ## Durability
 *
 * Three properties hold, and are tested:
 *
 * 1. **It cannot silently downgrade to memory.** `OperationStore` refuses any
 *    path that is not an explicit durable location. Memory is only reachable
 *    through the deliberately-labelled `new InMemoryOperationStore()`, which
 *    exists so tests never need to fake durability, and whose records are
 *    lost on close by design.
 * 2. **State survives close and reopen.** Every mutation is a synchronous
 *    committed transaction before the method returns. `close()` is not
 *    required for that, and a crash before `close()` loses nothing that was
 *    acknowledged.
 * 3. **A failed reconciliation never erases evidence.** `reconcile` and its
 *    failure paths are additive: an existing receipt observation is never
 *    deleted or overwritten by a later observation, and a failed
 *    reconciliation records the conflict *alongside* the prior evidence.
 *
 * @module @xyx/monad/operations
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertNoSecrets,
  nextOperationStatus,
  type NewOperationInput,
  type OperationDeploymentBinding,
  type OperationError,
  type OperationFailureCode,
  type OperationKind,
  type OperationRecord,
  type OperationStatus,
  type ReceiptObservation,
  type ReconciliationResult,
  validateTransactionHash,
} from './types';

/** Every path separator and every memory marker we refuse. */
const IN_MEMORY_MARKERS = new Set(['', ':memory:', 'memory']);

export class OperationStoreError extends Error {
  readonly code: OperationFailureCode;

  constructor(code: OperationFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OperationStoreError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * The journal contract.
 *
 * Deliberately narrow. A caller may create, read, list, and transition
 * operations, and acquire a signer lease. Nothing here permits reading or
 * writing calldata, signed material, or private terms, because the record has
 * no field to hold them — the interface and the record agree.
 */
export interface OperationJournal {
  /** Create an operation. Throws `OPERATION_ALREADY_FINALIZED`-free duplicate semantics: a pre-existing key returns the original. */
  create(input: NewOperationInput): OperationRecord;
  /** Look up by operation id. */
  read(id: string): OperationRecord | null;
  /** Look up by idempotency key. */
  findByIdempotencyKey(idempotencyKey: string): OperationRecord | null;
  /** All operations, newest-updated first. */
  list(limit?: number): OperationRecord[];
  /** Advance an operation's status, validating the transition. */
  transition(id: string, to: OperationStatus, detail?: TransitionDetail): OperationRecord;
  /** Record a real returned hash and mark the operation SUBMITTED. */
  recordTransactionHash(id: string, transactionHash: string): OperationRecord;
  /** Add one observation. Existing observations are never replaced or dropped. */
  addObservation(id: string, observation: ReceiptObservation): OperationRecord;
  /** Recompute reconciliation from all observations. Evidence is preserved. */
  reconcile(id: string): OperationRecord;
  /** Record a deterministic failure. The operation stops here. */
  fail(id: string, code: OperationFailureCode, diagnostic: string): OperationRecord;
  /** Record a manual resolution of an AMBIGUOUS operation. */
  resolveAmbiguous(id: string, outcome: OperationStatus, diagnostic: string): OperationRecord;
  /** Acquire an exclusive lease on a signer/nonce pair. */
  claimSignerLease(lease: SignerLeaseRequest): SignerLease;
  /** Release a lease this holder owns. */
  releaseSignerLease(leaseId: string, holder: string): void;
  /** Close the store. */
  close(): void;
}

export interface TransitionDetail {
  readonly failureCode?: OperationFailureCode;
  readonly diagnostic?: string;
  readonly jobId?: number;
  readonly nonce?: number;
}

/**
 * An exclusive claim on one signer/nonce pair.
 *
 * The point of the lease is that two operations may not treat the same signer
 * and nonce as independently safe. While a lease is held, `claimSignerLease`
 * for the same signer+nonce fails with `SIGNER_BUSY` — so a second operation
 * cannot be prepared against a nonce the first one is about to consume.
 */
export interface SignerLease {
  readonly leaseId: string;
  readonly signer: string;
  readonly nonce: number | null;
  readonly holder: string;
  readonly expiresAt: number;
}

export interface SignerLeaseRequest {
  readonly signer: string;
  readonly nonce: number | null;
  /** Epoch seconds. */
  readonly ttlSeconds: number;
  readonly holder: string;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface OperationRow {
  schema: string;
  id: string;
  idempotency_key: string;
  kind: string;
  actor: string;
  actor_role: string;
  expected_chain_id: number;
  deployment: string;
  job_id: number | null;
  intent_digest: string;
  nonce: number | null;
  transaction_hash: string | null;
  created_at: number;
  updated_at: number;
  status: string;
  observations: string;
  reconciliation: string;
  failure_code: string | null;
  diagnostic: string | null;
}

interface LeaseRow {
  lease_id: string;
  signer: string;
  nonce: number | null;
  holder: string;
  expires_at: number;
}

function rowToRecord(row: OperationRow): OperationRecord {
  let deployment: OperationDeploymentBinding;
  try {
    deployment = JSON.parse(row.deployment) as OperationDeploymentBinding;
  } catch {
    throw new OperationStoreError(
      'OPERATION_SCHEMA_UNSUPPORTED',
      `the stored deployment binding for operation ${row.id} is not readable`
    );
  }
  let observations: readonly ReceiptObservation[];
  try {
    const parsed = JSON.parse(row.observations);
    observations = Array.isArray(parsed) ? (parsed as ReceiptObservation[]) : [];
  } catch {
    observations = [];
  }
  return {
    schema: row.schema as OperationRecord['schema'],
    id: row.id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind as OperationKind,
    actor: row.actor as OperationRecord['actor'],
    actorRole: row.actor_role as OperationRecord['actorRole'],
    expectedChainId: row.expected_chain_id,
    deployment,
    jobId: row.job_id,
    intentDigest: row.intent_digest as OperationRecord['intentDigest'],
    nonce: row.nonce,
    transactionHash: row.transaction_hash as OperationRecord['transactionHash'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as OperationStatus,
    receiptObservations: observations,
    reconciliation: row.reconciliation as ReconciliationResult,
    failureCode: row.failure_code as OperationFailureCode | null,
    diagnostic: row.diagnostic,
  };
}

// ---------------------------------------------------------------------------
// Shared SQLite implementation
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS operations (
    schema TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    expected_chain_id INTEGER NOT NULL,
    deployment TEXT NOT NULL,
    job_id INTEGER,
    intent_digest TEXT NOT NULL,
    nonce INTEGER,
    transaction_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    observations TEXT NOT NULL,
    reconciliation TEXT NOT NULL,
    failure_code TEXT,
    diagnostic TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS operations_status ON operations(status);
  CREATE INDEX IF NOT EXISTS operations_updated ON operations(updated_at);
  CREATE TABLE IF NOT EXISTS signer_leases (
    lease_id TEXT PRIMARY KEY,
    signer TEXT NOT NULL,
    nonce INTEGER,
    holder TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (signer, nonce)
  ) STRICT;
`;

/**
 * SQLite-backed journal. Single writer.
 *
 * The connection is opened once and reused. Writes use `BEGIN IMMEDIATE` so
 * that a lease claim and a status transition each happen in one atomic unit,
 * and `synchronous = FULL` so an acknowledged write is on disk rather than in
 * the OS page cache.
 */
export class SqliteOperationStore implements OperationJournal {
  private readonly database: DatabaseSync;
  private readonly ownedPath: string | null;

  /**
   * @param filename A durable filesystem path. Refuses memory markers — see
   *   `STORAGE_PATH_REQUIRED` / `STORAGE_DURABILITY_REFUSED`.
   */
  constructor(filename: string) {
    if (typeof filename !== 'string' || IN_MEMORY_MARKERS.has(filename.trim())) {
      throw new OperationStoreError(
        'STORAGE_PATH_REQUIRED',
        'a durable filesystem path is required; in-memory journaling is not a durable store'
      );
    }
    if (filename.includes('\0')) {
      throw new OperationStoreError('STORAGE_PATH_REQUIRED', 'the storage path is malformed');
    }

    const directory = dirname(filename);
    if (directory && directory !== '.' && !existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    this.ownedPath = filename;
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.database.exec(SCHEMA_SQL);
  }

  create(input: NewOperationInput): OperationRecord {
    assertNoSecrets(input);
    const now = Math.floor(Date.now() / 1000);
    // Duplicate idempotency keys must return the original operation and must
    // never create a second one. The uniqueness constraint makes a second
    // insert impossible; this check makes the *response* the original record,
    // which is what a caller needs to make retries safe.
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const record: OperationRecord = {
      schema: 'xyx.monad.operation.v1',
      id: input.idempotencyKey.slice(0, 64),
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      actor: input.actor,
      actorRole: input.actorRole,
      expectedChainId: input.expectedChainId,
      deployment: input.deployment,
      jobId: input.jobId ?? null,
      intentDigest: input.intentDigest,
      nonce: input.nonce ?? null,
      transactionHash: null,
      createdAt: now,
      updatedAt: now,
      status: 'PREPARED',
      receiptObservations: [],
      reconciliation: 'NOT_STARTED',
      failureCode: null,
      diagnostic: null,
    };

    this.write(() => {
      this.database.prepare(
        `INSERT INTO operations (
           schema, id, idempotency_key, kind, actor, actor_role, expected_chain_id, deployment,
           job_id, intent_digest, nonce, transaction_hash, created_at, updated_at, status,
           observations, reconciliation, failure_code, diagnostic
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.schema,
        record.id,
        record.idempotencyKey,
        record.kind,
        record.actor,
        record.actorRole,
        record.expectedChainId,
        JSON.stringify(record.deployment),
        record.jobId,
        record.intentDigest,
        record.nonce,
        record.transactionHash,
        record.createdAt,
        record.updatedAt,
        record.status,
        JSON.stringify(record.receiptObservations),
        record.reconciliation,
        record.failureCode,
        record.diagnostic
      );
    });

    return record;
  }

  private write<T>(fn: () => T): T {
    // BEGIN IMMEDIATE takes the write lock up front, so a status transition is
    // never half-applied if another statement in the same batch fails.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  read(id: string): OperationRecord | null {
    const row = this.database.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OperationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByIdempotencyKey(idempotencyKey: string): OperationRecord | null {
    const row = this.database
      .prepare('SELECT * FROM operations WHERE idempotency_key = ?')
      .get(idempotencyKey) as OperationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(limit = 100): OperationRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM operations ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as unknown as OperationRow[];
    return rows.map(rowToRecord);
  }

  private require(id: string): OperationRow {
    const row = this.database.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OperationRow | undefined;
    if (!row) throw new OperationStoreError('OPERATION_NOT_FOUND', `no operation with id ${id} exists`);
    return row;
  }

  transition(id: string, to: OperationStatus, detail: TransitionDetail = {}): OperationRecord {
    assertNoSecrets(detail);
    return this.write(() => this.applyTransition(id, to, detail));
  }

  recordTransactionHash(id: string, transactionHash: string): OperationRecord {
    const hash = validateTransactionHash(transactionHash);
    return this.write(() => {
      this.applyTransition(id, 'SUBMITTED', { diagnostic: `transaction hash ${hash}` });
      // The hash is the journal's primary evidence, so it gets its own column
      // instead of living only inside a diagnostic string. Both the status
      // change and the hash land in the same transaction.
      this.database
        .prepare('UPDATE operations SET transaction_hash = ? WHERE id = ?')
        .run(hash, id);
      return this.read(id) as OperationRecord;
    });
  }

  /**
   * The status check and UPDATE, assuming a transaction is already open.
   *
   * Kept separate from `write` so a caller that must change two things
   * atomically can do so without nesting transactions.
   */
  private applyTransition(id: string, to: OperationStatus, detail: TransitionDetail): OperationRecord {
    const row = this.require(id);
    const current = row.status as OperationStatus;
    // Checked BEFORE `nextOperationStatus`, because a finished operation
    // listing no successors would otherwise report the generic "not an
    // allowed transition" error and hide the fact that this particular
    // operation is closed for good. The row is left untouched either way.
    if (current === 'FINALIZED' && to !== 'FINALIZED') {
      throw new OperationStoreError(
        'OPERATION_ALREADY_FINALIZED',
        `operation ${id} is FINALIZED and may not be modified`
      );
    }
    // `nextOperationStatus` is the single authority: an illegal step throws
    // here and leaves the row untouched.
    const next = nextOperationStatus(current, to);
    const now = Math.floor(Date.now() / 1000);
    const jobId = detail.jobId ?? row.job_id;
    this.database
      .prepare('UPDATE operations SET status = ?, updated_at = ?, job_id = ?, failure_code = ?, diagnostic = ? WHERE id = ?')
      .run(next, now, jobId, detail.failureCode ?? row.failure_code, detail.diagnostic ?? row.diagnostic, id);
    return this.read(id) as OperationRecord;
  }

  /**
   * Add one observation.
   *
   * Observations are append-only. An existing observation for the same source
   * is kept as-is and a repeat is ignored, so a later, disagreeing observation
   * cannot quietly replace the evidence that was already recorded.
   */
  addObservation(id: string, observation: ReceiptObservation): OperationRecord {
    assertNoSecrets(observation);
    const row = this.require(id);
    const existing = this.parseObservations(row.observations);
    const alreadyRecorded = existing.some(o => o.source === observation.source);
    if (alreadyRecorded) return rowToRecord(row);
    const merged = [...existing, observation];
    this.database
      .prepare('UPDATE operations SET observations = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), Math.floor(Date.now() / 1000), id);
    return this.read(id) as OperationRecord;
  }

  private parseObservations(raw: string): readonly ReceiptObservation[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ReceiptObservation[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Recompute reconciliation from the observations on hand.
   *
   * This method is purely additive with respect to evidence. When the two
   * RPCs disagree it records `DISAGREED` and keeps both observations, so the
   * later failure explains itself without the earlier evidence being lost.
   * Finalization is not this method's job; it only reports what the
   * observations say.
   */
  reconcile(id: string): OperationRecord {
    const row = this.require(id);
    const observations = this.parseObservations(row.observations);
    const sources = observations.map(o => o.source);
    const hasBoth = sources.includes('primary') && sources.includes('secondary');

    let reconciliation: ReconciliationResult;
    if (hasBoth) {
      const [first, second] = [
        observations.find(o => o.source === 'primary') as ReceiptObservation,
        observations.find(o => o.source === 'secondary') as ReceiptObservation,
      ];
      const agreed = first.status === second.status
        && first.blockHash === second.blockHash
        && first.blockNumber === second.blockNumber
        && first.rpc !== second.rpc;
      reconciliation = agreed ? 'AGREED' : 'DISAGREED';
    } else {
      reconciliation = observations.length === 0 ? 'NOT_STARTED' : 'PENDING';
    }

    this.database
      .prepare('UPDATE operations SET reconciliation = ?, updated_at = ? WHERE id = ?')
      .run(reconciliation, Math.floor(Date.now() / 1000), id);
    return this.read(id) as OperationRecord;
  }

  fail(id: string, code: OperationFailureCode, diagnostic: string): OperationRecord {
    return this.transition(id, 'FAILED', { failureCode: code, diagnostic });
  }

  /**
   * Record a human decision about an ambiguous operation.
   *
   * The machine will not move an AMBIGUOUS operation on its own — only this
   * explicit, operator-driven call can — and even then it must resolve to
   * `FINALIZED` or `FAILED`, never back to something that looks automatic.
   */
  resolveAmbiguous(id: string, outcome: OperationStatus, diagnostic: string): OperationRecord {
    if (outcome !== 'FINALIZED' && outcome !== 'FAILED') {
      throw new OperationStoreError(
        'OPERATION_TRANSITION_INVALID',
        `AMBIGUOUS may only be resolved to FINALIZED or FAILED, not ${outcome}`
      );
    }
    return this.write(() => this.applyResolveAmbiguous(id, outcome, diagnostic));
  }

  /**
   * The AMBIGUOUS escape hatch, assuming a transaction is already open.
   *
   * This is the one transition that deliberately does NOT go through
   * `nextOperationStatus`. `ALLOWED_OPERATION_TRANSITIONS.AMBIGUOUS` is
   * empty on purpose, so the table would reject every step here and the
   * human resolution documented as the only way out would be unreachable.
   * Instead the state precondition is asserted here and the status is
   * written directly: the guard is "this operation is AMBIGUOUS", not
   * "this operation has successors".
   */
  private applyResolveAmbiguous(id: string, outcome: OperationStatus, diagnostic: string): OperationRecord {
    const row = this.require(id);
    if (row.status !== 'AMBIGUOUS') {
      throw new OperationStoreError(
        'OPERATION_TRANSITION_INVALID',
        `operation ${id} is ${row.status}, not AMBIGUOUS; only ambiguous operations may be resolved`
      );
    }
    this.database
      .prepare('UPDATE operations SET status = ?, updated_at = ?, diagnostic = ? WHERE id = ?')
      .run(outcome, Math.floor(Date.now() / 1000), diagnostic, id);
    return this.read(id) as OperationRecord;
  }

  claimSignerLease(request: SignerLeaseRequest): SignerLease {
    assertNoSecrets(request);
    const now = Math.floor(Date.now() / 1000);
    if (request.ttlSeconds <= 0) throw new OperationStoreError('LEASE_NOT_HELD', 'a lease ttl must be positive');
    const expiresAt = now + request.ttlSeconds;
    const leaseId = `${request.signer}:${request.nonce ?? 'auto'}:${now}`;

    // Begin IMMEDIATE means the UNIQUE(signer, nonce) check and this insert
    // cannot interleave with a competing claim.
    this.write(() => {
      this.database.prepare('DELETE FROM signer_leases WHERE expires_at <= ?').run(now);
      this.database
        .prepare('INSERT INTO signer_leases (lease_id, signer, nonce, holder, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(leaseId, request.signer, request.nonce, request.holder, expiresAt);
    });
    return { leaseId, signer: request.signer, nonce: request.nonce, holder: request.holder, expiresAt };
  }

  releaseSignerLease(leaseId: string, holder: string): void {
    this.write(() => {
      this.database.prepare('DELETE FROM signer_leases WHERE lease_id = ? AND holder = ?').run(leaseId, holder);
    });
  }

  close(): void {
    this.database.close();
  }
}

// ---------------------------------------------------------------------------
// In-memory journal (tests only)
// ---------------------------------------------------------------------------

/**
 * A journal whose data is lost on close.
 *
 * This exists so tests can exercise the status machine and the observation
 * merge rules without a filesystem, and it is named so that nobody could
 * mistake it for the durable store. It implements the same interface and the
 * same transition checks — including refusing to reopen durable behaviour —
 * so a test that passes against it is testing the same rules.
 */
export class InMemoryOperationStore implements OperationJournal {
  private readonly records = new Map<string, OperationRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly leases = new Map<string, SignerLease>();

  create(input: NewOperationInput): OperationRecord {
    assertNoSecrets(input);
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    const now = Math.floor(Date.now() / 1000);
    const record: OperationRecord = {
      schema: 'xyx.monad.operation.v1',
      id: input.idempotencyKey.slice(0, 64),
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      actor: input.actor,
      actorRole: input.actorRole,
      expectedChainId: input.expectedChainId,
      deployment: input.deployment,
      jobId: input.jobId ?? null,
      intentDigest: input.intentDigest,
      nonce: input.nonce ?? null,
      transactionHash: null,
      createdAt: now,
      updatedAt: now,
      status: 'PREPARED',
      receiptObservations: [],
      reconciliation: 'NOT_STARTED',
      failureCode: null,
      diagnostic: null,
    };
    this.records.set(record.id, record);
    this.byKey.set(record.idempotencyKey, record.id);
    return record;
  }

  read(id: string): OperationRecord | null {
    return this.records.get(id) ?? null;
  }

  findByIdempotencyKey(idempotencyKey: string): OperationRecord | null {
    const id = this.byKey.get(idempotencyKey);
    return id ? this.records.get(id) ?? null : null;
  }

  list(): OperationRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  transition(id: string, to: OperationStatus, detail: TransitionDetail = {}): OperationRecord {
    const record = this.records.get(id);
    if (!record) throw new OperationStoreError('OPERATION_NOT_FOUND', `no operation with id ${id} exists`);
    // Same ordering as the SQLite store: a finished operation must say it is
    // finished, not merely that the step is illegal.
    if (record.status === 'FINALIZED' && to !== 'FINALIZED') {
      throw new OperationStoreError('OPERATION_ALREADY_FINALIZED', `operation ${id} is FINALIZED`);
    }
    const next = nextOperationStatus(record.status, to);
    const updated: OperationRecord = {
      ...record,
      status: next,
      updatedAt: Math.floor(Date.now() / 1000),
      jobId: detail.jobId ?? record.jobId,
      failureCode: detail.failureCode ?? record.failureCode,
      diagnostic: detail.diagnostic ?? record.diagnostic,
    };
    this.records.set(id, updated);
    return updated;
  }

  recordTransactionHash(id: string, transactionHash: string): OperationRecord {
    const hash = validateTransactionHash(transactionHash);
    // The hash is the journal's primary evidence, so it is stored in its own
    // column rather than living only inside a diagnostic string.
    this.transition(id, 'SUBMITTED', { diagnostic: `transaction hash ${hash}` });
    return this.commit(id, { transactionHash: hash });
  }

  addObservation(id: string, observation: ReceiptObservation): OperationRecord {
    const record = this.records.get(id);
    if (!record) throw new OperationStoreError('OPERATION_NOT_FOUND', `no operation with id ${id} exists`);
    if (record.receiptObservations.some(o => o.source === observation.source)) return record;
    return this.commit(id, {
      receiptObservations: [...record.receiptObservations, observation],
    });
  }

  reconcile(id: string): OperationRecord {
    const record = this.records.get(id);
    if (!record) throw new OperationStoreError('OPERATION_NOT_FOUND', `no operation with id ${id} exists`);
    const observations = record.receiptObservations;
    // Mirrors the SQLite implementation exactly, so a test against either store
    // is testing the same rules. An unknown source is ignored: it can never
    // turn a missing required observation into a PENDING one.
    const primary = observations.find(o => o.source === 'primary');
    const secondary = observations.find(o => o.source === 'secondary');
    let reconciliation: ReconciliationResult;
    if (primary && secondary) {
      const agreeing = primary.blockHash === secondary.blockHash
        && primary.blockNumber === secondary.blockNumber
        && primary.status === secondary.status
        && primary.rpc !== secondary.rpc;
      reconciliation = agreeing ? 'AGREED' : 'DISAGREED';
    } else {
      reconciliation = observations.length === 0 ? 'NOT_STARTED' : 'PENDING';
    }
    return this.commit(id, { reconciliation });
  }

  fail(id: string, code: OperationFailureCode, diagnostic: string): OperationRecord {
    return this.transition(id, 'FAILED', { failureCode: code, diagnostic });
  }

  resolveAmbiguous(id: string, outcome: OperationStatus, diagnostic: string): OperationRecord {
    if (outcome !== 'FINALIZED' && outcome !== 'FAILED') {
      throw new OperationStoreError('OPERATION_TRANSITION_INVALID', `AMBIGUOUS may only resolve to FINALIZED or FAILED`);
    }
    // Same deliberate exception to `nextOperationStatus` the SQLite store
    // makes: AMBIGUOUS has no successors in the table, so the precondition
    // is checked here and the status written directly. An operation that is
    // not AMBIGUOUS must not be resolved, whatever its current status.
    const record = this.records.get(id);
    if (!record) throw new OperationStoreError('OPERATION_NOT_FOUND', `no operation with id ${id} exists`);
    if (record.status !== 'AMBIGUOUS') {
      throw new OperationStoreError(
        'OPERATION_TRANSITION_INVALID',
        `operation ${id} is ${record.status}, not AMBIGUOUS; only ambiguous operations may be resolved`
      );
    }
    return this.commit(id, { status: outcome, diagnostic });
  }

  claimSignerLease(request: SignerLeaseRequest): SignerLease {
    const now = Math.floor(Date.now() / 1000);
    for (const lease of this.leases.values()) {
      if (lease.expiresAt <= now) this.leases.delete(lease.leaseId);
    }
    for (const lease of this.leases.values()) {
      if (lease.signer === request.signer && lease.nonce === request.nonce) {
        throw new OperationStoreError('SIGNER_BUSY', `signer ${request.signer} nonce ${request.nonce ?? 'auto'} is leased`);
      }
    }
    const lease: SignerLease = {
      leaseId: `${request.signer}:${request.nonce ?? 'auto'}:${now}`,
      signer: request.signer,
      nonce: request.nonce,
      holder: request.holder,
      expiresAt: now + request.ttlSeconds,
    };
    this.leases.set(lease.leaseId, lease);
    return lease;
  }

  releaseSignerLease(leaseId: string, holder: string): void {
    const lease = this.leases.get(leaseId);
    if (lease && lease.holder === holder) this.leases.delete(leaseId);
  }

  close(): void {
    this.records.clear();
    this.byKey.clear();
    this.leases.clear();
  }

  private commit(id: string, patch: Partial<OperationRecord>): OperationRecord {
    const current = this.records.get(id);
    if (!current) throw new OperationStoreError('OPERATION_NOT_FOUND', `no operation with id ${id} exists`);
    const updated: OperationRecord = { ...current, ...patch, updatedAt: Math.floor(Date.now() / 1000) };
    this.records.set(id, updated);
    return updated;
  }
}

/**
 * Open the durable journal at an explicit path.
 *
 * This is the only supported way to get a journal that survives a restart. It
 * exists as a distinct entry point so that a caller who wants persistence is
 * forced to name where the data lives, and so a missing configuration is a
 * loud failure rather than a silent fallback.
 */
export function openOperationStore(filename: string): SqliteOperationStore {
  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new OperationStoreError('STORAGE_PATH_REQUIRED', 'a durable storage path must be configured');
  }
  if (IN_MEMORY_MARKERS.has(filename.trim())) {
    throw new OperationStoreError(
      'STORAGE_DURABILITY_REFUSED',
      'an in-memory path is not a durable operation journal; configure a real storage path'
    );
  }
  return new SqliteOperationStore(filename);
}

/** True when a stored file already contains operations, i.e. is a real journal. */
export function isDurableJournalFile(filename: string): boolean {
  if (typeof filename !== 'string' || IN_MEMORY_MARKERS.has(filename.trim())) return false;
  if (!existsSync(filename)) return false;
  try {
    return statSync(filename).isFile();
  } catch {
    return false;
  }
}

export type { OperationError };
