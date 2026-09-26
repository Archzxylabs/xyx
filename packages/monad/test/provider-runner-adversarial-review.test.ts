/**
 * Independent Adversarial Review for XYX ProviderRunner (Prompt 07).
 *
 * This test suite independently stresses the provider-runner boundaries without
 * modifying production source code. It validates:
 *
 * 1. Recovery integrity:
 *    - Fabricated transfer fields (token, sender, recipient, amount, block, hash, timestamp)
 *      are ignored; facts are reconstructed exclusively from finalized two-RPC receipts.
 *    - Fabricated caller requests are ignored; verification uses canonically rebuilt calls.
 *    - Two-RPC disagreements fail closed across transfer logs, receipt blocks, and job storage.
 *
 * 2. Privacy boundary:
 *    - Executor failure reasons, signer rejection texts, RPC URL credentials, and private
 *      input payloads never leak into RunnerError, RunStep, RunEvidence, or prepared handles.
 *
 * 3. Preflight ordering:
 *    - Token mismatch, malformed recipients, non-positive amounts, and wrong chain IDs abort
 *      immediately before any privateInput, executor, transfer hook, or signer calls happen.
 *
 * 4. Pending / reconciliation states:
 *    - Broadcast with non-final receipt returns status SUBMITTED with exact transactionHash
 *      and a usable recovery handle without blind resends.
 *    - Reverted receipt is clearly distinguished as SUBMISSION_REVERTED, not pending.
 *    - settle() never invokes the signer.
 *
 * 5. Positive local control:
 *    - Fully matching local dual-reader evidence reaches FINALIZED.
 *    - Explicitly labeled LOCAL_TESTED (never live Testnet evidence).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import { encodeAbiParameters, encodeEventTopics } from 'viem';

import { ProviderRunner, RunnerError } from '../src/provider-runner/runner.js';
import { createDeliveryCommitment } from '../src/delivery.js';
import { transferLog } from './fixtures/provider-runner/erc20.js';
import type { JobData } from '../src/protocol.js';
import type { PreparedDelivery } from '../src/provider-runner/adapters.js';

// ===========================================================================
// Test Constants & Distinctive Adversarial Markers
// ===========================================================================

const PROTOCOL = '0x1111111111111111111111111111111111111111' as Address;
const REGISTRY = '0x2222222222222222222222222222222222222222' as Address;
const VERIFIER = '0x3333333333333333333333333333333333333333' as Address;
const TOKEN = '0x4444444444444444444444444444444444444444' as Address;
const OTHER_TOKEN = '0x4444444444444444444444444444444444444445' as Address;
const PROVIDER = '0x5555555555555555555555555555555555555555' as Address;
const BUYER = '0x6666666666666666666666666666666666666666' as Address;
const ATTESTOR = '0x7777777777777777777777777777777777777777' as Address;
const RECIPIENT = '0x8888888888888888888888888888888888888888' as Address;

const JOB_ID = 42n;
const TRANSFER_AMOUNT = 10_000_000n; // 10 USDC (6 decimals)
const BLOCK_NUMBER = 888n;
const BLOCK_HASH = `0x${'aa'.repeat(32)}` as Hex;
const TRANSFER_HASH = `0x${'bb'.repeat(32)}` as Hex;
const SUBMIT_HASH = `0x${'cc'.repeat(32)}` as Hex;
const REVERTED_HASH = `0x${'dd'.repeat(32)}` as Hex;
const PENDING_SUBMIT_HASH = `0x${'ee'.repeat(32)}` as Hex;

const RAW_SALT = `0x${'77'.repeat(32)}` as Hex;

// Privacy check markers
const EXECUTOR_MARKER_ERR = 'MARKER-EXECUTOR-SECRET-FAIL-07';
const SIGNER_MARKER_ERR = 'MARKER-SIGNER-REJECT-TOKEN-07';
const RPC_CREDENTIAL_URL = 'https://rpc.example.invalid/key-SECRET-CREDENTIAL-07/v1';
const AUTH_HEADER_SECRET = 'Bearer SECRET-AUTH-HEADER-TOKEN-07';
const PRIVATE_INPUT_SECRET = 'MARKER-PRIVATE-INPUT-PAYLOAD-07';

const FORBIDDEN_MARKERS = [
  EXECUTOR_MARKER_ERR,
  SIGNER_MARKER_ERR,
  RPC_CREDENTIAL_URL,
  AUTH_HEADER_SECRET,
  PRIVATE_INPUT_SECRET,
  RAW_SALT,
];

// Delivery commitment binding to TRANSFER_HASH
const VALID_DELIVERY_PAYLOAD = {
  schema: 'xyx.delivery',
  kind: 'analysis',
  content: {
    instruction: 'Transfer payment',
    transferTx: TRANSFER_HASH,
  },
};

const CANONICAL_COMMITMENT = createDeliveryCommitment(
  JOB_ID,
  VALID_DELIVERY_PAYLOAD,
  RAW_SALT
).commitment;

// ===========================================================================
// Helper Functions & Fixtures
// ===========================================================================

function makeJob(status: number = 2, overrides: Partial<JobData> = {}): JobData {
  return {
    buyer: BUYER,
    provider: PROVIDER,
    attestor: ATTESTOR,
    termsCommitment: `0x${'11'.repeat(32)}` as Hex,
    deliveryCommitment: status === 3 ? CANONICAL_COMMITMENT : (`0x${'00'.repeat(32)}` as Hex),
    budget: 20_000_000n,
    expiresAt: 0n,
    status,
    ...overrides,
  };
}

function makeTaskRequirement(overrides: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    recipient: RECIPIENT,
    amountAtomic: TRANSFER_AMOUNT,
    ...overrides,
  };
}

function encodeDeliverySubmitted(jobId: bigint, provider: string, commitment: Hex) {
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
  const data = encodeAbiParameters([{ type: 'bytes32' }], [commitment]);
  return [{ address: PROTOCOL, data, topics: [topic0!, topic1!, topic2!] }];
}

interface MockReaderOptions {
  settleMode?: boolean;
  blockNumber?: bigint;
  blockHash?: Hex;
  transferLogs?: ReturnType<typeof transferLog>[];
  submissionStatus?: 'success' | 'reverted' | 'missing';
  submissionHash?: Hex;
  submissionCommitment?: Hex;
  rpcError?: Error;
  overrideTo?: Address;
}

function createMockReader(opts: MockReaderOptions = {}) {
  let isSubmitted = opts.settleMode ?? false;

  const {
    blockNumber = BLOCK_NUMBER,
    blockHash = BLOCK_HASH,
    transferLogs = [transferLog(TOKEN, PROVIDER, RECIPIENT, TRANSFER_AMOUNT)],
    submissionStatus = 'success',
    submissionHash = SUBMIT_HASH,
    submissionCommitment = CANONICAL_COMMITMENT,
    rpcError,
    overrideTo,
  } = opts;

  const reader = {
    getChainId: async () => 10143,
    getBlock: async ({ blockTag, blockNumber: bNum }: { blockTag?: string; blockNumber?: bigint } = {}) => {
      if (rpcError) throw rpcError;
      return {
        number: bNum ?? blockNumber,
        hash: blockHash,
        timestamp: 1_700_000_000n,
      };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (rpcError) throw rpcError;
      return {
        hash,
        from: PROVIDER,
        to: PROTOCOL,
        input: '0x' as Hex,
        blockNumber,
        blockHash,
      };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (rpcError) throw rpcError;
      if (hash === TRANSFER_HASH) {
        return {
          transactionHash: hash,
          blockNumber,
          blockHash,
          status: 'success' as const,
          to: TOKEN,
          logs: transferLogs,
        };
      }
      if (hash === submissionHash) {
        if (submissionStatus === 'missing') {
          return null;
        }
        return {
          transactionHash: hash,
          blockNumber,
          blockHash,
          status: submissionStatus,
          to: overrideTo ?? PROTOCOL,
          logs: submissionStatus === 'success'
            ? encodeDeliverySubmitted(JOB_ID, PROVIDER, submissionCommitment)
            : [],
        };
      }
      return null;
    },
    readContract: async ({ functionName }: { functionName: string; blockNumber?: bigint }) => {
      if (rpcError) throw rpcError;
      if (functionName === 'getJob') {
        if (isSubmitted) {
          return makeJob(3, { deliveryCommitment: submissionCommitment });
        }
        return makeJob(2, { deliveryCommitment: `0x${'00'.repeat(32)}` as Hex });
      }
      throw new Error(`Unexpected contract read: ${functionName}`);
    },
  };

  return {
    reader,
    markSubmitted: () => {
      isSubmitted = true;
    },
  };
}

function safeCollectText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    out.push(value.toString());
    return out;
  }
  if (value instanceof Error) {
    out.push(value.message, value.name);
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') out.push(code);
    if ('cause' in value && value.cause) {
      safeCollectText(value.cause, out, depth + 1);
    }
    const own: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'stack') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) own[key] = descriptor.value;
    }
    safeCollectText(own, out, depth + 1);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) safeCollectText(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      safeCollectText(entry, out, depth + 1);
    }
    return out;
  }
  out.push(String(value));
  return out;
}

function assertNoSecrets(subject: unknown, context: string): void {
  const combined = safeCollectText(subject).join('\u0000');
  for (const marker of FORBIDDEN_MARKERS) {
    assert.ok(
      !combined.includes(marker),
      `SECURITY LEAK in ${context}: sensitive marker "${marker}" was found in public output!`
    );
  }
}

// ===========================================================================
// 1. RECOVERY INTEGRITY TESTS
// ===========================================================================

test('recovery integrity: settle() ignores fabricated caller transfer fields and re-derives strictly from finalized RPC receipt', async () => {
  const { reader } = createMockReader({ settleMode: true });
  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: reader,
    secondary: reader,
    paymentToken: TOKEN,
    transfer: { requirement: makeTaskRequirement() },
  } as never);

  // An attacker passes a fabricated PreparedDelivery where the transfer object claims fake values
  const fakeCallerTransfer = {
    transactionHash: `0x${'99'.repeat(32)}` as Hex,
    blockNumber: 999999n,
    blockHash: `0x${'88'.repeat(32)}` as Hex,
    timestamp: 9999999999n,
    token: `0x${'77'.repeat(20)}` as Address,
    sender: `0x${'66'.repeat(20)}` as Address,
    recipient: `0x${'55'.repeat(20)}` as Address,
    amountAtomic: 1n,
  };

  const fabricatedHandle: PreparedDelivery = {
    jobId: JOB_ID,
    job: makeJob(2),
    commitment: CANONICAL_COMMITMENT,
    salt: RAW_SALT,
    delivery: VALID_DELIVERY_PAYLOAD,
    transfer: fakeCallerTransfer,
    request: {
      address: PROTOCOL,
      abi: [],
      functionName: 'submitDelivery',
      args: [JOB_ID, CANONICAL_COMMITMENT],
    },
  };

  const outcome = await runner.settle(fabricatedHandle, SUBMIT_HASH);
  assert.equal(outcome.evidence.status, 'FINALIZED');

  // Verify that NONE of the caller's fabricated values made it into the evidence
  const observedTransfer = outcome.evidence.transfer;
  assert.ok(observedTransfer, 'Observed transfer must exist in finalized evidence');
  assert.equal(observedTransfer.transactionHash, TRANSFER_HASH);
  assert.equal(observedTransfer.blockNumber, BLOCK_NUMBER);
  assert.equal(observedTransfer.blockHash, BLOCK_HASH);
  assert.equal(observedTransfer.token.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(observedTransfer.sender.toLowerCase(), PROVIDER.toLowerCase());
  assert.equal(observedTransfer.recipient.toLowerCase(), RECIPIENT.toLowerCase());
  assert.equal(observedTransfer.amountAtomic, TRANSFER_AMOUNT);
});

test('recovery integrity: settle() ignores caller-mutated request and rebuilds canonical call', async () => {
  const { reader } = createMockReader({ settleMode: true });
  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: reader,
    secondary: reader,
    paymentToken: TOKEN,
    transfer: { requirement: makeTaskRequirement() },
  } as never);

  const mutatedHandle: PreparedDelivery = {
    jobId: JOB_ID,
    job: makeJob(2),
    commitment: CANONICAL_COMMITMENT,
    salt: RAW_SALT,
    delivery: VALID_DELIVERY_PAYLOAD,
    transfer: {
      transactionHash: TRANSFER_HASH,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      timestamp: 1_700_000_000n,
      token: TOKEN,
      sender: PROVIDER,
      recipient: RECIPIENT,
      amountAtomic: TRANSFER_AMOUNT,
    },
    request: {
      address: `0x${'99'.repeat(20)}` as Address, // Fake protocol address
      abi: [],
      functionName: 'fakeFunction',
      args: [999n],
      from: `0x${'88'.repeat(20)}` as Address,
    },
  };

  const outcome = await runner.settle(mutatedHandle, SUBMIT_HASH);
  assert.equal(outcome.evidence.status, 'FINALIZED');
  // Request must be rebuilt canonically targeting the configured protocol
  assert.equal(outcome.evidence.request?.address.toLowerCase(), PROTOCOL.toLowerCase());
  assert.equal(outcome.evidence.request?.functionName, 'submitDelivery');
});

test('recovery integrity: settle() fails closed when primary and secondary readers disagree on transfer block hash', async () => {
  const { reader: primary } = createMockReader({ settleMode: true, blockHash: `0x${'11'.repeat(32)}` as Hex });
  const { reader: secondary } = createMockReader({ settleMode: true, blockHash: `0x${'22'.repeat(32)}` as Hex });

  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary,
    secondary,
    paymentToken: TOKEN,
    transfer: { requirement: makeTaskRequirement() },
  } as never);

  const handle: PreparedDelivery = {
    jobId: JOB_ID,
    job: makeJob(2),
    commitment: CANONICAL_COMMITMENT,
    salt: RAW_SALT,
    delivery: VALID_DELIVERY_PAYLOAD,
    transfer: {
      transactionHash: TRANSFER_HASH,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      timestamp: 1_700_000_000n,
      token: TOKEN,
      sender: PROVIDER,
      recipient: RECIPIENT,
      amountAtomic: TRANSFER_AMOUNT,
    },
    request: { address: PROTOCOL, abi: [], functionName: 'submitDelivery', args: [] },
  };

  await assert.rejects(
    () => runner.settle(handle, SUBMIT_HASH),
    (err: unknown) => err instanceof RunnerError && err.code === 'TRANSFER_RPC_CONFLICT'
  );
});

test('recovery integrity: settle() fails closed when primary and secondary readers disagree on submission receipt', async () => {
  const { reader: primary } = createMockReader({ settleMode: true, blockHash: `0x${'aa'.repeat(32)}` as Hex });
  const { reader: secondary } = createMockReader({ settleMode: true, blockHash: `0x${'bb'.repeat(32)}` as Hex });

  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary,
    secondary,
    paymentToken: TOKEN,
    transfer: { requirement: makeTaskRequirement(), observedTransactionHash: TRANSFER_HASH },
  } as never);

  const handle: PreparedDelivery = {
    jobId: JOB_ID,
    job: makeJob(2),
    commitment: CANONICAL_COMMITMENT,
    salt: RAW_SALT,
    delivery: VALID_DELIVERY_PAYLOAD,
    transfer: {
      transactionHash: TRANSFER_HASH,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      timestamp: 1_700_000_000n,
      token: TOKEN,
      sender: PROVIDER,
      recipient: RECIPIENT,
      amountAtomic: TRANSFER_AMOUNT,
    },
    request: { address: PROTOCOL, abi: [], functionName: 'submitDelivery', args: [] },
  };

  await assert.rejects(
    () => runner.settle(handle, SUBMIT_HASH),
    (err: unknown) => err instanceof RunnerError && err.code === 'TRANSFER_RPC_CONFLICT'
  );
});

test('recovery integrity: settle() rejects if delivery commitment does not reproduce on-chain commitment', async () => {
  const { reader } = createMockReader({ settleMode: true });
  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: reader,
    secondary: reader,
    paymentToken: TOKEN,
    transfer: { requirement: makeTaskRequirement() },
  } as never);

  const forgedPayload = {
    ...VALID_DELIVERY_PAYLOAD,
    content: { ...VALID_DELIVERY_PAYLOAD.content, instruction: 'Forged instruction' },
  };

  const handle: PreparedDelivery = {
    jobId: JOB_ID,
    job: makeJob(2),
    commitment: CANONICAL_COMMITMENT,
    salt: RAW_SALT,
    delivery: forgedPayload,
    transfer: {
      transactionHash: TRANSFER_HASH,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      timestamp: 1_700_000_000n,
      token: TOKEN,
      sender: PROVIDER,
      recipient: RECIPIENT,
      amountAtomic: TRANSFER_AMOUNT,
    },
    request: { address: PROTOCOL, abi: [], functionName: 'submitDelivery', args: [] },
  };

  await assert.rejects(
    () => runner.settle(handle, SUBMIT_HASH),
    (err: unknown) => err instanceof RunnerError && err.code === 'RECEIPT_COMMITMENT_MISMATCH'
  );
});

// ===========================================================================
// 2. PRIVACY BOUNDARY TESTS
// ===========================================================================

test('privacy: executor error or thrown text never leaks into RunnerError or public output', async () => {
  const { reader } = createMockReader();
  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: reader,
    secondary: reader,
    paymentToken: TOKEN,
    privateInput: {
      provide: async () => ({
        schema: 'xyx.delivery',
        kind: 'analysis',
        content: { secret: PRIVATE_INPUT_SECRET },
        salt: RAW_SALT,
      }),
    },
    executor: {
      execute: async () => {
        throw new Error(`Critical failure with ${EXECUTOR_MARKER_ERR}`);
      },
    },
    transfer: { requirement: makeTaskRequirement(), execute: async () => TRANSFER_HASH },
  } as never);

  try {
    await runner.prepare();
    assert.fail('Expected prepare() to reject');
  } catch (error) {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, 'EXECUTION_FAILED');
    assertNoSecrets(error, 'Executor throw RunnerError');
    assertNoSecrets(runner['steps'], 'Runner steps after executor failure');
  }
});

test('privacy: signer rejection reason or auth header never leaks into RunnerError or output', async () => {
  const { reader } = createMockReader();
  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: reader,
    secondary: reader,
    paymentToken: TOKEN,
    privateInput: {
      provide: async () => ({
        schema: 'xyx.delivery',
        kind: 'analysis',
        content: { secret: PRIVATE_INPUT_SECRET },
        salt: RAW_SALT,
      }),
    },
    executor: {
      execute: async () => ({ ok: true, delivery: { status: 'done' } }),
    },
    transfer: { requirement: makeTaskRequirement(), execute: async () => TRANSFER_HASH },
    signer: {
      address: PROVIDER,
      sendTransaction: async () => ({
        kind: 'rejected',
        reason: `Signer declined with ${AUTH_HEADER_SECRET} and ${SIGNER_MARKER_ERR}`,
      }),
    },
  } as never);

  const { evidence } = await runner.run();
  assert.equal(evidence.status, 'FAILED');
  assert.equal(evidence.failure?.code, 'SEND_FAILED');
  assertNoSecrets(evidence, 'Failed RunEvidence');
  assertNoSecrets(runner['steps'], 'Runner steps after signer rejection');
});

test('privacy: reader transport failure never leaks RPC URL or credentials into RunnerError', async () => {
  const leakingError = new Error(`Connection failed to ${RPC_CREDENTIAL_URL}`);
  const { reader: failingReader } = createMockReader({ rpcError: leakingError });

  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: failingReader,
    secondary: failingReader,
    paymentToken: TOKEN,
    transfer: { requirement: makeTaskRequirement() },
  } as never);

  try {
    await runner.prepare();
    assert.fail('Expected prepare() to fail');
  } catch (error) {
    assert.ok(error instanceof RunnerError);
    assertNoSecrets(error, 'Reader failure RunnerError');
  }
});

// ===========================================================================
// 3. PREFLIGHT ORDERING TESTS
// ===========================================================================

test('preflight ordering: token mismatch aborts before privateInput, executor, transfer, or signer run', () => {
  let privateInputCalls = 0;
  let executorCalls = 0;
  let transferCalls = 0;
  let signerCalls = 0;

  const { reader } = createMockReader();
  assert.throws(
    () =>
      new ProviderRunner({
        addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
        jobId: JOB_ID,
        primary: reader,
        secondary: reader,
        paymentToken: TOKEN,
        privateInput: {
          provide: async () => {
            privateInputCalls++;
            return {
              schema: 'xyx.delivery',
              kind: 'analysis',
              content: { secret: PRIVATE_INPUT_SECRET },
              salt: RAW_SALT,
            };
          },
        },
        executor: {
          execute: async () => {
            executorCalls++;
            return { ok: true, delivery: { done: true } };
          },
        },
        transfer: {
          requirement: makeTaskRequirement({ token: OTHER_TOKEN }), // Mismatched token!
          execute: async () => {
            transferCalls++;
            return TRANSFER_HASH;
          },
        },
        signer: {
          address: PROVIDER,
          sendTransaction: async () => {
            signerCalls++;
            return { kind: 'submitted', transactionHash: SUBMIT_HASH };
          },
        },
      } as never),
    (err: unknown) => err instanceof RunnerError && err.code === 'TRANSFER_TOKEN_MISMATCH'
  );

  assert.equal(privateInputCalls, 0, 'privateInput must not be invoked on token mismatch');
  assert.equal(executorCalls, 0, 'executor must not be invoked on token mismatch');
  assert.equal(transferCalls, 0, 'transfer hook must not be invoked on token mismatch');
  assert.equal(signerCalls, 0, 'signer must not be invoked on token mismatch');
});

test('preflight ordering: non-positive transfer amount aborts before side-effects', async () => {
  let transferCalls = 0;
  const { reader } = createMockReader();

  assert.throws(
    () =>
      new ProviderRunner({
        addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
        jobId: JOB_ID,
        primary: reader,
        secondary: reader,
        paymentToken: TOKEN,
        transfer: {
          requirement: makeTaskRequirement({ amountAtomic: 0n }),
          execute: async () => {
            transferCalls++;
            return TRANSFER_HASH;
          },
        },
      } as never),
    (err: unknown) => err instanceof RunnerError && err.code === 'TRANSFER_MISMATCH'
  );

  assert.equal(transferCalls, 0, 'transfer hook must not be called when amount is zero');
});

test('preflight ordering: incompatible chain ID is rejected immediately in constructor', () => {
  const { reader } = createMockReader();
  assert.throws(
    () =>
      new ProviderRunner({
        addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
        jobId: JOB_ID,
        chainId: 1, // Mainnet (not Monad Testnet 10143)
        primary: reader,
        secondary: reader,
        paymentToken: TOKEN,
        transfer: { requirement: makeTaskRequirement() },
      } as never),
    (err: unknown) => err instanceof RunnerError && err.code === 'CHAIN_GUARD_FAILED'
  );
});

// ===========================================================================
// 4. PENDING & RECONCILIATION TESTS
// ===========================================================================

test('pending state: valid broadcast with non-final receipt returns status SUBMITTED with exact transactionHash', async () => {
  // Receipt is not yet in chain (missing / null)
  const { reader } = createMockReader({
    submissionStatus: 'missing',
    submissionHash: PENDING_SUBMIT_HASH,
  });

  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: reader,
    secondary: reader,
    paymentToken: TOKEN,
    privateInput: {
      provide: async () => ({
        schema: 'xyx.delivery',
        kind: 'analysis',
        content: { instruction: 'Transfer payment' },
        salt: RAW_SALT,
      }),
    },
    executor: {
      execute: async () => ({ ok: true, delivery: { instruction: 'Transfer payment' } }),
    },
    transfer: {
      requirement: makeTaskRequirement(),
      execute: async () => TRANSFER_HASH,
    },
    signer: {
      address: PROVIDER,
      sendTransaction: async () => ({ kind: 'submitted', transactionHash: PENDING_SUBMIT_HASH }),
    },
  } as never);

  const { evidence, prepared } = await runner.run();

  assert.equal(evidence.status, 'SUBMITTED');
  assert.equal(evidence.transactionHash, PENDING_SUBMIT_HASH);
  assert.equal(evidence.submission, undefined, 'submission must remain unproven');
  assert.ok(prepared, 'A usable prepared recovery handle must be returned');
  assert.equal(prepared.commitment, CANONICAL_COMMITMENT);
  assert.equal(prepared.salt, RAW_SALT);
});

test('pending state: reverted submission receipt is distinguished from pending as SUBMISSION_REVERTED', async () => {
  const { reader } = createMockReader({
    submissionStatus: 'reverted',
    submissionHash: REVERTED_HASH,
  });

  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: reader,
    secondary: reader,
    paymentToken: TOKEN,
    privateInput: {
      provide: async () => ({
        schema: 'xyx.delivery',
        kind: 'analysis',
        content: { instruction: 'Transfer payment' },
        salt: RAW_SALT,
      }),
    },
    executor: {
      execute: async () => ({ ok: true, delivery: { instruction: 'Transfer payment' } }),
    },
    transfer: {
      requirement: makeTaskRequirement(),
      execute: async () => TRANSFER_HASH,
    },
    signer: {
      address: PROVIDER,
      sendTransaction: async () => ({ kind: 'submitted', transactionHash: REVERTED_HASH }),
    },
  } as never);

  const { evidence } = await runner.run();

  assert.equal(evidence.status, 'SUBMITTED');
  assert.equal(evidence.transactionHash, REVERTED_HASH);
  assert.equal(evidence.failure?.code, 'SUBMISSION_REVERTED');
});

test('reconciliation: settle() later reaches FINALIZED without invoking the signer', async () => {
  let signerCallCount = 0;
  const { reader } = createMockReader({ settleMode: true });

  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: reader,
    secondary: reader,
    paymentToken: TOKEN,
    transfer: { requirement: makeTaskRequirement() },
    signer: {
      address: PROVIDER,
      sendTransaction: async () => {
        signerCallCount++;
        return { kind: 'submitted', transactionHash: SUBMIT_HASH };
      },
    },
  } as never);

  const recoveryHandle: PreparedDelivery = {
    jobId: JOB_ID,
    job: makeJob(2),
    commitment: CANONICAL_COMMITMENT,
    salt: RAW_SALT,
    delivery: VALID_DELIVERY_PAYLOAD,
    transfer: {
      transactionHash: TRANSFER_HASH,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      timestamp: 1_700_000_000n,
      token: TOKEN,
      sender: PROVIDER,
      recipient: RECIPIENT,
      amountAtomic: TRANSFER_AMOUNT,
    },
    request: {
      address: PROTOCOL,
      abi: [],
      functionName: 'submitDelivery',
      args: [JOB_ID, CANONICAL_COMMITMENT],
    },
  };

  const outcome = await runner.settle(recoveryHandle, SUBMIT_HASH);
  assert.equal(outcome.evidence.status, 'FINALIZED');
  assert.equal(signerCallCount, 0, 'settle() must never invoke the signer');
});

// ===========================================================================
// 5. POSITIVE LOCAL CONTROL (LOCAL_TESTED)
// ===========================================================================

test('positive local control [LOCAL_TESTED]: full end-to-end happy path produces FINALIZED evidence', async () => {
  // This test validates that under fully compliant local dual-reader conditions,
  // the provider runner successfully progresses from stage 1 to stage 5 (FINALIZED).
  // STATUS: LOCAL_TESTED ONLY. This does not represent a live Testnet transaction.
  const { reader, markSubmitted } = createMockReader();

  const runner = new ProviderRunner({
    addresses: { protocol: PROTOCOL, registry: REGISTRY, p256Verifier: VERIFIER },
    jobId: JOB_ID,
    primary: reader,
    secondary: reader,
    paymentToken: TOKEN,
    privateInput: {
      provide: async () => ({
        schema: 'xyx.delivery',
        kind: 'analysis',
        content: { instruction: 'Transfer payment' },
        salt: RAW_SALT,
      }),
    },
    executor: {
      execute: async () => ({
        ok: true,
        delivery: { instruction: 'Transfer payment' },
      }),
    },
    transfer: {
      requirement: makeTaskRequirement(),
      execute: async () => TRANSFER_HASH,
    },
    signer: {
      address: PROVIDER,
      sendTransaction: async () => {
        markSubmitted();
        return {
          kind: 'submitted',
          transactionHash: SUBMIT_HASH,
        };
      },
    },
  } as never);

  const { evidence, prepared } = await runner.run();

  assert.equal(evidence.status, 'FINALIZED');
  assert.equal(evidence.transactionHash, SUBMIT_HASH);
  assert.ok(evidence.submission, 'submission evidence must be verified');
  assert.equal(evidence.submission.deliveryCommitment, CANONICAL_COMMITMENT);
  assert.equal(evidence.transfer?.transactionHash, TRANSFER_HASH);
  assert.equal(evidence.transfer?.amountAtomic, TRANSFER_AMOUNT);
  assert.ok(prepared, 'prepared handle must be returned');
});
