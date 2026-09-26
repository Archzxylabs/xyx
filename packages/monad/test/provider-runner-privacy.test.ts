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

/**
 * Walk every reachable string rather than only the enumerable JSON surface.
 *
 * `JSON.stringify` is not enough for this file's central claim. Error
 * `message`, `name`, and `code` are non-enumerable, so stringifying an Error
 * straight produces `{}` and every leak check silently passes. A privacy test
 * written that way would go green while the runner interpolated the wallet's
 * reason into a public error message — the exact defect this guards.
 */
function collectText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    out.push(value.toString());
    return out;
  }
  if (value instanceof Error) {
    out.push(value.message, value.name);
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') out.push(code);
    const own: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'stack') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) own[key] = descriptor.value;
    }
    collectText(own, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectText(entry, out, depth + 1);
    }
    return out;
  }
  out.push(String(value));
  return out;
}

/** Assert every literal marker and the salt are absent from a whole surface. */
function assertCleanDeep(recorded: unknown, label: string): void {
  const text = collectText(recorded).join('\u0000');
  for (const secret of FORBIDDEN) {
    assert.ok(!text.includes(secret), `${label} leaked ${secret}: ${text.slice(0, 300)}`);
  }
  assert.ok(!text.includes(SALT), `${label} leaked the delivery salt: ${text.slice(0, 300)}`);
}

// A distinctive remote address and authorization header value, because a test
// that searched only for the plaintext would miss a leak whose worst part is
// the credential the wallet echoed back.
const SIGNER_MARKER_URL = 'https://marker.example.invalid/leak-me';
const SIGNER_MARKER_BEARER = 'bearer-MARKER-TOKEN-REVOKE-ME';
const SIGNER_MARKER_PLAINTEXT = 'EXECUTOR-SECRET-not-for-output';

test('a signer that refuses does not put its reason into RunStep or RunEvidence', async () => {
  jobState = fundedJob();
  receiptFor = `0x${'5b'.repeat(32)}`;
  const bothReaders = reader();
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    primary: bothReaders,
    secondary: bothReaders,
    paymentToken: TOKEN as Address,
    transfer: { requirement, execute: async () => `0x${'5b'.repeat(32)}` as Hex },
    // A wallet that quotes the job's own contents and an authorization header
    // back out of its error dialog. Nothing here may survive into public output.
    signer: {
      address: PROVIDER as Address,
      sendTransaction: async () => ({
        kind: 'rejected' as const,
        reason: `wallet refused ${SIGNER_MARKER_URL} after seeing ${SIGNER_MARKER_PLAINTEXT} for ${SIGNER_MARKER_BEARER}`,
      }),
    },
  } as never);

  const { evidence } = await runner.run();
  assert.equal(evidence.status, 'FAILED');
  assert.equal(evidence.failure?.code, 'SEND_FAILED');
  // The code is stable and runner-authored. The step log is public output too:
  // a detail that quoted the wallet would be forwarded by the same integrator.
  assertCleanDeep(evidence.failure, 'RunEvidence.failure from a signer refusal');
  assertCleanDeep(evidence.steps, 'RunEvidence.steps from a signer refusal');
});

test('a collaborator error cause and header do not reach any Error field', async () => {
  // Old behavior: only Error.message was scrubbed, so a cause, a code, or a
  // nested reason still carried the collaborator's URL and header into whatever
  // the integrator logged. JSON.stringify(error) hides those fields, so this
  // walks them explicitly. The thrown Error is constructed here, not by a runner
  // helper.
  jobState = fundedJob();
  const nested = new Error('https://privacy-marker.example.invalid/raw');
  (nested as Error & { code?: string }).code = 'authorization: PRIVACY-HEADER-MARKER';
  const runner = new ProviderRunner({
    ...BASE_CONFIG,
    executor: {
      execute: async () => {
        throw Object.assign(nested, { reason: SECRET_PLAINTEXT.note, salt: SALT });
      },
    },
    primary: reader(),
    secondary: reader(),
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: `0x${'5d'.repeat(32)}` as Hex },
  } as never);

  let thrown: unknown;
  try {
    await runner.prepare();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof RunnerError);
  assert.equal(thrown.code, 'EXECUTION_FAILED');
  assert.equal(thrown.name, 'RunnerError');
  assert.equal((thrown as { cause?: unknown }).cause, undefined);
  assertCleanDeep(thrown, 'RunnerError including cause and code');
  const walked = collectText(thrown).join('\u0000');
  assert.ok(!walked.includes('privacy-marker.example.invalid'));
  assert.ok(!walked.includes('PRIVACY-HEADER-MARKER'));
  assert.ok(!walked.includes('authorization'));
  assert.ok(!walked.includes(SALT));

  // Legitimate control: the same readers and a successful executor still transfer.
  const hash = `0x${'5e'.repeat(32)}`;
  receiptFor = hash;
  const control = new ProviderRunner({
    ...BASE_CONFIG,
    primary: reader(),
    secondary: reader(),
    paymentToken: TOKEN as Address,
    transfer: { requirement, observedTransactionHash: hash as Hex },
  } as never);
  const { evidence, prepared } = await control.prepare();
  assert.equal(evidence.status, 'TRANSFERRED');
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.transfer?.transactionHash, hash);
  assert.equal(prepared?.request.functionName, 'submitDelivery');
  assert.match(prepared?.commitment ?? '', /^0x[0-9a-f]{64}$/);
  assertCleanDeep(evidence, 'legitimate RunEvidence');
  for (const step of evidence.steps) assertCleanDeep(step, `legitimate step ${step.status}`);
});

test('an executor failure reason does not reach RunnerError or RunEvidence', async () => {
  jobState = fundedJob();
  // Make the executor fail with text that carries every marker class, so a
  // leak of any one of them is caught rather than only the obvious plaintext.
  const failingExecutor = new ProviderRunner({
    ...BASE_CONFIG,
    privateInput: {
      provide: async () => ({
        schema: 'xyx.delivery',
        kind: 'analysis',
        content: { terms: SECRET_PLAINTEXT.term, credential: SECRET_PLAINTEXT.credential },
        salt: SALT as Hex,
      }),
    },
    executor: {
      execute: async () => ({
        ok: false as const,
        reason: `task failed: ${SECRET_PLAINTEXT.note} at ${SIGNER_MARKER_URL} for ${SIGNER_MARKER_BEARER}`,
      }),
    },
    primary: reader(),
    secondary: reader(),
    paymentToken: TOKEN as Address,
    transfer: { requirement, execute: async () => `0x${'5c'.repeat(32)}` as Hex },
  } as never);

  let evidence: Awaited<ReturnType<typeof failingExecutor.run>>['evidence'] | undefined;
  let thrown: unknown;
  try {
    ({ evidence } = await failingExecutor.prepare());
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof RunnerError, 'an executor failure must fail the run closed');
  assert.equal((thrown as RunnerError).code, 'EXECUTION_FAILED');
  assertCleanDeep(thrown, 'RunnerError from an executor failure');
  if (evidence !== undefined) assertCleanDeep(evidence, 'RunEvidence from an executor failure');
});
