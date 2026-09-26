/**
 * Dual-reader evidence guards.
 *
 * The runner's central security claim is that FINALIZED rests on TWO
 * independent RPC readers agreeing. A runner that quietly consulted only one
 * would still look and behave correctly while making that claim false, so these
 * tests pin the actual observable consequence: a reader that disagrees with its
 * peer must never be able to carry a run to success.
 *
 * `matchedCanonicalJob` and `matchedFinalizedReceipt` from canonical-chain.ts
 * already enforce agreement; what is tested here is that the runner actually
 * USES dual readers on every path that feeds a public result, since that local
 * wiring is what a future refactor would break.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';

import { ProviderRunner, RunnerError } from '../src/provider-runner/runner.js';
import { transferLog } from './fixtures/provider-runner/erc20.js';

const PROTOCOL = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';
const VERIFIER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const PROVIDER = '0x5555555555555555555555555555555555555555';
const BUYER = '0x6666666666666666666666666666666666666666';
const ATTESTOR = '0x7777777777777777777777777777777777777777';

const SALT = `0x${'cd'.repeat(32)}`;
const JOB_ID = 11n;
const BLOCK_HASH = `0x${'22'.repeat(32)}`;
const BLOCK_NUMBER = 600n;
const TRANSFER_AMOUNT = 25_000_000n;

const fundedJob = () => ({
  buyer: BUYER,
  provider: PROVIDER,
  attestor: ATTESTOR,
  termsCommitment: `0x${'11'.repeat(32)}`,
  deliveryCommitment: `0x${'00'.repeat(32)}`,
  budget: 1000n,
  expiresAt: 0n,
  status: 2 as const,
});

const BASE_CONFIG = {
  addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER } as const,
  jobId: JOB_ID,
  privateInput: {
    provide: async () => ({
      schema: 'xyx.delivery',
      kind: 'analysis',
      content: { result: 'clean' },
      salt: SALT as Hex,
    }),
  },
  executor: { execute: async () => ({ ok: true as const, delivery: { score: 1 } }) },
};

const requirement = {
  token: TOKEN as Address,
  recipient: BUYER as Address,
  amountAtomic: TRANSFER_AMOUNT,
};

/** A settled receipt carrying a valid required transfer. */
function goodTransferReceipt(hash: string) {
  return {
    transactionHash: hash,
    blockNumber: BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    status: 'success' as const,
    to: TOKEN,
    logs: [transferLog(TOKEN, PROVIDER, BUYER, TRANSFER_AMOUNT)],
  };
}

/**
 * Build a reader. Every knob is an override so a test can make this reader
 * disagree with its peer in exactly one way.
 */
function makeReader(overrides: Record<string, unknown> = {}) {
  let receiptHash = `0x${'aa'.repeat(32)}`;
  const reader = {
    getChainId: async () => 10143,
    getBlock: async () => ({ number: BLOCK_NUMBER, hash: BLOCK_HASH, timestamp: 1_700_000_000n }),
    getTransaction: async () => ({ hash: receiptHash, from: PROVIDER, to: PROTOCOL, input: '0x' }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => goodTransferReceipt(hash),
    readContract: async () => fundedJob(),
    // Let a test point the receipt at a hash and vary it later.
    setReceiptHash(hash: string) {
      receiptHash = hash;
    },
    ...overrides,
  };
  return reader;
}

test('the runner refuses to be constructed with one RPC reader', () => {
  const r = makeReader();
  assert.throws(
    () =>
      new ProviderRunner({
        ...BASE_CONFIG,
        primary: r,
        // A runner with no secondary cannot observe anything twice.
        secondary: undefined as never,
        paymentToken: TOKEN as Address,
        transfer: { requirement, observedTransactionHash: `0x${'aa'.repeat(32)}` as Hex },
      } as never),
    (error: unknown) => error instanceof RunnerError && error.code === 'CHAIN_GUARD_FAILED'
  );
});

test('a secondary reader that lags the finalized head fails closed in prepare()', async () => {
  const hash = `0x${'11'.repeat(32)}`;
  const honest = makeReader();
  const lagging = makeReader({
    // A reader one block behind: it is not wrong, it is simply less advanced,
    // which must not let it vouch for finality the primary has already declared.
    getBlock: async (args: { blockTag?: 'finalized' }) =>
      args.blockTag === 'finalized'
        ? { number: BLOCK_NUMBER - 1n, hash: `0x${'33'.repeat(32)}`, timestamp: 1_699_999_000n }
        : { number: BLOCK_NUMBER - 1n, hash: `0x${'33'.repeat(32)}`, timestamp: 1_699_999_000n },
  });

  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: honest,
    secondary: lagging,
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: hash as Hex },
  } as never);

  // Either the disagreement is reported as an RPC conflict, or the job simply
  // cannot be read at all. What must never happen is a TRANSFERRED result.
  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      assert.ok(
        error.code === 'JOB_READ_FAILED' || error.code.endsWith('RPC_CONFLICT'),
        `expected a failure caused by the disagreeing reader, got ${error.code}`
      );
      return true;
    }
  );
});

test('a secondary reader on the wrong chain fails closed before anything runs', async () => {
  const hash = `0x${'12'.repeat(32)}`;
  const honest = makeReader();
  const wrongChain = makeReader({
    // Reports a different chain: it cannot corroborate Monad Testnet finality.
    getChainId: async () => 1,
  });

  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: honest,
    secondary: wrongChain,
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: hash as Hex },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) => error instanceof RunnerError && error.code.startsWith('JOB_READ_FAILED')
  );
});

test('an unavailable secondary reader fails closed rather than falling back', async () => {
  const hash = `0x${'13'.repeat(32)}`;
  const honest = makeReader();
  const dead = makeReader({
    // A dead reader must not be treated as agreement. The temptation in a
    // refactor is to catch this and proceed on the primary alone, which is
    // exactly the single-RPC behaviour this test forbids.
    readContract: async () => {
      throw new Error('connection refused');
    },
  });

  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: honest,
    secondary: dead,
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: hash as Hex },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      // The run must not reach TRANSFERRED with one reader having failed.
      assert.ok(
        error.code === 'JOB_READ_FAILED' || error.code.endsWith('RPC_CONFLICT'),
        `an unavailable secondary reader must fail closed, got ${error.code}: ${error.message}`
      );
      return true;
    }
  );
});

test('the finalized head both readers report is attached to the run', async () => {
  const hash = `0x${'14'.repeat(32)}`;
  const r = makeReader();
  r.setReceiptHash(hash);

  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: r,
    secondary: r,
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: hash as Hex },
  } as never);

  const { evidence } = await runner.prepare();
  assert.equal(evidence.status, 'TRANSFERRED');
  // The observation must describe a real finalized block, not a placeholder.
  assert.equal(evidence.observation?.number, BLOCK_NUMBER);
  assert.equal(evidence.observation?.hash, BLOCK_HASH);
  assertCleanOfSecrets(evidence);
});

/** The material from the suite above must not reach public output either. */
function assertCleanOfSecrets(value: unknown): void {
  const text = JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.ok(!text.includes(SALT), 'the delivery salt reached public output');
}

test('a receipt the two readers describe differently fails closed', async () => {
  const hash = `0x${'15'.repeat(32)}`;
  const honest = makeReader();
  const fabricator = makeReader({
    // Same transaction, different logs. `matchedFinalizedReceipt` compares
    // receipts byte-for-byte, so this is the disagreement it exists to catch.
    getTransactionReceipt: async ({ hash: observed }: { hash: Hex }) => ({
      ...goodTransferReceipt(observed),
      logs: [transferLog(TOKEN, PROVIDER, BUYER, 99_999_999)],
    }),
  });

  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: honest,
    secondary: fabricator,
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: hash as Hex },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) =>
      error instanceof RunnerError &&
      (error.code === 'TRANSFER_RPC_CONFLICT' || error.code === 'TRANSFER_NOT_FINALIZED')
  );
});

const HEAD_MARKER = 'PRIMARY-HEAD-ONLY';
const TRANSFER_MARKER = 'SECONDARY-TRANSFER-ONLY';
const RECEIPT_MARKER = 'SECONDARY-RECEIPT-STATUS-ONLY';

/** Error.message, name, code, and cause — not JSON.stringify, which hides them. */
function publicText(value: unknown, out: string[] = [], depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return out.join('\u0000');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    out.push(String(value));
    return out.join('\u0000');
  }
  if (value instanceof Error) {
    out.push(value.name, value.message);
    const coded = value as { code?: unknown; cause?: unknown };
    if (coded.code !== undefined) out.push(String(coded.code));
    if ('cause' in value) publicText((value as { cause?: unknown }).cause, out, depth + 1);
    return out.join('\u0000');
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) publicText(entry, out, depth + 1);
  }
  return out.join('\u0000');
}

test('two readers that disagree on the finalized head fail closed, not pending', async () => {
  // Old behavior: a primary-only finalized head was attached to the run, so a
  // lagging or lying secondary never changed the returned observation.
  const hash = `0x${'21'.repeat(32)}`;
  const primary = makeReader();
  const secondary = makeReader({
    getBlock: async () => ({
      number: BLOCK_NUMBER + 4n,
      hash: `0x${'55'.repeat(32)}`,
      timestamp: 1_700_000_400n,
      label: HEAD_MARKER,
    }),
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary,
    secondary,
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: hash as Hex },
  } as never);

  let thrown: unknown;
  try {
    const outcome = await runner.prepare();
    assert.fail(`disagreement must not return status ${outcome.evidence.status}`);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof RunnerError);
  assert.notEqual(thrown.code, 'RECEIPT_NOT_FINALIZED');
  assert.ok(
    thrown.code === 'JOB_READ_FAILED' || thrown.code === 'RECEIPT_RPC_CONFLICT',
    thrown.code
  );
  const text = publicText(thrown);
  assert.equal(thrown.name, 'RunnerError');
  assert.ok(!text.includes(HEAD_MARKER));
  assert.ok(!text.includes(SALT));
  assert.ok(!/https?:\/\//.test(text));

  // Legitimate control: the same request against two agreeing readers is accepted.
  const honest = makeReader();
  honest.setReceiptHash(hash);
  const peer = makeReader();
  peer.setReceiptHash(hash);
  const agreeing = new ProviderRunner({
    ...BASE_CONFIG,
    primary: honest,
    secondary: peer,
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: hash as Hex },
  } as never);
  const { evidence, prepared } = await agreeing.prepare();
  assert.equal(evidence.status, 'TRANSFERRED');
  assert.equal(evidence.observation?.hash, BLOCK_HASH);
  assert.equal(evidence.observation?.number, BLOCK_NUMBER);
  assert.equal(evidence.transfer?.transactionHash, hash);
  assert.equal(evidence.failure, undefined);
  assert.equal(prepared?.request.functionName, 'submitDelivery');
  assert.ok(!publicText(evidence).includes(HEAD_MARKER));
});

test('two readers that disagree on the transfer fail closed and publish no transfer', async () => {
  // Old behavior: the runner could treat one reader's transfer log as observed
  // and return TRANSFERRED. The secondary receipt is built inline, not via
  // goodTransferReceipt, so it does not share that helper's object graph.
  const hash = `0x${'23'.repeat(32)}`;
  const primary = makeReader();
  primary.setReceiptHash(hash);
  const secondary = makeReader({
    getTransactionReceipt: async ({ hash: observed }: { hash: Hex }) => ({
      transactionHash: observed,
      blockNumber: BLOCK_NUMBER,
      blockHash: `0x${'66'.repeat(32)}`,
      status: 'success' as const,
      to: TOKEN,
      label: TRANSFER_MARKER,
      logs: [transferLog(TOKEN, PROVIDER, BUYER, 1n)],
    }),
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary,
    secondary,
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: hash as Hex },
  } as never);

  let thrown: unknown;
  try {
    await runner.prepare();
    assert.fail('a transfer disagreement must not return evidence');
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof RunnerError);
  assert.equal(thrown.code, 'TRANSFER_RPC_CONFLICT');
  assert.notEqual(thrown.code, 'TRANSFER_NOT_FINALIZED');
  const text = publicText(thrown);
  assert.ok(!text.includes(TRANSFER_MARKER));
  assert.ok(!text.includes(hash), 'the unagreed transfer hash must not be returned as proof');
  assert.ok(!text.includes(SALT));
});

test('two readers that disagree on receipt status are not relabeled pending', async () => {
  // Old behavior: any receipt-read throw became "not usable yet", so a status
  // disagreement was reported like an ordinary pending receipt and the caller
  // was told to wait.
  const submitHash = `0x${'24'.repeat(32)}`;
  const transferHash = `0x${'25'.repeat(32)}`;
  const primary = makeReader({
    getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
      hash === submitHash
        ? {
            transactionHash: hash,
            blockNumber: BLOCK_NUMBER,
            blockHash: BLOCK_HASH,
            status: 'success' as const,
            to: PROTOCOL,
            logs: [],
          }
        : goodTransferReceipt(hash),
  });
  const secondary = makeReader({
    getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
      hash === submitHash
        ? {
            transactionHash: hash,
            blockNumber: BLOCK_NUMBER,
            blockHash: BLOCK_HASH,
            status: 'reverted' as const,
            to: PROTOCOL,
            label: RECEIPT_MARKER,
            logs: [],
          }
        : {
            transactionHash: hash,
            blockNumber: BLOCK_NUMBER,
            blockHash: BLOCK_HASH,
            status: 'success' as const,
            to: TOKEN,
            logs: [transferLog(TOKEN, PROVIDER, BUYER, TRANSFER_AMOUNT)],
          },
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary,
    secondary,
    paymentToken: TOKEN as Address,
    transfer: { requirement, execute: async () => transferHash as Hex },
    signer: {
      address: PROVIDER as Address,
      sendTransaction: async () => ({ kind: 'submitted' as const, transactionHash: submitHash as Hex }),
    },
  } as never);

  let thrown: unknown;
  let returned: { evidence: { status: string; transactionHash?: string; submission?: unknown; failure?: { code: string } } } | undefined;
  try {
    returned = await runner.run();
  } catch (error) {
    thrown = error;
  }
  if (returned) {
    assert.notEqual(returned.evidence.status, 'FINALIZED');
    assert.notEqual(returned.evidence.status, 'SUBMITTED');
    assert.equal(returned.evidence.submission, undefined);
    assert.notEqual(returned.evidence.failure?.code, 'RECEIPT_NOT_FINALIZED');
    assert.ok(!publicText(returned).includes(RECEIPT_MARKER));
  } else {
    assert.ok(thrown instanceof RunnerError);
    assert.equal(thrown.code, 'RECEIPT_RPC_CONFLICT');
    assert.notEqual(thrown.code, 'RECEIPT_NOT_FINALIZED');
    assert.ok(!publicText(thrown).includes(RECEIPT_MARKER));
    assert.ok(!publicText(thrown).includes(submitHash));
  }

  // Legitimate control: both readers report the same not-yet-final receipt, and
  // that ordinary pending case still returns the hash without claiming finality.
  const pendingBlock = BLOCK_NUMBER + 1n;
  const pendingHash = `0x${'77'.repeat(32)}`;
  const pending = makeReader({
    getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
      hash === submitHash
        ? {
            transactionHash: hash,
            blockNumber: pendingBlock,
            blockHash: pendingHash,
            status: 'success' as const,
            to: PROTOCOL,
            logs: [],
          }
        : goodTransferReceipt(hash),
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) =>
      args.blockNumber === pendingBlock
        ? { number: pendingBlock, hash: pendingHash, timestamp: 1_700_000_020n }
        : { number: BLOCK_NUMBER, hash: BLOCK_HASH, timestamp: 1_700_000_000n },
  });
  const control = new ProviderRunner({
    ...BASE_CONFIG,
    primary: pending,
    secondary: pending,
    paymentToken: TOKEN as Address,
    transfer: { requirement, execute: async () => transferHash as Hex },
    signer: {
      address: PROVIDER as Address,
      sendTransaction: async () => ({ kind: 'submitted' as const, transactionHash: submitHash as Hex }),
    },
  } as never);
  const { evidence, prepared } = await control.run();
  assert.equal(evidence.status, 'SUBMITTED');
  assert.equal(evidence.transactionHash, submitHash);
  assert.equal(evidence.submission, undefined);
  assert.equal(evidence.failure?.code, 'RECEIPT_NOT_FINALIZED');
  assert.equal(prepared?.request.functionName, 'submitDelivery');
  assert.ok(prepared?.commitment);
});

test('a broadcast hash whose receipt is not yet final still comes back with the hash', async () => {
  // The transfer is settled and the job is ready, and the signer returns a real
  // submission hash — but that receipt has not been finalized yet. This is the
  // ordinary state of a run whose client polled early or that was interrupted.
  //
  // The hash is the only means of reconciling that submission, so it must
  // survive into the returned evidence. Throwing here would discard it and leave
  // a resend of a transaction that may already be in the mempool as the only
  // recovery path, which buys a double submission.
  //
  // Local fixtures only: no live Monad Testnet node is contacted by this test.
  const submitHash = `0x${'16'.repeat(32)}`;
  // The receipt sits one block AHEAD of the finalized head — the node has it in
  // its latest block while finality still lags, which is the normal state right
  // after a broadcast. This is what "not yet finalized" actually looks like to
  // a reader, and it must not be reported as any kind of success.
  const PENDING_BLOCK = BLOCK_NUMBER + 1n;
  const PENDING_HASH = `0x${'44'.repeat(32)}`;
  const pending = makeReader({
    // The submission receipt exists but sits one block below the finalized
    // head, so `finalizedReceipt` must reject it as not-yet-final. Both readers
    // report it identically: the shortfall is finality, not disagreement.
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash !== submitHash) return goodTransferReceipt(hash);
      return {
        ...goodTransferReceipt(submitHash),
        // A pending submission: the transaction is in, but its DeliverySubmitted
        // log has not been finalized. Both readers report it identically, so
        // the shortfall is finality alone, not disagreement.
        to: PROTOCOL,
        blockNumber: PENDING_BLOCK,
        blockHash: PENDING_HASH,
      };
    },
    // The finalized head is BEHIND the pending receipt, so the receipt fails
    // the finality check. The block the receipt claims must still replay
    // correctly, otherwise the failure would come out as a block mismatch
    // rather than the finality shortfall this test is about.
    getBlock: async (args: { blockTag?: 'finalized'; blockNumber?: bigint }) =>
      args.blockTag === 'finalized'
        ? { number: BLOCK_NUMBER, hash: BLOCK_HASH, timestamp: 1_700_000_000n }
        : args.blockNumber === PENDING_BLOCK
          ? { number: PENDING_BLOCK, hash: PENDING_HASH, timestamp: 1_700_000_012n }
          : { number: BLOCK_NUMBER, hash: BLOCK_HASH, timestamp: 1_700_000_000n },
  });

  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: pending,
    secondary: pending,
    paymentToken: TOKEN as Address,
    transfer: { requirement, execute: async () => `0x${'14'.repeat(32)}` as Hex },
    signer: {
      address: PROVIDER as Address,
      sendTransaction: async () => ({ kind: 'submitted' as const, transactionHash: submitHash as Hex }),
    },
  } as never);

  const { evidence } = await runner.run();
  // The hash must be carried through whatever the non-final state is reported
  // as, because it is the caller's only handle for reconciling this submission.
  assert.ok(evidence.transactionHash, `the submission hash must survive, got status ${evidence.status}`);
  assert.equal(evidence.transactionHash, submitHash);
  // And finality must never be implied by a receipt that has not finalized.
  assert.notEqual(evidence.status, 'FINALIZED');
  assert.ok(
    evidence.status === 'SUBMITTED' || evidence.status === 'SUBMITTED_AMBIGUOUS' || evidence.status === 'RECONCILING',
    `unexpected status ${evidence.status}`
  );
});
