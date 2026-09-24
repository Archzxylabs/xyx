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
