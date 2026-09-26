/**
 * Server-side wiring for the durable operation journal.
 *
 * This module owns exactly one decision that the API routes must not make for
 * themselves: **where** the journal lives. It exists so that the durability
 * contract is enforced in a single place rather than re-derived at each call
 * site, and so that a missing configuration fails loudly instead of quietly
 * degrading.
 *
 * ## Fail-closed behaviour
 *
 * `operationJournal()` requires `XYX_OPERATIONS_DB_PATH` to be set to a real
 * filesystem path. There is deliberately no default, and no fallback to an
 * in-memory store. A server that has not been configured for durable
 * operations answers `OPERATIONS_STORAGE_PATH_REQUIRED` rather than accepting
 * writes it would lose on the next restart. A configuration that names an
 * in-memory path is refused for the same reason.
 *
 * ## Single-worker limit
 *
 * One Node process owns the journal for its lifetime. The module caches the
 * open store, which makes concurrent requests within one process share one
 * connection (so their writes are serialised by SQLite), but it does not
 * coordinate with any other process touching the same file. See
 * `packages/monad/src/operations/store.ts` for the full statement of what is
 * and is not guaranteed.
 *
 * @module operations-server
 */

import {
  OperationStoreError,
  openOperationStore,
  SqliteOperationStore,
  type OperationJournal,
} from '../../../../../packages/monad/src/operations/store';

/** Environment variable that must name the journal's durable location. */
export const OPERATIONS_DB_PATH_ENV = 'XYX_OPERATIONS_DB_PATH' as const;

/** Stable, machine-readable error code for a missing journal configuration. */
export const OPERATIONS_STORAGE_PATH_REQUIRED = 'OPERATIONS_STORAGE_PATH_REQUIRED' as const;

export class OperationsConfigurationError extends Error {
  readonly code = OPERATIONS_STORAGE_PATH_REQUIRED;

  constructor(message: string) {
    super(`${OPERATIONS_STORAGE_PATH_REQUIRED}: ${message}`);
    this.name = 'OperationsConfigurationError';
  }
}

let cached: SqliteOperationStore | null = null;

/**
 * The journal for this process, opening it on first use.
 *
 * Throws `OperationsConfigurationError` when the durable path is not
 * configured. That is the whole point: a caller cannot accidentally get a
 * store it should not trust.
 */
export function operationJournal(): OperationJournal {
  if (cached) return cached;
  const configured = process.env[OPERATIONS_DB_PATH_ENV];
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new OperationsConfigurationError(
      `${OPERATIONS_DB_PATH_ENV} must name a durable filesystem path for the operation journal`
    );
  }
  if (configured.trim() === ':memory:') {
    throw new OperationsConfigurationError(
      `${OPERATIONS_DB_PATH_ENV} must not be ':memory:'; an in-memory journal is not durable`
    );
  }
  cached = openOperationStore(configured.trim());
  return cached;
}

/** Reset the cached journal. For tests and explicit shutdown only. */
export function resetOperationJournal(): void {
  if (cached) {
    try {
      cached.close();
    } catch {
      // A store that cannot be closed is still forgotten: the next call will
      // either reopen the same file or fail on configuration, and neither
      // outcome depends on this close succeeding.
    }
  }
  cached = null;
}

/** True when this process has already opened a durable journal. */
export function isOperationJournalOpen(): boolean {
  return cached !== null;
}

/** True when the operations journal storage path is configured and valid. */
export function isOperationJournalConfigured(): boolean {
  const configured = process.env[OPERATIONS_DB_PATH_ENV];
  return typeof configured === 'string' && configured.trim() !== '' && configured.trim() !== ':memory:';
}

/** Re-exported so a route can distinguish a config failure from a data failure. */
export { OperationStoreError };
