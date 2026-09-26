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
import type { Address, Hex } from 'viem';
import { encodeAbiParameters, encodeEventTopics, hexToBytes, keccak256, toHex } from 'viem';

import { ProviderRunner, RunnerError } from '../src/provider-runner/runner.js';
import { createDeliveryCommitment } from '../src/delivery.js';
import { canonicalJSON } from '../src/canonical.js';
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

/**
 * The commitment the job carries on chain.
 *
 * This is computed for real from the recovery payload and salt rather than
 * spelled as a placeholder digest, because settle() now proves the payload by
 * recomputing it: the recovery fixture must commit to the payload it hands over,
 * or every test in this file would be refused before it reached the behavior it
 * is checking. The negative tests override it deliberately.
 */
const COMMITMENT = createDeliveryCommitment(
  JOB_ID,
  { schema: 'xyx.delivery', kind: 'analysis', content: { transferTx: TRANSFER_HASH } },
  SALT
).commitment;

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

/**
 * A recovery handle in the only shape settle() now accepts: the commitment, the
 * job, and the transfer locator bound inside the committed payload. No request,
 * because settle() rebuilds the canonical one itself from this runner's
 * configuration and verified chain state — a caller cannot steer verification
 * toward a request the protocol would never have accepted.
 *
 * The `salt` is carried because it is what proves the payload: settle()
 * recomputes the commitment from `delivery` plus this salt and requires the
 * result to equal the commitment the job carries on chain. A fixture whose
 * commitment is a bare placeholder would now be refused, which is exactly the
 * guarantee the negative tests exercise, so this one is computed for real.
 */
const payloadDelivery = (transferTx: Hex) => ({
  schema: 'xyx.delivery',
  kind: 'analysis',
  content: { transferTx },
});

const genuineCommitment = (transferTx: Hex) =>
  createDeliveryCommitment(JOB_ID, payloadDelivery(transferTx), SALT).commitment;

const preparedDelivery = (commitment: Hex = COMMITMENT, transferTx: Hex = TRANSFER_HASH) => ({
  delivery: payloadDelivery(transferTx),
  commitment,
  salt: SALT,
  // What a caller *asserts* about the transfer. settle() must not republish
  // this; it re-derives the reported transfer from both RPCs.
  transfer: {
    transactionHash: transferTx,
    blockNumber: 600n,
    blockHash: `0x${'22'.repeat(32)}`,
    timestamp: 1_700_000_000n,
    token: TOKEN,
    sender: PROVIDER,
    recipient: BUYER,
    amountAtomic: 25_000_000n,
  },
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
  // Local fixtures only. settle() must reconcile the known hash without calling a
  // signer: runner.ts has one sendTransaction call, inside run(), and settle()
  // does not reach it. A spy that increments would mean reconciliation resent.
  let sends = 0;
  const chain = readerWithSubmission();
  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    paymentToken: TOKEN,
    primary: chain,
    secondary: chain,
    transfer: { requirement: { token: TOKEN, recipient: BUYER, amountAtomic: 25_000_000n } },
    signer: {
      address: PROVIDER as Address,
      sendTransaction: async () => {
        sends += 1;
        return { kind: 'submitted' as const, transactionHash: SUBMIT_HASH as Hex };
      },
    },
  } as never);
  const { evidence, prepared } = await runner.settle(
    preparedDelivery(),
    SUBMIT_HASH
  );
  assert.equal(sends, 0, 'settle() must not broadcast again');
  // settle() returns sanitizedRecovery(), a new handle, and puts the rebuilt
  // request on evidence.request. This assertion checks that evidence, not the
  // handle the caller handed in.
  assert.equal(evidence.request?.functionName, 'submitDelivery');
  void prepared;

  assert.equal(evidence.status, 'FINALIZED');
  assert.ok(evidence.submission);
  assert.equal(evidence.submission!.transactionHash, SUBMIT_HASH);
  assert.equal(evidence.submission!.blockNumber, 600n);
  assert.equal(evidence.submission!.deliveryCommitment, COMMITMENT);
  // The block the receipt landed in is the same one the state read used.
  assert.equal(evidence.submission!.observation.number, 600n);
  assert.equal(evidence.job?.deliveryCommitment, COMMITMENT);
  assert.equal(evidence.transfer!.transactionHash, TRANSFER_HASH);
  assert.equal(evidence.request!.address.toLowerCase(), PROTOCOL.toLowerCase());
  assert.equal(evidence.failure, undefined);
});

test('settle() keeps a non-final hash, rejects disagreement, and distinguishes a revert', async () => {
  // Local fixtures. Each receipt below is written inline rather than through
  // readerWithSubmission, so a change to that helper cannot hide a disagreement.
  const ahead = 900n;
  const aheadHash = `0x${'31'.repeat(32)}` as Hex;
  let sends = 0;
  const signer = {
    address: PROVIDER as Address,
    sendTransaction: async () => {
      sends += 1;
      return { kind: 'submitted' as const, transactionHash: SUBMIT_HASH as Hex };
    },
  };

  function chain(receiptForSubmit: (hash: Hex) => Record<string, unknown>) {
    const base = readerWithSubmission();
    return {
      ...base,
      getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) =>
        args.blockNumber === ahead
          ? { number: ahead, hash: aheadHash, timestamp: 1_700_000_900n }
          : { number: 600n, hash: `0x${'22'.repeat(32)}`, timestamp: 1_700_000_000n },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
        hash === SUBMIT_HASH
          ? receiptForSubmit(hash)
          : base.getTransactionReceipt({ hash }),
    };
  }

  const notFinal = chain(() => ({
    transactionHash: SUBMIT_HASH,
    blockNumber: ahead,
    blockHash: aheadHash,
    status: 'success',
    to: PROTOCOL,
    logs: [],
  }));
  const pendingRunner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    paymentToken: TOKEN,
    primary: notFinal,
    secondary: notFinal,
    transfer: { requirement: { token: TOKEN, recipient: BUYER, amountAtomic: 25_000_000n } },
    signer,
  } as never);
  const pending = await pendingRunner.settle(preparedDelivery(), SUBMIT_HASH);
  assert.equal(pending.evidence.status, 'SUBMITTED');
  assert.equal(pending.evidence.transactionHash, SUBMIT_HASH);
  assert.equal(pending.evidence.failure?.code, 'RECEIPT_NOT_FINALIZED');
  assert.equal(pending.evidence.submission, undefined);
  assert.equal(pending.prepared?.commitment, COMMITMENT);
  assert.equal(sends, 0);
  const again = await pendingRunner.settle(preparedDelivery(), SUBMIT_HASH);
  assert.equal(again.evidence.status, 'SUBMITTED');
  assert.equal(again.evidence.transactionHash, SUBMIT_HASH);
  assert.equal(sends, 0, 'a second reconciliation must not broadcast');

  // Disagreement is a different object, not a field flipped on `notFinal`.
  const honest = chain(() => ({
    transactionHash: SUBMIT_HASH,
    blockNumber: 600n,
    blockHash: `0x${'22'.repeat(32)}`,
    status: 'success',
    to: PROTOCOL,
    logs: [],
  }));
  const liar = chain(() => ({
    transactionHash: SUBMIT_HASH,
    blockNumber: 600n,
    blockHash: `0x${'32'.repeat(32)}`,
    status: 'reverted',
    to: PROTOCOL,
    label: 'SECONDARY-RECEIPT-DISAGREES',
    logs: [],
  }));
  const conflictRunner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    paymentToken: TOKEN,
    primary: honest,
    secondary: liar,
    transfer: { requirement: { token: TOKEN, recipient: BUYER, amountAtomic: 25_000_000n } },
    signer,
  } as never);
  await assert.rejects(
    () => conflictRunner.settle(preparedDelivery(), SUBMIT_HASH),
    (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      assert.ok(error.code === 'RECEIPT_RPC_CONFLICT' || error.code === 'TRANSFER_RPC_CONFLICT', error.code);
      assert.notEqual(error.code, 'RECEIPT_NOT_FINALIZED');
      assert.equal(error.name, 'RunnerError');
      assert.ok(!error.message.includes('SECONDARY-RECEIPT-DISAGREES'));
      assert.ok(!error.message.includes(SUBMIT_HASH));
      return true;
    }
  );
  assert.equal(sends, 0);

  const revertedReceipt = chain(() => ({
    transactionHash: SUBMIT_HASH,
    blockNumber: 600n,
    blockHash: `0x${'22'.repeat(32)}`,
    status: 'reverted',
    to: PROTOCOL,
    logs: [],
  }));
  const revertedRunner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    paymentToken: TOKEN,
    primary: revertedReceipt,
    secondary: revertedReceipt,
    transfer: { requirement: { token: TOKEN, recipient: BUYER, amountAtomic: 25_000_000n } },
    signer,
  } as never);
  let reverted: unknown;
  try {
    const outcome = await revertedRunner.settle(preparedDelivery(), SUBMIT_HASH);
    assert.notEqual(outcome.evidence.status, 'SUBMITTED');
    assert.notEqual(outcome.evidence.failure?.code, 'RECEIPT_NOT_FINALIZED');
  } catch (error) {
    reverted = error;
  }
  if (reverted !== undefined) {
    assert.ok(reverted instanceof RunnerError);
    assert.equal(reverted.code, 'SUBMISSION_REVERTED');
    assert.notEqual(reverted.code, 'RECEIPT_NOT_FINALIZED');
  }
  assert.equal(sends, 0);
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

test('settle() re-derives the reported transfer instead of copying the caller object', async () => {
  // Everything above tests the hashes and commitments settle() verifies. This
  // one tests the field it never verified: `prepared.transfer` is handed in by
  // whoever resumes the run, so it is caller-controlled data. Copying it into
  // FINALIZED evidence makes "observed transfer" mean "the resume client said
  // so" — which is precisely the sort of evidence the runner exists to replace.
  //
  // The fabricated values are distinct in every field so that any one of them
  // surfacing is a failure: an unresolved hash, a token that is not the protocol
  // payment token, and a sender that is not the job provider.
  const fabricated = {
    ...preparedDelivery(),
    transfer: {
      transactionHash: `0x${'de'.repeat(32)}`,
      blockNumber: 600n,
      blockHash: `0x${'22'.repeat(32)}`,
      timestamp: 1_700_000_000n,
      token: `0x${'ab'.repeat(20)}` as Address,
      sender: `0x${'cd'.repeat(20)}` as Address,
      recipient: `0x${'ef'.repeat(20)}` as Address,
      amountAtomic: 25_000_000n,
    },
  };

  const runner = runnerFor();
  const { evidence } = await runner.settle(
    fabricated as Parameters<typeof runner.settle>[0],
    SUBMIT_HASH
  );

  assert.equal(evidence.status, 'FINALIZED');
  // The hash, token, and sender must be the ones the runner proved against the
  // receipt it just read, not the ones the caller supplied.
  assert.equal(evidence.transfer!.transactionHash, TRANSFER_HASH);
  assert.equal(evidence.transfer!.token.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(evidence.transfer!.sender.toLowerCase(), PROVIDER.toLowerCase());
  assert.equal(evidence.transfer!.recipient.toLowerCase(), BUYER.toLowerCase());
  assert.equal(evidence.transfer!.amountAtomic, 25_000_000n);
  // The request is caller-controlled too, and must be the canonical one.
  assert.equal(evidence.submission!.deliveryCommitment, COMMITMENT);
});

test('settle() reports the canonical request it verified against, not the caller copy', async () => {
  // The request is the second caller-controlled field. settle() already rebuilds
  // it before verifying — `prepared.request` is documented as recovery input the
  // runner ignores — but the evidence must say so: returning the caller's object
  // would publish, next to a proof produced by a different request, a request
  // the receipt may never have referenced.
  //
  // The fabricated request targets a different function and address, so any
  // field of it surfacing is a failure rather than an incidental match.
  const fabricated = {
    ...preparedDelivery(),
    request: {
      abi: [] as const,
      address: `0x${'ee'.repeat(20)}`,
      functionName: 'cancelJob',
      args: [JOB_ID],
      from: BUYER,
    },
  };

  const runner = runnerFor();
  const { evidence } = await runner.settle(
    fabricated as Parameters<typeof runner.settle>[0],
    SUBMIT_HASH
  );

  assert.equal(evidence.status, 'FINALIZED');
  assert.ok(evidence.request, 'a settled run must report the request it verified');
  // Address, function, and arguments must all be the canonical ones.
  assert.equal(evidence.request!.address.toLowerCase(), PROTOCOL.toLowerCase());
  assert.equal(evidence.request!.functionName, 'submitDelivery');
  const args = evidence.request!.args as readonly unknown[];
  assert.equal(args[0], JOB_ID);
  assert.equal(args[1], COMMITMENT);
  assert.notEqual(evidence.request!.address.toLowerCase(), fabricated.request.address.toLowerCase());
});

/**
 * Recovery input is caller-controlled, and the two fields that steer evidence are
 * the request and the transfer locator bound inside the committed payload.
 *
 * The request is ignored outright — `settle()` rebuilds the canonical one. The
 * locator is subtler: it is read, but only after the payload carrying it has been
 * proven to reproduce the commitment the job holds on chain. These two tests
 * pin both halves.
 */
test('settle() ignores a caller-mutated request rather than verifying against it', async () => {
  // A resume client that edits the request to name a different function, a
  // foreign protocol address, or another provider. None of it may become the
  // request the runner checks the broadcast against, and none of it may surface
  // in FINALIZED evidence.
  const mutated = {
    ...preparedDelivery(),
    request: {
      address: `0x${'ab'.repeat(20)}` as Address,
      functionName: 'rejectJob',
      args: [999_999n, `0x${'be'.repeat(32)}`],
      from: `0x${'cd'.repeat(20)}` as Address,
    },
  };

  const runner = runnerFor();
  const { evidence } = await runner.settle(
    mutated as Parameters<typeof runner.settle>[0],
    SUBMIT_HASH
  );

  assert.equal(evidence.status, 'FINALIZED');
  // The request in evidence is the canonical one this runner built, so it
  // carries the real job ID and the on-chain commitment, and targets the
  // protocol address rather than the caller's substituted one.
  assert.notEqual(evidence.request!.address.toLowerCase(), mutated.request.address.toLowerCase());
  assert.equal(evidence.request!.functionName, 'submitDelivery');
  const args = evidence.request!.args as readonly unknown[];
  assert.equal(args[0], JOB_ID);
  assert.equal(args[1], COMMITMENT);
});

test('settle() refuses a payload whose transferTx points at an unproven receipt', async () => {
  // The control half of the pair. Here the caller keeps a *valid* commitment —
  // one that genuinely hashes the payload it hands over — but the payload's
  // `transferTx` names a transfer hash the protocol never committed to.
  //
  // This is the interesting direction: the commitment check cannot catch it,
  // because the commitment really does bind this payload. The only thing standing
  // between this input and a receipt the caller never delivered is that
  // `transferTx` is re-read from a payload proven to belong to the job, and then
  // the transfer it names must actually satisfy the requirement.
  const otherTransfer = `0x${'e1'.repeat(32)}`;
  const forged = {
    ...preparedDelivery(),
    delivery: payloadDelivery(otherTransfer),
    commitment: createDeliveryCommitment(JOB_ID, payloadDelivery(otherTransfer), SALT).commitment,
  };

  const runner = runnerFor();
  await assert.rejects(
    () => runner.settle(forged as Parameters<typeof runner.settle>[0], SUBMIT_HASH),
    (error: unknown) =>
      error instanceof RunnerError && error.code === 'RECEIPT_COMMITMENT_MISMATCH',
    'a transfer the protocol never committed to must not be settled'
  );
});

/**
 * A delivery commitment built without `createDeliveryCommitment`.
 *
 * The production helper is what `settle()` itself calls to prove a payload. A
 * fixture that goes through that helper shares the helper's bugs: if the helper
 * started echoing a caller field into the digest, or stopped hashing the payload
 * at all, both the fixture and the check under test would move together and the
 * test would stay green. This reconstruction spells the documented preimage out
 * by hand — domain label, job id, canonical JSON, salt — so it only agrees with
 * production when production still hashes that preimage.
 */
function independentDeliveryCommitment(jobId: bigint, delivery: unknown, salt: Hex): Hex {
  const label = new TextEncoder().encode('XYX_DELIVERY_COMMITMENT');
  const domain = new Uint8Array(32);
  domain.set(label, 0);
  const jobIdBytes = new Uint8Array(32);
  const jobIdHex = jobId.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) jobIdBytes[i] = Number.parseInt(jobIdHex.slice(i * 2, i * 2 + 2), 16);
  const payload = new TextEncoder().encode(canonicalJSON(delivery));
  const saltBytes = hexToBytes(salt);
  const preimage = new Uint8Array(domain.length + jobIdBytes.length + payload.length + saltBytes.length);
  let offset = 0;
  preimage.set(domain, offset); offset += domain.length;
  preimage.set(jobIdBytes, offset); offset += jobIdBytes.length;
  preimage.set(payload, offset); offset += payload.length;
  preimage.set(saltBytes, offset);
  return keccak256(toHex(preimage));
}

const CALLER_MARKER = 'CALLER-AUTHORED-TRANSFER-MUST-NOT-PUBLISH';
const FOREIGN_TOKEN = `0x${'a1'.repeat(20)}` as Address;
const FOREIGN_SENDER = `0x${'b2'.repeat(20)}` as Address;
const FOREIGN_RECIPIENT = `0x${'c3'.repeat(20)}` as Address;

/**
 * Walk Error.name, Error.message, Error.code, and nested causes.
 *
 * JSON.stringify drops the non-enumerable Error fields, so a leak check that
 * only stringifies an Error passes while the message still quotes the caller.
 */
function surfaceText(value: unknown, out: string[] = [], depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return out.join('\u0000');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    out.push(String(value));
    return out.join('\u0000');
  }
  if (value instanceof Error) {
    out.push(value.name, value.message);
    const coded = value as { code?: unknown; cause?: unknown };
    if (coded.code !== undefined) out.push(String(coded.code));
    if (coded.cause !== undefined) surfaceText(coded.cause, out, depth + 1);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'stack') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) surfaceText(descriptor.value, out, depth + 1);
    }
    return out.join('\u0000');
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) surfaceText(entry, out, depth + 1);
  }
  return out.join('\u0000');
}

test('settle() refuses independently built caller evidence and still accepts the matching control', async () => {
  // Old behavior this detects: copying `prepared.transfer` and `prepared.request`
  // into FINALIZED evidence. The adversarial object is not produced by
  // `preparedDelivery()` or `createDeliveryCommitment`. Its commitment is a
  // hand-built digest of a payload that names the real transfer, while every
  // transfer field and the request are caller inventions. If production republished
  // those inventions, the marker, the foreign token, and `cancelJob` would appear
  // in the returned evidence.
  const bound = payloadDelivery(TRANSFER_HASH);
  const handBuilt = independentDeliveryCommitment(JOB_ID, bound, SALT);
  assert.equal(handBuilt, COMMITMENT, 'the hand-built digest must still describe the real payload');

  const adversarial = {
    delivery: bound,
    commitment: handBuilt,
    salt: SALT,
    transfer: {
      transactionHash: `0x${'de'.repeat(32)}`,
      blockNumber: 1n,
      blockHash: `0x${'44'.repeat(32)}`,
      timestamp: 1n,
      token: FOREIGN_TOKEN,
      sender: FOREIGN_SENDER,
      recipient: FOREIGN_RECIPIENT,
      amountAtomic: 1n,
      note: CALLER_MARKER,
    },
    request: {
      abi: [] as const,
      address: FOREIGN_TOKEN,
      functionName: 'cancelJob',
      args: [999n],
      from: FOREIGN_SENDER,
      note: CALLER_MARKER,
    },
    observation: { number: 1n, hash: `0x${'44'.repeat(32)}`, timestamp: 1n },
    job: submitJob({ status: 2 as JobStatus, deliveryCommitment: ZERO_HASH }),
  };

  const runner = runnerFor();
  const { evidence, prepared } = await runner.settle(
    adversarial as Parameters<typeof runner.settle>[0],
    SUBMIT_HASH
  );

  assert.equal(evidence.status, 'FINALIZED');
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.transactionHash, SUBMIT_HASH);
  assert.equal(evidence.transfer!.transactionHash, TRANSFER_HASH);
  assert.equal(evidence.transfer!.token.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(evidence.transfer!.sender.toLowerCase(), PROVIDER.toLowerCase());
  assert.equal(evidence.transfer!.recipient.toLowerCase(), BUYER.toLowerCase());
  assert.equal(evidence.transfer!.amountAtomic, 25_000_000n);
  assert.equal(evidence.request!.functionName, 'submitDelivery');
  assert.equal(evidence.request!.address.toLowerCase(), PROTOCOL.toLowerCase());
  assert.equal((evidence.request!.args as readonly unknown[])[1], handBuilt);
  assert.equal(evidence.submission!.deliveryCommitment, handBuilt);
  assert.equal(evidence.submission!.blockNumber, 600n);
  const published = surfaceText(evidence);
  assert.ok(!published.includes(CALLER_MARKER), 'caller-authored marker reached FINALIZED evidence');
  assert.ok(!published.includes(FOREIGN_TOKEN.slice(2)), 'caller-authored token reached FINALIZED evidence');
  assert.ok(!published.includes('cancelJob'), 'caller-authored request reached FINALIZED evidence');
  // The returned handle is rebuilt, not the object this test handed in.
  assert.notEqual(prepared, adversarial);
  assert.equal(prepared?.transfer.token.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(prepared?.transfer.transactionHash, TRANSFER_HASH);
  assert.equal(prepared?.request.functionName, 'submitDelivery');
  assert.equal(prepared?.job.deliveryCommitment, COMMITMENT);
  assert.equal(prepared?.observation.number, 600n);
  const handleText = surfaceText(prepared);
  assert.ok(!handleText.includes(CALLER_MARKER));
  assert.ok(!handleText.includes(FOREIGN_TOKEN.slice(2)));
  assert.ok(!handleText.includes('cancelJob'));

  // Negative control: the same runner, given a payload whose hand-built digest
  // does not match the job, must reject and must not return finalized evidence.
  const forgedPayload = payloadDelivery(`0x${'e3'.repeat(32)}`);
  const forged = {
    ...adversarial,
    delivery: forgedPayload,
    commitment: independentDeliveryCommitment(JOB_ID, forgedPayload, SALT),
  };
  let rejected: unknown;
  try {
    await runner.settle(forged as Parameters<typeof runner.settle>[0], SUBMIT_HASH);
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected instanceof RunnerError);
  assert.equal(rejected.code, 'RECEIPT_COMMITMENT_MISMATCH');
  assert.equal(rejected.name, 'RunnerError');
  const rejectedText = surfaceText(rejected);
  assert.ok(!rejectedText.includes(CALLER_MARKER));
  assert.ok(!rejectedText.includes(`0x${'e3'.repeat(32)}`));
  assert.ok(!rejectedText.includes('rpc'), rejectedText);
});

test('settle() accepts a handle that prepare() built and does not broadcast', async () => {
  // Legitimate control. The handle comes from prepare() on a funded job, not
  // from a hand-built object. Settling it must report the transfer prepare()
  // observed and must not call the signer.
  let sends = 0;
  const signer = {
    address: PROVIDER as Address,
    sendTransaction: async () => {
      sends += 1;
      return { kind: 'submitted' as const, transactionHash: SUBMIT_HASH as Hex };
    },
  };
  const funded = readerWithSubmission();
  funded.readContract = async ({ functionName }: { functionName: string }) => {
    if (functionName !== 'getJob') throw new Error(`unexpected read: ${functionName}`);
    return submitJob({ status: 2 as JobStatus, deliveryCommitment: ZERO_HASH });
  };
  const builder = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    paymentToken: TOKEN,
    primary: funded,
    secondary: funded,
    privateInput: {
      provide: async () => ({ schema: 'xyx.delivery', kind: 'analysis', content: { note: 'work' }, salt: SALT }),
    },
    executor: { execute: async () => ({ ok: true as const, delivery: { note: 'work' } }) },
    transfer: {
      requirement: { token: TOKEN, recipient: BUYER, amountAtomic: 25_000_000n },
      execute: async () => TRANSFER_HASH,
    },
    signer,
  } as never);
  const built = await builder.prepare();
  assert.equal(built.evidence.status, 'TRANSFERRED');
  assert.ok(built.prepared);
  assert.equal(built.prepared.transfer.transactionHash, TRANSFER_HASH);
  assert.equal(sends, 0);

  const committed = readerWithSubmission({ jobDeliveryCommitment: built.prepared.commitment, eventCommitment: built.prepared.commitment });
  const settler = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    paymentToken: TOKEN,
    primary: committed,
    secondary: committed,
    transfer: { requirement: { token: TOKEN, recipient: BUYER, amountAtomic: 25_000_000n } },
    signer,
  } as never);
  const settled = await settler.settle(built.prepared, SUBMIT_HASH);
  assert.equal(settled.evidence.status, 'FINALIZED');
  assert.equal(settled.evidence.transactionHash, SUBMIT_HASH);
  assert.equal(settled.evidence.transfer!.transactionHash, TRANSFER_HASH);
  assert.equal(settled.evidence.request!.functionName, 'submitDelivery');
  assert.equal(settled.prepared?.transfer.transactionHash, TRANSFER_HASH);
  assert.equal(settled.prepared?.request.functionName, 'submitDelivery');
  assert.notEqual(settled.prepared, built.prepared);
  assert.equal(sends, 0, 'settling a runner-built handle must not broadcast');
});

test('settle() returns a sanitized handle for a non-final receipt and retries with it', async () => {
  // Local fixture. The fabricated handle is a fresh object, not preparedDelivery().
  // Its commitment is the hand-built digest of the real payload, so the payload
  // check passes, and every other field is a caller invention. Old behavior
  // returned that object beside rebuilt evidence.
  const FABRICATED_JOB = 'FABRICATED-JOB-MARKER';
  const FABRICATED_BLOCK = `0x${'57'.repeat(32)}` as Hex;
  const bound = payloadDelivery(TRANSFER_HASH);
  const handBuilt = independentDeliveryCommitment(JOB_ID, bound, SALT);
  const ahead = 900n;
  const aheadHash = `0x${'31'.repeat(32)}` as Hex;
  let sends = 0;
  const signer = {
    address: PROVIDER as Address,
    sendTransaction: async () => {
      sends += 1;
      return { kind: 'submitted' as const, transactionHash: SUBMIT_HASH as Hex };
    },
  };
  const base = readerWithSubmission();
  const notFinal = {
    ...base,
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) =>
      args.blockNumber === ahead
        ? { number: ahead, hash: aheadHash, timestamp: 1_700_000_900n }
        : { number: 600n, hash: `0x${'22'.repeat(32)}`, timestamp: 1_700_000_000n },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
      hash === SUBMIT_HASH
        ? {
            transactionHash: SUBMIT_HASH,
            blockNumber: ahead,
            blockHash: aheadHash,
            status: 'success' as const,
            to: PROTOCOL,
            logs: [],
          }
        : base.getTransactionReceipt({ hash }),
  };
  const fabricated = {
    delivery: bound,
    commitment: handBuilt,
    salt: SALT,
    transfer: {
      transactionHash: `0x${'de'.repeat(32)}`,
      blockNumber: 1n,
      blockHash: FABRICATED_BLOCK,
      timestamp: 1n,
      token: FOREIGN_TOKEN,
      sender: FOREIGN_SENDER,
      recipient: FOREIGN_RECIPIENT,
      amountAtomic: 1n,
      note: CALLER_MARKER,
    },
    request: {
      abi: [] as const,
      address: FOREIGN_TOKEN,
      functionName: 'cancelJob',
      args: [999n],
      from: FOREIGN_SENDER,
      note: CALLER_MARKER,
    },
    observation: { number: 1n, hash: FABRICATED_BLOCK, timestamp: 1n, label: FABRICATED_JOB },
    job: { ...submitJob({ status: 2 as JobStatus, deliveryCommitment: ZERO_HASH }), label: FABRICATED_JOB },
  };
  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    paymentToken: TOKEN,
    primary: notFinal,
    secondary: notFinal,
    transfer: { requirement: { token: TOKEN, recipient: BUYER, amountAtomic: 25_000_000n } },
    signer,
  } as never);

  const outcome = await runner.settle(fabricated as Parameters<typeof runner.settle>[0], SUBMIT_HASH);
  assert.equal(outcome.evidence.status, 'SUBMITTED');
  assert.equal(outcome.evidence.transactionHash, SUBMIT_HASH);
  assert.equal(outcome.evidence.failure?.code, 'RECEIPT_NOT_FINALIZED');
  assert.equal(outcome.evidence.transfer!.transactionHash, TRANSFER_HASH);
  assert.equal(outcome.evidence.transfer!.token.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(outcome.evidence.request!.functionName, 'submitDelivery');
  assert.equal(outcome.evidence.job?.deliveryCommitment, COMMITMENT);
  const handle = outcome.prepared;
  assert.ok(handle);
  assert.notEqual(handle, fabricated);
  assert.equal(handle.commitment, handBuilt);
  assert.equal(handle.salt, SALT);
  assert.equal(handle.transfer.transactionHash, TRANSFER_HASH);
  assert.equal(handle.transfer.token.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(handle.transfer.sender.toLowerCase(), PROVIDER.toLowerCase());
  assert.equal(handle.transfer.recipient.toLowerCase(), BUYER.toLowerCase());
  assert.equal(handle.transfer.amountAtomic, 25_000_000n);
  assert.equal(handle.request.functionName, 'submitDelivery');
  assert.equal(handle.request.address.toLowerCase(), PROTOCOL.toLowerCase());
  assert.equal(handle.job.deliveryCommitment, COMMITMENT);
  assert.equal(handle.observation.number, 600n);
  assert.equal(handle.observation.hash, `0x${'22'.repeat(32)}`);
  const surfaces = surfaceText(outcome);
  assert.ok(!surfaces.includes(CALLER_MARKER));
  assert.ok(!surfaces.includes(FABRICATED_JOB));
  assert.ok(!surfaces.includes(FABRICATED_BLOCK.slice(2)));
  assert.ok(!surfaces.includes(FOREIGN_TOKEN.slice(2)));
  assert.ok(!surfaces.includes('cancelJob'));
  assert.equal(sends, 0);

  const second = await runner.settle(handle, SUBMIT_HASH);
  assert.equal(second.evidence.status, 'SUBMITTED');
  assert.equal(second.evidence.transactionHash, SUBMIT_HASH);
  assert.equal(second.evidence.failure?.code, 'RECEIPT_NOT_FINALIZED');
  assert.equal(second.prepared?.transfer.token.toLowerCase(), TOKEN.toLowerCase());
  assert.ok(!surfaceText(second).includes(CALLER_MARKER));
  assert.equal(sends, 0, 'retrying with the returned handle must not broadcast');
});

test('settle() refuses a payload that does not reproduce the on-chain commitment', async () => {
  // The direct half: the payload is edited so that hashing it with the recovery
  // salt no longer yields the commitment the job carries. Nothing downstream of
  // this may run, and in particular the mutated `transferTx` must never be used
  // as a locator for re-observing a transfer.
  const mutatedTx = `0x${'e2'.repeat(32)}`;
  const forged = {
    ...preparedDelivery(),
    delivery: payloadDelivery(mutatedTx),
  };

  const runner = runnerFor();
  await assert.rejects(
    () => runner.settle(forged as Parameters<typeof runner.settle>[0], SUBMIT_HASH),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === 'RECEIPT_COMMITMENT_MISMATCH' &&
      !error.message.includes(mutatedTx) &&
      // The message is runner-authored and fixed, so it is pinned here as a
      // literal. The point is that it describes the mismatch without quoting
      // the mutated locator it refused.
      error.message ===
        'the prepared delivery payload does not reproduce the delivery commitment the job carries on chain',
    'a payload that does not hash to the on-chain commitment must be refused'
  );
});
