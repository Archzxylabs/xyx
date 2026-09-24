/**
 * Provider runner stage-5 recovery: `settle()`.
 *
 * `settle()` is the path an interrupted run takes after the `submitDelivery`
 * broadcast already happened. It must never broadcast anything, so it is given
 * a hash and proves that hash against canonical evidence — the finalized
 * two-RPC receipt, the protocol's own `DeliverySubmitted` event, the job ID, the
 * provider address, the commitment, AND the job's on-chain storage at the block
 * where that receipt landed.
 *
 * The tests here pin the cases where a hash alone is not enough: a receipt from
 * an unrelated job, a receipt that proves a different commitment, a job whose
 * storage does not reflect the log, and an `observedTransactionHash` the caller
 * hands over that points at a receipt with no `DeliverySubmitted` at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex } from 'viem';
import { encodeAbiParameters, encodeEventTopics } from 'viem';

import { ProviderRunner, RunnerError } from '../src/provider-runner/runner.js';
import { transferLog } from './fixtures/provider-runner/erc20.js';
import type { JobData, JobStatus } from '../src/protocol.js';

const PROTOCOL = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';
const VERIFIER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const PROVIDER = '0x5555555555555555555555555555555555555555';
const BUYER = '0x6666666666666666666666666666666666666666';
const ATTESTOR = '0x7777777777777777777777777777777777777777';
const JOB_ID = 7n;
const SALT = `0x${'ab'.repeat(32)}`;
const SUBMIT_HASH = `0x${'88'.repeat(32)}`;
const TRANSFER_HASH = `0x${'99'.repeat(32)}`;
const ZERO_HASH = `0x${'00'.repeat(32)}`;

/** CANONICAL_JOB_STATUS.Submitted */
const SUBMITTED = 3 as JobStatus;

/** A plausible 32-byte commitment. */
const COMMITMENT = `0x${'77'.repeat(32)}`;

function submissionReceiptViaTopics(
  jobId: bigint,
  provider: string,
  commitment: Hex
): readonly { address: string; data: Hex; topics: [Hex, ...Hex[]] }[] {
  const [topic0, topic1, topic2] = encodeEventTopics({
    abi: [
      {
        type: 'event',
        name: 'DeliverySubmitted',
        inputs: [
          { name: 'jobId', type: 'uint256', indexed: true },
          { name: 'provider', type: 'address', indexed: true },
          { name: 'deliveryCommitment', type: 'bytes32', indexed: false },
        ],
      },
    ],
    eventName: 'DeliverySubmitted',
    args: { jobId, provider, deliveryCommitment: commitment },
  });
  // Non-indexed data: abi.encode(bytes32).
  const data = encodeAbiParameters([{ type: 'bytes32' }], [commitment]);
  return [{ address: PROTOCOL, data, topics: [topic0!, topic1!, topic2!] }];
}

function submitJob(overrides: Partial<JobData> = {}): JobData {
  return {
    buyer: BUYER,
    provider: PROVIDER,
    attestor: ATTESTOR,
    termsCommitment: `0x${'11'.repeat(32)}`,
    deliveryCommitment: COMMITMENT,
    budget: 1000n,
    expiresAt: 0n,
    status: SUBMITTED,
    ...overrides,
  };
}

interface SubmissionOptions {
  readonly eventJobId?: bigint;
  readonly eventProvider?: string;
  readonly eventCommitment?: Hex;
  readonly jobStatus?: JobStatus;
  readonly storageStatus?: JobStatus;
  readonly jobDeliveryCommitment?: Hex;
  readonly hasLog?: boolean;
}

function readerWithSubmission(options: SubmissionOptions = {}) {
  const {
    eventJobId = JOB_ID,
    eventProvider = PROVIDER,
    eventCommitment = COMMITMENT,
    jobStatus = SUBMITTED,
    storageStatus = SUBMITTED,
    jobDeliveryCommitment = COMMITMENT,
    hasLog = true,
  } = options;
  const logs = hasLog ? submissionReceiptViaTopics(eventJobId, eventProvider, eventCommitment) : [];
  return {
    getChainId: async () => 10143,
    getBlock: async () => ({ number: 600n, hash: `0x${'22'.repeat(32)}`, timestamp: 1_700_000_000n }),
    getTransaction: async () => ({
      hash: SUBMIT_HASH,
      from: PROVIDER,
      to: PROTOCOL,
      input: '0x',
      blockNumber: 600n,
      blockHash: `0x${'22'.repeat(32)}`,
    }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash === TRANSFER_HASH) {
        // The task transfer receipt for the job that was already performed.
        return {
          transactionHash: hash,
          blockNumber: 600n,
          blockHash: `0x${'22'.repeat(32)}`,
          status: 'success' as const,
          to: TOKEN,
          logs: [transferLog(TOKEN, PROVIDER, BUYER, 25_000_000n)],
        };
      }
      return {
        transactionHash: hash,
        blockNumber: 600n,
        blockHash: `0x${'22'.repeat(32)}`,
        status: 'success' as const,
        to: PROTOCOL,
        logs: [...logs],
      };
    },
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      if (functionName !== 'getJob') throw new Error(`unexpected read: ${functionName}`);
      if (blockNumber === undefined) {
        // The tip-of-chain read in settle(): the job's current state.
        return submitJob({ status: jobStatus, deliveryCommitment: jobDeliveryCommitment });
      }
      // The historical read at the mined block: what storage said when it landed.
      return submitJob({ status: hasLog ? storageStatus : jobStatus, deliveryCommitment: eventCommitment });
    },
  };
}

const preparedDelivery = (commitment: Hex = COMMITMENT) => ({
  delivery: { schema: 'xyx.delivery', kind: 'analysis', content: { transferTx: TRANSFER_HASH } },
  commitment,
  transfer: {
    transactionHash: TRANSFER_HASH,
    blockNumber: 600n,
    blockHash: `0x${'22'.repeat(32)}`,
    timestamp: 1_700_000_000n,
    token: TOKEN,
    sender: PROVIDER,
    recipient: BUYER,
    amountAtomic: 25_000_000n,
  },
  request: { abi: [], address: PROTOCOL, functionName: 'submitDelivery', args: [JOB_ID, commitment], from: PROVIDER },
  observation: { number: 600n, hash: `0x${'22'.repeat(32)}`, timestamp: 1_700_000_000n },
  job: submitJob({ status: 2 as JobStatus, deliveryCommitment: ZERO_HASH }),
});

function runnerFor(options: SubmissionOptions = {}) {
  const reader = readerWithSubmission(options);
  return new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    paymentToken: TOKEN,
    primary: reader,
    secondary: reader,
    transfer: { requirement: { token: TOKEN, recipient: BUYER, amountAtomic: 25_000_000n } },
  } as never);
}

test('settle() proofs a broadcast against canonical two-RPC evidence', async () => {
  const runner = runnerFor();
  const { evidence } = await runner.settle(
    preparedDelivery(),
    SUBMIT_HASH
  );

  assert.equal(evidence.status, 'FINALIZED');
  assert.ok(evidence.submission);
  assert.equal(evidence.submission!.transactionHash, SUBMIT_HASH);
  assert.equal(evidence.submission!.blockNumber, 600n);
  assert.equal(evidence.submission!.deliveryCommitment, COMMITMENT);
  // The block the receipt landed in is the same one the state read used.
  assert.equal(evidence.submission!.observation.number, 600n);
  assert.equal(evidence.job?.deliveryCommitment, COMMITMENT);
});

test('settle() refuses a receipt proving a different job', async () => {
  const runner = runnerFor({ eventJobId: 8n, hasLog: true });
  await assert.rejects(
    () => runner.settle(preparedDelivery(), SUBMIT_HASH),
    (error: unknown) => error instanceof RunnerError && error.code === 'RECEIPT_COMMITMENT_MISMATCH'
  );
});

test('settle() refuses a receipt proving a different commitment', async () => {
  const runner = runnerFor({ eventCommitment: `0x${'66'.repeat(32)}` });
  await assert.rejects(
    () => runner.settle(preparedDelivery(), SUBMIT_HASH),
    (error: unknown) => error instanceof RunnerError && error.code === 'RECEIPT_COMMITMENT_MISMATCH'
  );
});

test('settle() refuses a receipt sent by a provider that is not the job provider', async () => {
  const runner = runnerFor({ eventProvider: '0x9999999999999999999999999999999999999999' });
  await assert.rejects(
    () => runner.settle(preparedDelivery(), SUBMIT_HASH),
    (error: unknown) => error instanceof RunnerError && error.code === 'RECEIPT_COMMITMENT_MISMATCH'
  );
});

test('settle() refuses a receipt with no DeliverySubmitted event at all', async () => {
  const runner = runnerFor({ hasLog: false });
  await assert.rejects(
    () => runner.settle(preparedDelivery(), SUBMIT_HASH),
    (error: unknown) => error instanceof RunnerError && error.code === 'RECEIPT_MISSING_EVENT'
  );
});

test('settle() refuses when the job storage does not reflect the submitted log', async () => {
  // The receipt carries a genuine DeliverySubmitted event, so the tip read and
  // every event check pass — but reading storage at the mined block returns a
  // job that is still Funded. The log is not in state, so it is not proof.
  const runner = runnerFor({ storageStatus: 2 as JobStatus });
  await assert.rejects(
    () => runner.settle(preparedDelivery(), SUBMIT_HASH),
    (error: unknown) => error instanceof RunnerError && error.code === 'RECEIPT_MISSING_EVENT'
  );
});

test('settle() refuses when the on-chain job commitment disagrees with the prepared one', async () => {
  // The receipt carries the prepared commitment, but the job's current storage
  // reports a different one, so the broadcast and the state are in conflict.
  const runner = runnerFor({ jobDeliveryCommitment: `0x${'44'.repeat(32)}` });
  await assert.rejects(
    () => runner.settle(preparedDelivery(), SUBMIT_HASH),
    (error: unknown) => error instanceof RunnerError && error.code === 'RECEIPT_COMMITMENT_MISMATCH'
  );
});

test('settle() refuses to settle a hash for a job that is not submitted at the tip', async () => {
  const runner = runnerFor({ jobStatus: 7 as JobStatus }); // Cancelled
  await assert.rejects(
    () => runner.settle(preparedDelivery(), SUBMIT_HASH),
    (error: unknown) => error instanceof RunnerError && error.code === 'JOB_ALREADY_SUBMITTED'
  );
});

test('settle() refuses a non-32-byte hash', async () => {
  const runner = runnerFor();
  await assert.rejects(
    () => runner.settle(preparedDelivery(), '0x1234' as Hex),
    (error: unknown) => error instanceof RunnerError && error.code === 'SUBMISSION_NOT_OBSERVED'
  );
});
