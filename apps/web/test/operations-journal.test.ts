/**
 * Tests for the server-side operations journal wiring.
 *
 * These tests check behaviour, not just types:
 *
 *   - An unconfigured server is not a durable journal, and must not be handed
 *     a store that silently loses data on restart.
 *   - `:memory:` is refused for the same reason.
 *   - Configuration is honoured per-process, and a reset returns the module to
 *     its unconfigured state so tests cannot leak a journal into each other.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { after, beforeEach, describe, it } from 'node:test';

/**
 * The module is imported statically because it takes its configuration from
 * `process.env` at call time rather than import time — which is what makes
 * "configuration can change between calls" a testable property.
 */
import {
  isOperationJournalOpen,
  OPERATIONS_DB_PATH_ENV,
  operationJournal,
  OperationsConfigurationError,
  resetOperationJournal,
} from '../lib/server/operations/journal';
// `OperationJournal` is declared in the store implementation, but the operation
// module's public index is the surface a consumer is meant to import, so this
// test imports the type from there rather than reaching into the store.
import type { OperationJournal } from '../../../packages/monad/src/operations/index';

/** The one variable every test in this file sets and clears. */
const originalPath = process.env[OPERATIONS_DB_PATH_ENV];

function clearConfiguration(): void {
  resetOperationJournal();
  delete process.env[OPERATIONS_DB_PATH_ENV];
}

describe('server journal configuration', () => {
  beforeEach(clearConfiguration);
  after(() => {
    resetOperationJournal();
    if (originalPath === undefined) delete process.env[OPERATIONS_DB_PATH_ENV];
    else process.env[OPERATIONS_DB_PATH_ENV] = originalPath;
  });

  it('refuses to open a journal when no durable path is configured', () => {
    assert.equal(isOperationJournalOpen(), false);
    assert.throws(
      () => operationJournal(),
      (e: unknown) =>
        e instanceof OperationsConfigurationError &&
        e.code === 'OPERATIONS_STORAGE_PATH_REQUIRED' &&
        e.message.includes(OPERATIONS_DB_PATH_ENV),
      'an unconfigured server must not be silently given a usable store'
    );
    // The failure is not sticky: no half-open journal is left behind.
    assert.equal(isOperationJournalOpen(), false);
  });

  it('refuses an in-memory path even when explicitly configured', () => {
    process.env[OPERATIONS_DB_PATH_ENV] = ':memory:';
    assert.throws(
      () => operationJournal(),
      (e: unknown) =>
        e instanceof OperationsConfigurationError &&
        e.code === 'OPERATIONS_STORAGE_PATH_REQUIRED' &&
        e.message.includes(':memory:'),
      'a server configured to forget its journal must not be opened'
    );
    assert.equal(isOperationJournalOpen(), false);
  });

  it('refuses an empty or whitespace-only configuration rather than guessing a path', () => {
    for (const value of ['', '   ', '\t\n']) {
      process.env[OPERATIONS_DB_PATH_ENV] = value;
      assert.throws(() => operationJournal(), OperationsConfigurationError, `"${value}" must not be a path`);
    }
  });

  it('opens one journal per process and reuses it, so concurrent requests share it', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'xyx-server-journal-'));
    try {
      process.env[OPERATIONS_DB_PATH_ENV] = path.join(directory, 'journal.sqlite');
      const first: OperationJournal = operationJournal();
      assert.equal(isOperationJournalOpen(), true);
      assert.equal(operationJournal(), first, 'the journal must be cached, not reopened per request');
    } finally {
      clearConfiguration();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resets cleanly so one test cannot leak a journal into the next', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'xyx-server-journal-reset-'));
    try {
      process.env[OPERATIONS_DB_PATH_ENV] = path.join(directory, 'journal.sqlite');
      const opened = operationJournal();
      resetOperationJournal();
      assert.equal(isOperationJournalOpen(), false);
      // A reopened journal must not be the same instance.
      assert.notEqual(operationJournal(), opened);
    } finally {
      clearConfiguration();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps configuration failures distinguishable from data failures', () => {
    // A configuration error is actionable (set a variable); a read failure is
    // not. The route needs to tell them apart, so the type must be explicit.
    assert.ok(new OperationsConfigurationError('reason') instanceof Error);
    try {
      operationJournal();
      assert.fail('an unconfigured journal must not open');
    } catch (error) {
      assert.equal((error as OperationsConfigurationError).code, 'OPERATIONS_STORAGE_PATH_REQUIRED');
      // The message names the variable, never a filesystem path that could
      // carry a secret.
      assert.ok((error as Error).message.includes(OPERATIONS_DB_PATH_ENV));
    }
  });
});
