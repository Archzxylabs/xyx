/**
 * Privacy guarantees of the runner's public output.
 *
 * The runner is handed the provider's most sensitive bytes: the delivery
 * plaintext, the salt, the executor's raw result, and the private terms behind
 * `termsCommitment`. Every one of those must be absent from what the runner
 * hands back — `RunEvidence`, `RunnerError`, and the step log — because an
 * integrator will reasonably persist and forward that object.
 *
 * These tests do not assert that an object is impossible to stringify. They
 * assert what the runner itself never puts into its output, which is the actual
 * promise (see `PrivateDeliveryMaterial` in adapters.ts). They deliberately
 * search for the literal plaintext values, so a future change that interpolates
 * executor output into an error message fails here rather than in production.
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

// Marker values that must never appear in public output. Distinctive strings,
// because a test that searched for something generic like "note" would pass
// vacuously.
const SECRET_PLAINTEXT = {
  term: 'PRIVATE-TERM-d0-not-publish',
  note: 'EXECUTOR-SECRET-not-for-output',
  credential: 'bearer-SECRET-TOKEN-REVOKE-ME',
};

const SALT = `0x${'cd'.repeat(32)}`;
const JOB_ID = 11n;
/** A well-formed hash no reader resolves, for cases that must fail earlier. */
const UNOBSERVED_HASH = `0x${'aa'.repeat(32)}` as Hex;

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
      content: {
        terms: SECRET_PLAINTEXT.term,
        credential: SECRET_PLAINTEXT.credential,
      },
      salt: SALT as Hex,
    }),
  },
  executor: {
    execute: async () => ({
      ok: true as const,
      delivery: { note: SECRET_PLAINTEXT.note, score: 9 },
    }),
  },
};

let jobState = fundedJob();

/** Receipt carrying a valid task transfer for the supplied hash. */
function transferReceipt(hash: string) {
  return {
    transactionHash: hash,
    blockNumber: 600n,
    blockHash: `0x${'22'.repeat(32)}`,
    status: 'success' as const,
    to: TOKEN,
    logs: [transferLog(TOKEN as Address, PROVIDER as Address, BUYER as Address, 25_000_000n)],
  };
}

let receiptFor = `0x${'55'.repeat(32)}`;

function reader(overrides: Record<string, unknown> = {}) {
  return {
    getChainId: async () => 10143,
    getBlock: async () => ({ number: 600n, hash: `0x${'22'.repeat(32)}`, timestamp: 1_700_000_000n }),
    getTransaction: async () => ({
      hash: receiptFor,
      from: PROVIDER,
      to: PROTOCOL,
      input: '0x',
      blockNumber: 600n,
      blockHash: `0x${'22'.repeat(32)}`,
    }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
      hash === receiptFor
        ? transferReceipt(hash)
        : { transactionHash: hash, blockNumber: 600n, blockHash: `0x${'22'.repeat(32)}`, status: 'success' as const, to: PROTOCOL, logs: [] },
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      if (functionName !== 'getJob') throw new Error(`unexpected read: ${functionName}`);
      return blockNumber === undefined ? fundedJob() : jobState;
    },
    ...overrides,
  };
}

const requirement = {
  token: TOKEN as Address,
  recipient: BUYER as Address,
  amountAtomic: 25_000_000n,
};

/** Every literal that must never reach public output. */
const FORBIDDEN = Object.values(SECRET_PLAINTEXT);

function assertClean(recorded: unknown, label: string): void {
  const text = JSON.stringify(recorded, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
  for (const secret of FORBIDDEN) {
    assert.ok(
      !text.includes(secret),
      `${label} leaked ${secret}: ${text.slice(0, 300)}`
    );
  }
  // The salt is 32 bytes of raw hex; if it were interpolated anywhere it would
  // appear verbatim.
  assert.ok(!text.includes(SALT), `${label} leaked the delivery salt`);
}

test('RunEvidence from a successful run carries no private material', async () => {
  jobState = { ...fundedJob(), status: 2 as const, deliveryCommitment: `0x${'00'.repeat(32)}` };
  const hash = `0x${'56'.repeat(32)}`;
  const submitHash = `0x${'57'.repeat(32)}`;
  receiptFor = hash;
  const bothReaders = reader();
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: bothReaders,
    secondary: bothReaders,
    paymentToken: TOKEN as Address,
    transfer: { requirement, execute: async () => hash as Hex },
    signer: {
      address: PROVIDER as Address,
      sendTransaction: async () => ({ kind: 'submitted' as const, transactionHash: submitHash as Hex }),
    },
  } as never);

  const { evidence } = await runner.prepare();
  assert.equal(evidence.status, 'TRANSFERRED');
  assertClean(evidence, 'RunEvidence after prepare()');
  for (const step of evidence.steps) assertClean(step, `RunStep ${step.status}`);
});

test('a failure in stage 2 does not leak the private input or executor output', async () => {
  jobState = fundedJob();
  // The private input is valid but the chain read fails afterwards, so the
  // RunnerError is assembled while the runner is still holding the plaintext
  // and the salt it just validated.
  const failing = reader({
    readContract: async () => {
      throw new Error('getJob reverted on the RPC');
    },
  });
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: failing,
    secondary: failing,
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: UNOBSERVED_HASH },
  } as never);

  await assert.rejects(() => runner.prepare(), (error: unknown) => {
    assert.ok(error instanceof RunnerError);
    assertClean(error, 'RunnerError from failed selection');
    return true;
  });
});

test('an invalid private payload reports a schema error without the content', async () => {
  jobState = fundedJob();
  // Stage 3 must succeed for stage 2's validation to be reached, so this hash
  // resolves to a genuine transfer receipt.
  receiptFor = UNOBSERVED_HASH;
  const readerWithValidReads = reader();
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    // Salt is not 32 bytes, which the canonical schema must reject.
    privateInput: {
      provide: async () => ({
        schema: 'xyx.delivery',
        kind: 'analysis',
        content: { terms: SECRET_PLAINTEXT.term, credential: SECRET_PLAINTEXT.credential },
        salt: '0xdeadbeef' as Hex,
      }),
    },
    primary: readerWithValidReads,
    secondary: readerWithValidReads,
    paymentToken: TOKEN as Address,    transfer: { requirement, observedTransactionHash: UNOBSERVED_HASH },
  } as never);

  await assert.rejects(() => runner.prepare(), (error: unknown) => {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, 'PRIVATE_INPUT_INVALID');
    // The reason is useful, but it must describe the salt's shape, not echo it,
    // and must never echo the plaintext it was supposed to be protecting.
    assertClean(error, 'RunnerError from invalid private input');
    return true;
  });
});

test('the delivery commitment itself is not the plaintext', async () => {
  // The chain must still show the job as undelivered for the runner to build a
  // commitment, so this reads the pre-delivery state rather than a settled one.
  jobState = { ...fundedJob(), deliveryCommitment: `0x${'00'.repeat(32)}` };
  const hash = `0x${'5a'.repeat(32)}`;
  receiptFor = hash;
  const bothReaders = reader();
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: bothReaders,
    secondary: bothReaders,
    paymentToken: TOKEN as Address,
    transfer: { requirement, execute: async () => hash as Hex },
  } as never);

  const { evidence } = await runner.prepare();
  assert.ok(evidence.deliveryCommitment, 'a commitment must exist once the transfer settled');
  // A commitment must be a 32-byte digest, so it cannot contain the plaintext by
  // construction. Stated explicitly here because "hash of the secret" is the
  // whole privacy model and is easy to break by accident.
  assert.match(evidence.deliveryCommitment, /^0x[0-9a-f]{64}$/);
  assertClean(evidence, 'RunEvidence commitment');
});
