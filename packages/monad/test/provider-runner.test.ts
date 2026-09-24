/**
 * Provider runner invariants.
 *
 * The runner is the component most likely to be trusted by a UI, so these tests
 * pin the things that keep its claims honest rather than merely green:
 *
 *   - A status only advances on evidence that was re-read from a finalized,
 *     two-RPC-agreed block. A broadcast hash is never treated as proof.
 *   - An ambiguous send (no hash) ends ambiguous. It never becomes FINALIZED, so
 *     no caller can read "no error" as "delivered".
 *   - The runner never performs the task transfer itself. With no observed hash
 *     and no execute hook, stage 3 fails closed instead of silently submitting a
 *     delivery that never did the work.
 *   - A receipt is verified against the canonical event, the provider, the job,
 *     AND the job's on-chain storage — a log whose effect is not in state fails.
 *
 * Everything here uses a fake in-memory reader, so no RPC is touched and no key
 * exists anywhere in this file.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';

import { ProviderRunner, RunnerError } from '../src/provider-runner/runner.js';
import type { JobData, JobStatus } from '../src/protocol.js';
import { transferLog, type TransferLogFixture } from './fixtures/provider-runner/erc20.js';

const PROTOCOL = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';
const VERIFIER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const PROVIDER = '0x5555555555555555555555555555555555555555';
const BUYER = '0x6666666666666666666666666666666666666666';
const ATTESTOR = '0x7777777777777777777777777777777777777777';
const JOB_ID = 7n;

const SALT = `0x${'ab'.repeat(32)}`;

const fundedJob = (): JobData => ({
  buyer: BUYER,
  provider: PROVIDER,
  attestor: ATTESTOR,
  termsCommitment: `0x${'11'.repeat(32)}`,
  deliveryCommitment: `0x${'00'.repeat(32)}`,
  budget: 1000n,
  expiresAt: 0n,
  status: 2 as JobStatus, // CANONICAL_JOB_STATUS.Funded
});

const BASE_CONFIG = {
  addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER } as const,
  jobId: JOB_ID,
  privateInput: {
    provide: async () => ({
      schema: 'xyx.delivery',
      kind: 'analysis',
      content: { payload: { note: 'final' } },
      salt: SALT as Hex,
    }),
  },
  executor: {
    execute: async () => ({ ok: true as const, delivery: { note: 'work done', score: 9 } }),
  },
};

/**
 * A fake dual-RPC reader. `readContract` returns the funded job at selection
 * time and `jobState` at verification time, so a test can model the job
 * changing between what was prepared and what the chain later proved.
 */
function reader(overrides: Record<string, unknown> = {}) {
  return {
    getChainId: async () => 10143,
    getBlock: async () => ({ number: 600n, hash: `0x${'22'.repeat(32)}`, timestamp: 1_700_000_000n }),
    getTransaction: async () => ({
      hash: `0x${'33'.repeat(32)}`,
      from: PROVIDER,
      to: PROTOCOL,
      input: '0x',
      blockNumber: 600n,
      blockHash: `0x${'22'.repeat(32)}`,
    }),
    getTransactionReceipt: async () => ({
      transactionHash: `0x${'33'.repeat(32)}`,
      blockNumber: 600n,
      blockHash: `0x${'22'.repeat(32)}`,
      status: 'success' as const,
      to: PROTOCOL,
      logs: [],
    }),
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      if (functionName !== 'getJob') throw new Error(`unexpected read: ${functionName}`);
      if (blockNumber === undefined) return cloneJob();
      return jobState;
    },
    ...overrides,
  };
}

function cloneJob(): JobData {
  return { ...fundedJob() };
}

/** What the chain reports once a delivery has landed. Defaults to submitted. */
let jobState: JobData = cloneJob();

/**
 * A settled ERC-20 transfer with a caller-chosen sender, recipient and token.
 *
 * Uses the shared ABI-correct fixture so the decode path is identical to a live
 * RPC's; see `fixtures/provider-runner/erc20.ts` for why hand-rolled topics or
 * `encodeFunctionData` as event data produce a misleading `TRANSFER_NOT_OBSERVED`.
 */
function transferReceiptFrom(
  hash: string,
  sender: string,
  recipient: string,
  token: string = TOKEN
) {
  return {
    transactionHash: hash,
    blockNumber: 600n,
    blockHash: `0x${'22'.repeat(32)}`,
    status: 'success' as const,
    to: token,
    logs: [transferLog(token as Address, sender as Address, recipient as Address, 25_000_000n)],
  };
}

/** A settled receipt carrying the given Transfer logs, with a caller-set status. */
function receiptWithTransfer(
  hash: string,
  ...transferLogs: readonly TransferLogFixture[]
) {
  return {
    transactionHash: hash,
    blockNumber: 600n,
    blockHash: `0x${'22'.repeat(32)}`,
    status: 'success' as const,
    to: TOKEN,
    logs: transferLogs.map(log => ({ ...log })),
  };
}

const taskRequirement = () => ({
  token: TOKEN,
  recipient: BUYER,
  amountAtomic: 25_000_000n,
});

test('prepare() computes a commitment and request without a signer', async () => {
  jobState = cloneJob();
  const transferHash = `0x${'44'.repeat(32)}`;
  const runReader = () =>
    reader({ getTransactionReceipt: async () => transferReceiptFrom(transferHash, PROVIDER, BUYER) });

  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: runReader(),
    secondary: runReader(),
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => transferHash },
  } as never);

  const { prepared, evidence } = await runner.prepare();
  assert.equal(evidence.status, 'TRANSFERRED');
  assert.equal(evidence.deliveryCommitment, prepared.commitment);
  assert.equal(prepared.request.functionName, 'submitDelivery');
  assert.equal(prepared.request.from, PROVIDER);
  // The verified transfer hash is written into the committed payload by the
  // runner itself, so the commitment can never disagree with the receipt.
  assert.equal(prepared.delivery.content.transferTx, prepared.transfer.transactionHash);
  assert.equal(prepared.transfer.sender, PROVIDER);
  assert.equal(prepared.transfer.blockNumber, 600n);
});

test('prepare() refuses to run when the task transfer was never performed and cannot be', async () => {
  jobState = cloneJob();
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: reader(),
    secondary: reader(),
    paymentToken: TOKEN,
    // No observed hash, no execute hook: nothing proves the work happened.
    transfer: { requirement: taskRequirement() },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === 'TRANSFER_PLAN_REQUIRED' &&
      /task transfer/.test(error.message)
  );
});

test('a job that already carries a delivery cannot be submitted twice', async () => {
  const job = fundedJob();
  job.deliveryCommitment = `0x${'55'.repeat(32)}`;
  jobState = job;
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: reader(),
    secondary: reader(),
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement() },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) => error instanceof RunnerError && error.code === 'JOB_ALREADY_SUBMITTED'
  );
});

test('run() reports a hashless send as ambiguous, never finalized', async () => {
  jobState = cloneJob();
  const transferHash = `0x${'44'.repeat(32)}`;
  const primary = reader({
    getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
      hash === transferHash
        ? transferReceiptFrom(transferHash, PROVIDER, BUYER)
        : { transactionHash: hash, blockNumber: 600n, blockHash: `0x${'22'.repeat(32)}`, status: 'success', to: PROTOCOL, logs: [] },
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary,
    secondary: primary,
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => transferHash },
    signer: {
      address: PROVIDER,
      sendTransaction: async () => ({ kind: 'ambiguous' as const }),
    },
  } as never);

  const { evidence } = await runner.run();
  assert.equal(evidence.status, 'SUBMITTED_AMBIGUOUS');
  assert.notEqual(evidence.status, 'FINALIZED');
  assert.equal(evidence.failure?.code, 'SUBMISSION_NOT_OBSERVED');
  // A hashless send must not be reported as delivered, and must not be retried.
  assert.ok(!evidence.submission);
});

test('run() refuses to simulate a send when no signer is injected', async () => {
  jobState = cloneJob();
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: reader(),
    secondary: reader(),
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => `0x${'44'.repeat(32)}` },
  } as never);

  await assert.rejects(
    () => runner.run(),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === 'SIGNER_REQUIRED' &&
      /no signer was injected/.test(error.message)
  );
});

test('a signer that is not the job provider is rejected before any send', async () => {
  jobState = cloneJob();
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: reader(),
    secondary: reader(),
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => `0x${'44'.repeat(32)}` },
    signer: { address: BUYER, sendTransaction: async () => ({ kind: 'submitted', transactionHash: `0x${'9'.repeat(64)}` }) },
  } as never);

  await assert.rejects(
    () => runner.run(),
    (error: unknown) => error instanceof RunnerError && error.code === 'SIGNER_NOT_PROVIDER'
  );
});

test('a task transfer sent by someone other than the provider fails closed', async () => {
  jobState = cloneJob();
  const hash = `0x${'46'.repeat(32)}`;
  // The amount, token and recipient are all right, but an unrelated wallet paid.
  const straySender = '0x9999999999999999999999999999999999999999';
  const wrongSenderReader = reader({
    getTransactionReceipt: async () => transferReceiptFrom(hash, straySender, BUYER),
  });

  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: wrongSenderReader,
    secondary: wrongSenderReader,
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => hash },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === 'TRANSFER_MISMATCH' &&
      error.message.includes(straySender)
  );
});

test('a task transfer in the wrong token fails closed', async () => {
  jobState = cloneJob();
  const otherToken = '0x9999999999999999999999999999999999999999';
  const hash = `0x${'47'.repeat(32)}`;
  // Provider, recipient and amount are all right, but the token that moved is
  // not the protocol payment token, so the receipt proves nothing about the
  // terms. This must not be mistaken for "the work was done".
  const wrongTokenReader = reader({
    getTransactionReceipt: async ({ hash: observed }: { hash: Hex }) =>
      observed === hash
        ? transferReceiptFrom(hash, PROVIDER, BUYER, otherToken)
        : { transactionHash: observed, blockNumber: 600n, blockHash: `0x${'22'.repeat(32)}`, status: 'success' as const, to: PROTOCOL, logs: [] },
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: wrongTokenReader,
    secondary: wrongTokenReader,
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => hash },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === 'TRANSFER_TOKEN_MISMATCH' &&
      error.message.includes(otherToken)
  );
});

test('a task transfer paying the wrong recipient fails closed', async () => {
  jobState = cloneJob();
  const hash = `0x${'48'.repeat(32)}`;
  const stranger = '0x9999999999999999999999999999999999999999';
  // Right token, right amount, right sender — but paid to someone else.
  const wrongRecipientReader = reader({
    getTransactionReceipt: async ({ hash: observed }: { hash: Hex }) =>
      observed === hash
        ? transferReceiptFrom(hash, PROVIDER, stranger)
        : { transactionHash: observed, blockNumber: 600n, blockHash: `0x${'22'.repeat(32)}`, status: 'success' as const, to: PROTOCOL, logs: [] },
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: wrongRecipientReader,
    secondary: wrongRecipientReader,
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => hash },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) =>
      error instanceof RunnerError &&
      // Right amount to the wrong recipient is a TERMS violation, not an
      // absence: the money moved and must not be mistaken for "no evidence".
      error.code === 'TRANSFER_MISMATCH' &&
      error.message.includes(stranger)
  );
});

test('a task transfer of the wrong amount fails closed', async () => {
  jobState = cloneJob();
  const hash = `0x${'49'.repeat(32)}`;
  // Right token, right recipient, right sender, one wei short.
  const shortReader = reader({
    getTransactionReceipt: async ({ hash: observed }: { hash: Hex }) =>
      observed === hash
        ? receiptWithTransfer(hash, transferLog(TOKEN, PROVIDER, BUYER, 24_999_999n))
        : { transactionHash: observed, blockNumber: 600n, blockHash: `0x${'22'.repeat(32)}`, status: 'success' as const, to: PROTOCOL, logs: [] },
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: shortReader,
    secondary: shortReader,
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => hash },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === 'TRANSFER_NOT_OBSERVED' &&
      error.message.includes('24999999')
  );
});

test('two qualifying task transfers are ambiguous and fail closed', async () => {
  jobState = cloneJob();
  const hash = `0x${'4a'.repeat(32)}`;
  // The same terms satisfied twice in one receipt, so the receipt cannot tell
  // which payment the job was for. Ambiguity must not resolve into success.
  const duplicateReader = reader({
    getTransactionReceipt: async ({ hash: observed }: { hash: Hex }) =>
      observed === hash
        ? receiptWithTransfer(
            hash,
            transferLog(TOKEN, PROVIDER, BUYER, 25_000_000n),
            transferLog(TOKEN, PROVIDER, BUYER, 25_000_000n)
          )
        : { transactionHash: observed, blockNumber: 600n, blockHash: `0x${'22'.repeat(32)}`, status: 'success' as const, to: PROTOCOL, logs: [] },
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: duplicateReader,
    secondary: duplicateReader,
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => hash },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) =>
      error instanceof RunnerError && error.code === 'TRANSFER_MISMATCH' && /ambiguous|2 qualifying/.test(error.message)
  );
});

test('a reverted task transfer fails closed', async () => {
  jobState = cloneJob();
  const hash = `0x${'4b'.repeat(32)}`;
  // A finalized receipt whose status is failure: the transfer never happened
  // even though the transaction is on chain.
  const revertedReader = reader({
    getTransactionReceipt: async ({ hash: observed }: { hash: Hex }) =>
      observed === hash
        ? {
            transactionHash: hash,
            blockNumber: 600n,
            blockHash: `0x${'22'.repeat(32)}`,
            status: 'reverted' as const,
            to: TOKEN,
            logs: [transferLog(TOKEN, PROVIDER, BUYER, 25_000_000n)],
          }
        : { transactionHash: observed, blockNumber: 600n, blockHash: `0x${'22'.repeat(32)}`, status: 'success' as const, to: PROTOCOL, logs: [] },
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: revertedReader,
    secondary: revertedReader,
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => hash },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) => error instanceof RunnerError && error.code === 'TRANSFER_NOT_FINALIZED'
  );
});

test('a transfer receipt the two readers disagree about fails closed', async () => {
  jobState = cloneJob();
  const hash = `0x${'4c'.repeat(32)}`;
  const honest = reader({
    getTransactionReceipt: async ({ hash: observed }: { hash: Hex }) =>
      observed === hash
        ? transferReceiptFrom(hash, PROVIDER, BUYER)
        : { transactionHash: observed, blockNumber: 600n, blockHash: `0x${'22'.repeat(32)}`, status: 'success' as const, to: PROTOCOL, logs: [] },
  });
  // The second reader reports a different block for the same hash, so the two
  // readers do not agree on where this transfer landed.
  const deceptive = reader({
    getTransactionReceipt: async ({ hash: observed }: { hash: Hex }) =>
      observed === hash
        ? { ...transferReceiptFrom(hash, PROVIDER, BUYER), blockHash: `0x${'aa'.repeat(32)}` }
        : { transactionHash: observed, blockNumber: 600n, blockHash: `0x${'22'.repeat(32)}`, status: 'success' as const, to: PROTOCOL, logs: [] },
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: honest,
    secondary: deceptive,
    paymentToken: TOKEN,
    transfer: { requirement: taskRequirement(), execute: async () => hash },
  } as never);

  await assert.rejects(
    () => runner.prepare(),
    (error: unknown) =>
      error instanceof RunnerError &&
      (error.code === 'TRANSFER_RPC_CONFLICT' || error.code === 'TRANSFER_NOT_FINALIZED')
  );
});

test('the constructor refuses a payment token that is not an address', () => {
  assert.throws(
    () => new ProviderRunner({
      ...BASE_CONFIG,
      primary: reader(),
      secondary: reader(),
      paymentToken: 'not-an-address',
      transfer: { requirement: taskRequirement() },
    } as never),
    (error: unknown) => error instanceof RunnerError && error.code === 'TRANSFER_MISMATCH'
  );
});

test('an incompatible chainId is refused before anything runs', () => {
  assert.throws(
    () => new ProviderRunner({
      ...BASE_CONFIG,
      primary: reader(),
      secondary: reader(),
      paymentToken: TOKEN,
      transfer: { requirement: taskRequirement() },
      chainId: 1,
    } as never),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === 'CHAIN_GUARD_FAILED' &&
      /10143/.test(error.message)
  );
});
