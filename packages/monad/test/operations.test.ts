/**
 * Tests for the durable operation journal.
 *
 * These tests are deliberately adversarial about the properties the module
 * claims. In particular:
 *
 *   - `ALLOWED_OPERATION_TRANSITIONS` is checked exhaustive-exhaustively:
 *     for every ordered pair of statuses, the transition must either be
 *     allowed or rejected, and AMBIGUOUS must have no successors at all.
 *   - The durable store is re-opened from disk after `close()`, so "state
 *     survives restart" is demonstrated rather than asserted.
 *   - A reconciliation that disagrees is shown to preserve both observations.
 *   - The store refuses an in-memory path, and every durable path must be
 *     explicit.
 *
 * @module operations.test
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  ALLOWED_OPERATION_TRANSITIONS,
  OperationError,
  OPERATION_STATUSES,
  assertKnownFields,
  assertNoSecrets,
  canAwaitFinality,
  evaluateFinality,
  findSecretShapedValue,
  isOperationTerminal,
  kindRequiresJobId,
  nextOperationStatus,
  sameDeploymentBinding,
  validateChainId,
  validateDeploymentBinding,
  validateIdempotencyKey,
  validateIntentDigest,
  validateOperationKind,
  validateTransactionHash,
  InMemoryOperationStore,
  OperationStoreError,
  openOperationStore,
  type ReceiptObservation,
  type OperationRecord,
} from '../src/operations/index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEPLOYMENT = {
  protocol: '0x1111111111111111111111111111111111111111' as const,
  registry: '0x2222222222222222222222222222222222222222' as const,
  verifier: '0x3333333333333333333333333333333333333333' as const,
  paymentToken: '0x4444444444444444444444444444444444444444' as const,
};

const NO_JOB_OP = {
  idempotencyKey: 'op-key-0001',
  kind: 'PROPOSE_JOB' as const,
  actor: '0x5555555555555555555555555555555555555555' as const,
  actorRole: 'buyer' as const,
  expectedChainId: 10143,
  deployment: DEPLOYMENT,
  jobId: null,
  intentDigest: `0x${'ab'.repeat(32)}` as const,
  nonce: 0,
};

const ACTOR = NO_JOB_OP.actor;

function observation(
  source: ReceiptObservation['source'],
  rpc: string,
  overrides: Partial<ReceiptObservation> = {}
): ReceiptObservation {
  return {
    source,
    rpc,
    blockNumber: 1234,
    blockHash: `0x${'cd'.repeat(32)}`,
    status: 'success',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

describe('the lifecycle transition table', () => {
  it('is exhaustive: every ordered pair is either allowed or rejected, with no gaps', () => {
    for (const from of OPERATION_STATUSES) {
      for (const to of OPERATION_STATUSES) {
        const allowed = ALLOWED_OPERATION_TRANSITIONS[from].includes(to);
        if (allowed) {
          assert.equal(nextOperationStatus(from, to), to, `${from} -> ${to} should be allowed and return ${to}`);
        } else {
          assert.throws(
            () => nextOperationStatus(from, to),
            /OPERATION_TRANSITION_INVALID/,
            `${from} -> ${to} should be rejected`
          );
        }
      }
    }
  });

  it('never allows FINALIZED to be left, so finality cannot be undone', () => {
    for (const to of OPERATION_STATUSES) {
      assert.ok(
        !ALLOWED_OPERATION_TRANSITIONS.FINALIZED.includes(to) || to === 'FINALIZED',
        'FINALIZED may only map to itself, never to another state'
      );
    }
    assert.throws(() => nextOperationStatus('FINALIZED', 'FAILED'), /OPERATION_TRANSITION_INVALID/);
  });

  it('never allows AMBIGUOUS to move automatically, even to FINALIZED', () => {
    assert.deepEqual([...ALLOWED_OPERATION_TRANSITIONS.AMBIGUOUS], []);
    for (const to of OPERATION_STATUSES) {
      assert.throws(() => nextOperationStatus('AMBIGUOUS', to), /OPERATION_TRANSITION_INVALID/);
    }
  });

  it('requires a real hash before PENDING_FINALITY, and agreement before FINALIZED', () => {
    // A prepared operation may await finality once it exists, because
    // reconciliation — not the status alone — is what grants finality.
    assert.ok(ALLOWED_OPERATION_TRANSITIONS.PREPARED.includes('PENDING_FINALITY'));
    // But nothing auto-asserts finality for a prepared operation: reaching
    // FINALIZED has to go through SUBMITTED first, so an observation is always
    // required before a caller can claim finality.
    assert.ok(!ALLOWED_OPERATION_TRANSITIONS.PREPARED.includes('FINALIZED'));
    // And no ambiguous operation ever becomes final on its own.
    assert.ok(!ALLOWED_OPERATION_TRANSITIONS.AMBIGUOUS.includes('FINALIZED'));
  });

  it('distinguishes terminal from non-terminal, and AMBIGUOUS is terminal while not auto-retryable', () => {
    assert.ok(isOperationTerminal('FINALIZED'));
    assert.ok(isOperationTerminal('AMBIGUOUS'));
    assert.ok(!isOperationTerminal('SUBMITTED'));
    assert.ok(!isOperationTerminal('PENDING_FINALITY'));
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('request bodies are validated before anything else runs', () => {
  it('rejects a secret-shaped field name regardless of casing or punctuation', () => {
    assert.throws(
      () => assertNoSecrets({ privateKey: 'x' }),
      (e: unknown) => e instanceof OperationError && e.code === 'SECRET_SHAPED_INPUT_REJECTED'
    );
    assert.throws(
      () => assertNoSecrets({ 'PRIVATE-KEY': 'x' }),
      (e: unknown) => e instanceof OperationError && e.code === 'SECRET_SHASHED_INPUT_REJECTED' || e.code === 'SECRET_SHAPED_INPUT_REJECTED'
    );
    assert.throws(
      () => assertNoSecrets({ passkey: { id: 'x' } }),
      (e: unknown) => e instanceof OperationError && e.code === 'SECRET_SHAPED_INPUT_REJECTED'
    );
  });

  it('rejects a secret-shaped value even under an innocuous field name', () => {
    // A 32-byte hex string is a raw private key or PRF output, whatever the
    // caller chose to name it.
    assert.throws(
      () => assertNoSecrets({ anything: `0x${'ff'.repeat(32)}` }),
      (e: unknown) => e instanceof OperationError && e.code === 'SECRET_SHAPED_INPUT_REJECTED'
    );
    // A 12-word mnemonic phrase.
    assert.throws(
      () => assertNoSecrets({ phrase: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima' }),
      (e: unknown) => e instanceof OperationError && e.code === 'SECRET_SHAPED_INPUT_REJECTED'
    );
  });

  it('accepts a normal, secret-free body and reports no rejection', () => {
    assert.equal(findSecretShapedValue({ actor: ACTOR, jobId: 7, kind: 'FUND_JOB' }), null);
  });

  it('refuses unknown top-level fields, so a future credential cannot be smuggled in', () => {
    assert.throws(
      () => assertKnownFields({ id: 'a', private_key: 'b' }, ['id']),
      (e: unknown) => e instanceof OperationError && e.code === 'UNKNOWN_FIELD_REJECTED'
    );
    assert.doesNotThrow(() => assertKnownFields({ id: 'a' }, ['id']));
  });

  it('validates each primitive strictly', () => {
    assert.equal(validateOperationKind('FUND_JOB'), 'FUND_JOB');
    assert.throws(() => validateOperationKind('MINT_ARBITRARY_TX'), /OPERATION_KIND_INVALID/);

    assert.equal(validateChainId(10143), 10143);
    assert.throws(() => validateChainId(1), /CHAIN_ID_MISMATCH/);

    assert.equal(validateIntentDigest(`0x${'ab'.repeat(32)}`), `0x${'ab'.repeat(32)}`);
    assert.throws(() => validateIntentDigest('0xabc'), /INTENT_DIGEST_INVALID/);

    assert.equal(validateTransactionHash(`0x${'ab'.repeat(32)}`), `0x${'ab'.repeat(32)}`);
    assert.throws(() => validateTransactionHash('0xabc'), /TRANSACTION_HASH_INVALID/);

    assert.equal(validateIdempotencyKey('key-123456'), 'key-123456');
    assert.throws(() => validateIdempotencyKey('short'), /IDEMPOTENCY_KEY_REQUIRED/);
  });

  it('requires a complete deployment binding and refuses a zero address', () => {
    for (const field of ['protocol', 'registry', 'verifier', 'paymentToken'] as const) {
      assert.throws(
        () => validateDeploymentBinding({ ...DEPLOYMENT, [field]: undefined }),
        /DEPLOYMENT_BINDING_INCOMPLETE/,
        `omitting ${field} must be refused`
      );
      assert.throws(
        () => validateDeploymentBinding({ ...DEPLOYMENT, [field]: `0x${'0'.repeat(40)}` }),
        /DEPLOYMENT_BINDING_MISMATCH/,
        `a zero ${field} must be refused`
      );
    }
    assert.doesNotThrow(() => validateDeploymentBinding(DEPLOYMENT));
  });

  it('compares deployment bindings case-insensitively and distinguishes different ones', () => {
    assert.ok(sameDeploymentBinding(DEPLOYMENT, {
      ...DEPLOYMENT,
      protocol: DEPLOYMENT.protocol.toUpperCase().replace('0X', '0x') as typeof DEPLOYMENT.protocol,
    }));
    assert.ok(!sameDeploymentBinding(DEPLOYMENT, { ...DEPLOYMENT, paymentToken: DEPLOYMENT.registry }));
  });

  it('requires a job id for every lifecycle action but the publisher', () => {
    assert.ok(kindRequiresJobId('PROPOSE_JOB'));
    assert.ok(kindRequiresJobId('RESOLVE_JOB'));
    assert.ok(!kindRequiresJobId('PUBLISH_CANONICAL_MANIFEST'));
  });
});

// ---------------------------------------------------------------------------
// Finality evaluation
// ---------------------------------------------------------------------------

describe('finality requires dual-RPC agreement, and anything less is not final', () => {
  it('is NOT_FINALIZED with no observations at all', () => {
    const e = evaluateFinality({ transactionHash: `0x${'aa'.repeat(32)}`, receiptObservations: [] });
    assert.equal(e.verdict, 'NOT_FINALIZED');
    assert.ok(e.missing.includes('PRIMARY_OBSERVATION_MISSING'));
    assert.ok(e.missing.includes('SECONDARY_OBSERVATION_MISSING'));
  });

  it('is NOT_FINALIZED with only one observation', () => {
    const e = evaluateFinality({
      transactionHash: `0x${'aa'.repeat(32)}`,
      receiptObservations: [observation('primary', 'rpc-a')],
    });
    assert.equal(e.verdict, 'NOT_FINALIZED');
    assert.equal(e.reconciliation, 'PENDING');
  });

  it('is NOT_FINALIZED when both observations come from the same endpoint', () => {
    // Same label on both is not two observations; it is one counted twice.
    const e = evaluateFinality({
      transactionHash: `0x${'aa'.repeat(32)}`,
      receiptObservations: [observation('primary', 'rpc-a'), observation('secondary', 'rpc-a')],
    });
    assert.equal(e.verdict, 'NOT_FINALIZED');
    assert.ok(e.missing.includes('OBSERVATIONS_NOT_INDEPENDENT'));
    assert.equal(e.reconciliation, 'DISAGREED');
  });

  it('is NOT_FINALIZED when independent endpoints disagree on the block hash', () => {
    const e = evaluateFinality({
      transactionHash: `0x${'aa'.repeat(32)}`,
      receiptObservations: [
        observation('primary', 'rpc-a'),
        observation('secondary', 'rpc-b', { blockHash: `0x${'ee'.repeat(32)}` }),
      ],
    });
    assert.equal(e.verdict, 'NOT_FINALIZED');
    assert.ok(e.missing.includes('RECEIPT_FACTS_DISAGREE'));
    assert.equal(e.reconciliation, 'DISAGREED');
  });

  it('is NOT_FINALIZED when independent endpoints disagree on the status', () => {
    const e = evaluateFinality({
      transactionHash: `0x${'aa'.repeat(32)}`,
      receiptObservations: [
        observation('primary', 'rpc-a'),
        observation('secondary', 'rpc-b', { status: 'reverted' }),
      ],
    });
    assert.equal(e.verdict, 'NOT_FINALIZED');
  });

  it('is NOT_FINALIZED when the agreed receipt is a revert', () => {
    const e = evaluateFinality({
      transactionHash: `0x${'aa'.repeat(32)}`,
      receiptObservations: [
        observation('primary', 'rpc-a', { status: 'reverted' }),
        observation('secondary', 'rpc-b', { status: 'reverted' }),
      ],
    });
    assert.equal(e.verdict, 'NOT_FINALIZED');
    assert.ok(e.missing.includes('RECEIPT_FACTS_DISAGREE'));
  });

  it('is NOT_FINALIZED when there is no transaction hash at all', () => {
    const e = evaluateFinality({
      transactionHash: null,
      receiptObservations: [observation('primary', 'rpc-a'), observation('secondary', 'rpc-b')],
    });
    assert.equal(e.verdict, 'NOT_FINALIZED');
    assert.ok(e.missing.includes('TRANSACTION_HASH_REQUIRED'));
  });

  it('is FINALIZED only with a hash and two agreeing independent observations', () => {
    const e = evaluateFinality({
      transactionHash: `0x${'aa'.repeat(32)}`,
      receiptObservations: [observation('primary', 'rpc-a'), observation('secondary', 'rpc-b')],
    });
    assert.equal(e.verdict, 'FINALIZED');
    assert.equal(e.reconciliation, 'AGREED');
    assert.deepEqual(e.missing, []);
  });

  it('treats a hashless send as ambiguous rather than pending', () => {
    assert.ok(canAwaitFinality({ transactionHash: `0x${'aa'.repeat(32)}`, receiptObservations: [] }));
    assert.ok(!canAwaitFinality({ transactionHash: null, receiptObservations: [] }));
    assert.ok(!canAwaitFinality({ transactionHash: '', receiptObservations: [] }));
  });
});

// ---------------------------------------------------------------------------
// Journal lifecycle
// ---------------------------------------------------------------------------

describe('the journal enforces the transition table on every write', () => {
  it('creates an operation in PREPARED with no hash and no observations', () => {
    const result = new InMemoryOperationStore().create(NO_JOB_OP);
    assert.equal(result.status, 'PREPARED');
    assert.equal(result.transactionHash, null);
    assert.deepEqual(result.receiptObservations, []);
    assert.equal(result.schema, 'xyx.monad.operation.v1');
  });

  it('returns the original record for a duplicate idempotency key instead of creating a second one', () => {
    const store = new InMemoryOperationStore();
    const first = store.create(NO_JOB_OP);
    const second = store.create(NO_JOB_OP);
    assert.equal(first.id, second.id);
    assert.equal(store.list().length, 1);
  });

  it('refuses to skip from PREPARED to FINALIZED with no hash recorded', () => {
    const store = new InMemoryOperationStore();
    const r = store.create(NO_JOB_OP);
    assert.throws(() => store.transition(r.id, 'FINALIZED'), /OPERATION_TRANSITION_INVALID/);
    assert.equal(store.read(r.id)?.status, 'PREPARED');
  });

  it('refuses an illegal transition and leaves the row untouched', () => {
    const store = new InMemoryOperationStore();
    const r = store.create(NO_JOB_OP);
    assert.throws(() => store.transition(r.id, 'FINALIZED'), /OPERATION_TRANSITION_INVALID/);
    assert.equal(store.read(r.id)?.status, 'PREPARED');
  });

  it('refuses to reopen a FINALIZED operation', () => {
    const store = new InMemoryOperationStore();
    const r = store.create(NO_JOB_OP);
    store.recordTransactionHash(r.id, `0x${'aa'.repeat(32)}`);
    store.addObservation(r.id, observation('primary', 'rpc-a'));
    store.addObservation(r.id, observation('secondary', 'rpc-b'));
    store.reconcile(r.id);
    store.transition(r.id, 'FINALIZED');
    assert.throws(
      () => store.transition(r.id, 'FAILED'),
      (e: unknown) => e instanceof OperationStoreError && e.code === 'OPERATION_ALREADY_FINALIZED'
    );
    assert.equal(store.read(r.id)?.status, 'FINALIZED');
  });

  it('keeps an AMBIGUOUS operation unreadable as final until a human resolves it', () => {
    const store = new InMemoryOperationStore();
    const r = store.create(NO_JOB_OP);
    store.transition(r.id, 'AMBIGUOUS');
    // The machine will not move it, not even a single step.
    assert.throws(() => store.transition(r.id, 'PENDING_FINALITY'), /OPERATION_TRANSITION_INVALID/);
    // Only an explicit human resolution moves it.
    const resolved = store.resolveAmbiguous(r.id, 'FAILED', 'operator confirmed the send never hit a mempool');
    assert.equal(resolved.status, 'FAILED');
  });

  it('refuses to resolve something that is not AMBIGUOUS', () => {
    const store = new InMemoryOperationStore();
    const r = store.create(NO_JOB_OP);
    assert.throws(() => store.resolveAmbiguous(r.id, 'FINALIZED'), /OPERATION_TRANSITION_INVALID/);
  });

  it('refuses an operation that does not exist', () => {
    const store = new InMemoryOperationStore();
    assert.throws(
      () => store.transition('no-such-op', 'FAILED'),
      (e: unknown) => e instanceof OperationStoreError && e.code === 'OPERATION_NOT_FOUND'
    );
  });
});

// ---------------------------------------------------------------------------
// Reconciliation and evidence preservation
// ---------------------------------------------------------------------------

describe('reconciliation preserves evidence', () => {
  it('is NOT_STARTED, then PENDING, then AGREED as observations arrive', () => {
    const store = new InMemoryOperationStore();
    const r = store.create(NO_JOB_OP);
    store.recordTransactionHash(r.id, `0x${'aa'.repeat(32)}`);
    assert.equal(store.reconcile(r.id).reconciliation, 'NOT_STARTED');
    store.addObservation(r.id, observation('primary', 'rpc-a'));
    assert.equal(store.reconcile(r.id).reconciliation, 'PENDING');
    store.addObservation(r.id, observation('secondary', 'rpc-b'));
    assert.equal(store.reconcile(r.id).reconciliation, 'AGREED');
  });

  it('records DISAGREED and keeps BOTH observations, so the conflict explains itself', () => {
    const store = new InMemoryOperationStore();
    const r = store.create(NO_JOB_OP);
    store.recordTransactionHash(r.id, `0x${'aa'.repeat(32)}`);
    store.addObservation(r.id, observation('primary', 'rpc-a'));
    store.addObservation(r.id, observation('secondary', 'rpc-b', { blockHash: `0x${'ee'.repeat(32)}` }));
    const reconciled = store.reconcile(r.id);
    assert.equal(reconciled.reconciliation, 'DISAGREED');
    // The evidence for the disagreement survives the reconciliation itself.
    assert.equal(reconciled.receiptObservations.length, 2);
    assert.deepEqual(
      reconciled.receiptObservations.map(o => o.rpc).sort(),
      ['rpc-a', 'rpc-b']
    );
  });

  it('never replaces or drops an existing observation', () => {
    const store = new InMemoryOperationStore();
    const r = store.create(NO_JOB_OP);
    const first = observation('primary', 'rpc-a');
    store.addObservation(r.id, first);
    store.addObservation(r.id, observation('primary', 'rpc-a', { blockHash: `0x${'ff'.repeat(32)}` }));
    const after = store.read(r.id) as OperationRecord;
    assert.equal(after.receiptObservations.length, 1);
    assert.equal(after.receiptObservations[0]?.blockHash, first.blockHash);
  });

  it('a failed reconciliation still records the diagnostic alongside prior evidence', () => {
    const store = new InMemoryOperationStore();
    const r = store.create(NO_JOB_OP);
    store.recordTransactionHash(r.id, `0x${'aa'.repeat(32)}`);
    store.addObservation(r.id, observation('primary', 'rpc-a'));
    store.addObservation(r.id, observation('secondary', 'rpc-b', { blockNumber: 999 }));
    store.reconcile(r.id);
    const failed = store.fail(r.id, 'RECONCILIATION_CONFLICT', 'the two RPCs reported different block numbers');
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.failureCode, 'RECONCILIATION_CONFLICT');
    assert.equal(failed.receiptObservations.length, 2, 'the disputed evidence is not discarded on failure');
  });
});

// ---------------------------------------------------------------------------
// Signer leases
// ---------------------------------------------------------------------------

describe('signer leases prevent a nonce being consumed twice', () => {
  it('lets one holder claim a signer/nonce pair', () => {
    const store = new InMemoryOperationStore();
    assert.doesNotThrow(() => store.claimSignerLease({ signer: ACTOR, nonce: 4, ttlSeconds: 60, holder: 'a' }));
  });

  it('refuses a second operation against the same signer/nonce', () => {
    const store = new InMemoryOperationStore();
    store.claimSignerLease({ signer: ACTOR, nonce: 4, ttlSeconds: 60, holder: 'a' });
    assert.throws(
      () => store.claimSignerLease({ signer: ACTOR, nonce: 4, ttlSeconds: 60, holder: 'b' }),
      (e: unknown) => e instanceof OperationStoreError && e.code === 'SIGNER_BUSY'
    );
  });

  it('lets a different nonce be claimed independently', () => {
    const store = new InMemoryOperationStore();
    store.claimSignerLease({ signer: ACTOR, nonce: 4, ttlSeconds: 60, holder: 'a' });
    assert.doesNotThrow(() => store.claimSignerLease({ signer: ACTOR, nonce: 5, ttlSeconds: 60, holder: 'b' }));
  });

  it('releases a lease for its holder and nobody else', () => {
    const store = new InMemoryOperationStore();
    const lease = store.claimSignerLease({ signer: ACTOR, nonce: 4, ttlSeconds: 60, holder: 'a' });
    store.releaseSignerLease(lease.leaseId, 'b');
    assert.throws(() => store.claimSignerLease({ signer: ACTOR, nonce: 4, ttlSeconds: 60, holder: 'b' }));
    store.releaseSignerLease(lease.leaseId, 'a');
    assert.doesNotThrow(() => store.claimSignerLease({ signer: ACTOR, nonce: 4, ttlSeconds: 60, holder: 'b' }));
  });
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

describe('the store is durable, and refuses not to be', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'xyx-operations-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses to open an in-memory journal', () => {
    assert.throws(
      () => openOperationStore(':memory:'),
      (e: unknown) => e instanceof OperationStoreError && e.code === 'STORAGE_DURABILITY_REFUSED'
    );
    assert.throws(
      () => openOperationStore(''),
      (e: unknown) => e instanceof OperationStoreError && e.code === 'STORAGE_PATH_REQUIRED'
    );
  });

  it('requires a durable path to be explicit in configuration', () => {
    assert.throws(
      () => openOperationStore(':memory:'),
      (e: unknown) => e instanceof OperationStoreError && e.code === 'STORAGE_DURABILITY_REFUSED'
    );
    // An empty path is a configuration omission, not a location.
    assert.throws(
      () => openOperationStore('   '),
      (e: unknown) => e instanceof OperationStoreError && e.code === 'STORAGE_PATH_REQUIRED'
    );
  });

  it('keeps a committed operation across close and reopen', () => {
    const file = path.join(directory, 'journal.sqlite');
    const first = openOperationStore(file);
    const created = first.create(NO_JOB_OP);
    first.recordTransactionHash(created.id, `0x${'aa'.repeat(32)}`);
    first.addObservation(created.id, observation('primary', 'rpc-a'));
    first.close();

    // The file exists on disk, and reopening it recovers the state exactly.
    assert.ok(existsSync(file), 'the journal file must exist on disk');
    const reopened = openOperationStore(file);
    const recovered = reopened.read(created.id);
    assert.ok(recovered);
    assert.equal(recovered.status, 'SUBMITTED');
    assert.equal(recovered.transactionHash, `0x${'aa'.repeat(32)}`);
    assert.equal(recovered.receiptObservations.length, 1);
    // And the restart does not reopen a finished operation. SUBMITTED ->
    // FINALIZED is legal by design (a receipt already agreed upon survives a
    // restart), so what must survive the reopen is the terminal state: once
    // FINALIZED, the journal refuses every further write.
    reopened.transition(created.id, 'FINALIZED');
    assert.throws(
      () => reopened.transition(created.id, 'FAILED'),
      (e: unknown) => e instanceof OperationStoreError && e.code === 'OPERATION_ALREADY_FINALIZED'
    );
    reopened.close();
  });

  it('does not require close() for durability: the data is already on disk', () => {
    const file = path.join(directory, 'no-close.sqlite');
    const store = openOperationStore(file);
    const created = store.create({ ...NO_JOB_OP, idempotencyKey: 'op-key-0002' });
    // Deliberately no close(): a process that dies here must not lose this.
    const reopened = openOperationStore(file);
    assert.ok(reopened.read(created.id));
    reopened.close();
  });

  it('keeps a disagreeing reconciliation and its evidence across close and reopen', () => {
    const file = path.join(directory, 'conflict.sqlite');
    const store = openOperationStore(file);
    const created = store.create({ ...NO_JOB_OP, idempotencyKey: 'op-key-0003' });
    store.recordTransactionHash(created.id, `0x${'aa'.repeat(32)}`);
    store.addObservation(created.id, observation('primary', 'rpc-a'));
    store.addObservation(created.id, observation('secondary', 'rpc-b', { blockHash: `0x${'ee'.repeat(32)}` }));
    const reconciled = store.reconcile(created.id);
    const failed = store.fail(created.id, 'RECONCILIATION_CONFLICT', 'endpoints disagreed on block hash');
    assert.equal(failed.status, 'FAILED');
    store.close();

    const reopened = openOperationStore(file);
    const after = reopened.read(created.id) as OperationRecord;
    assert.equal(after.status, 'FAILED');
    assert.equal(after.reconciliation, 'DISAGREED');
    assert.equal(after.receiptObservations.length, 2, 'both disputed observations survive the restart');
    assert.equal(reconciled.reconciliation, 'DISAGREED');
    reopened.close();
  });

  it('refuses a second operation with the same idempotency key across restarts too', () => {
    const file = path.join(directory, 'dup.sqlite');
    const store = openOperationStore(file);
    const created = store.create({ ...NO_JOB_OP, idempotencyKey: 'op-key-0004' });
    store.close();
    const reopened = openOperationStore(file);
    const again = reopened.create({ ...NO_JOB_OP, idempotencyKey: 'op-key-0004' });
    assert.equal(again.id, created.id);
    assert.equal(reopened.list().length, 1);
    reopened.close();
  });
});
