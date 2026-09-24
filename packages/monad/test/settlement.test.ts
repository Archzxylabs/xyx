/**
 * Tests for canonical settlement verification (XYXDeliveryProtocol).
 *
 * Uses the canonical 3-arg verifySettlement API with CanonicalChainReader.
 * All reads are from the protocol address; no legacy commerce/evaluator.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from 'viem';
import { deliveryProtocolAbi } from '../src/protocol.js';
import { verifySettlement, CANONICAL_JOB_STATUS } from '../src/settlement.js';
import { type CanonicalChainReader, type CanonicalFinalizedBlock, validateJobData } from '../src/canonical-chain.js';
import type { JobData, JobVerdictData } from '../src/protocol.js';
import { hashVerdictDigest } from '../src/verdict.js';
import { canonicalManifestSchema, canonicalRunSchema } from '../src/manifest.js';

const protocol = '0x0000000000000000000000000000000000000001' as Address;
const token = '0x0000000000000000000000000000000000000002' as Address;
const buyer = '0x0000000000000000000000000000000000000003' as Address;
const provider = '0x0000000000000000000000000000000000000004' as Address;
const attestor = '0x0000000000000000000000000000000000000005' as Address;
const blockHash = `0x${'a'.repeat(64)}` as Hex;
const zeroHash = `0x${'0'.repeat(64)}` as Hex;
const evidenceHash = `0x${'e'.repeat(64)}` as Hex;
const reasonHash = `0x${'f'.repeat(64)}` as Hex;

const baseJob: JobData = {
  buyer,
  provider,
  attestor,
  termsCommitment: `0x${'1'.repeat(64)}` as Hex,
  deliveryCommitment: `0x${'2'.repeat(64)}` as Hex,
  budget: 20_000n,
  expiresAt: 3_000_000_000n,
  status: CANONICAL_JOB_STATUS.Funded,
};

function event(address: Address, abi: unknown, eventName: string, args: Record<string, unknown>, data: Hex) {
  return { address, data, topics: encodeEventTopics({ abi, eventName, args } as never) as [Hex, ...Hex[]] };
}
function transfer(from: Address, to: Address, value: bigint): { address: Address; data: Hex; topics: [Hex, ...Hex[]] } {
  return event(token, erc20Abi, 'Transfer', { from, to }, encodeAbiParameters([{ type: 'uint256' }], [value]));
}

function buildResolverEventLogs(
  decision: 1 | 2,
  jobId: bigint,
  to: Address,
  verdict: JobVerdictData
): { address: Address; data: Hex; topics: [Hex, ...Hex[]] }[] {
  const computedDigest = hashVerdictDigest(verdict, protocol, 10143);
  return [
    event(protocol, deliveryProtocolAbi, 'JobResolved', { jobId, attestor, verdictDigest: computedDigest },
      encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], [decision, evidenceHash, reasonHash])),
    transfer(protocol, decision === 1 ? provider : buyer, baseJob.budget),
  ];
}

function makeReader(
  jobOverrides: Partial<JobData> = {},
  receipts: Record<Hex, { to: Address; logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] }[]; timestamp?: bigint }> = {},
  blockNumber = 100n,
  blockTimestamp = 2_000_000_100n
): CanonicalChainReader {
  const job = { ...baseJob, ...jobOverrides };
  return {
    getChainId: async () => 10143,
    getBlock: async (args) => {
      const bn = 'blockTag' in args ? blockNumber : (args as { blockNumber: bigint }).blockNumber;
      return { number: bn, hash: blockHash, timestamp: blockTimestamp };
    },
    getTransaction: async ({ hash }) => ({ hash, from: buyer, to: receipts[hash]?.to ?? protocol, input: '0x', blockNumber, blockHash }),
    getTransactionReceipt: async ({ hash }) => ({
      transactionHash: hash,
      blockNumber,
      blockHash,
      status: 'success' as const,
      to: receipts[hash]?.to ?? protocol,
      logs: receipts[hash]?.logs ?? [],
    }),
    readContract: async (args) => {
      if (args.address === protocol && args.functionName === 'getJob') {
        return validateJobData(job);
      }
      throw new Error(`UNEXPECTED_READCONTRACT: ${args.functionName} at ${args.address}`);
    },
  };
}

// ===========================================================================
// Canonical settlement tests
// ===========================================================================

test('LIVE_VERIFIED for complete settlement with dual RPC', async () => {
  const resolveTx = `0x${'c'.repeat(64)}` as Hex;
  const verdict: JobVerdictData = {
    jobId: 1n,
    termsCommitment: baseJob.termsCommitment,
    deliveryCommitment: baseJob.deliveryCommitment,
    evidenceCommitment: evidenceHash,
    reasonCommitment: reasonHash,
    decision: 1,
    issuedAt: 2_900_000_000n,
    expiresAt: baseJob.expiresAt,
    nonce: 7n,
  };
  const primary = makeReader({ status: CANONICAL_JOB_STATUS.Completed }, {
    [resolveTx]: { to: protocol, logs: buildResolverEventLogs(1, 1n, protocol, verdict) },
  });
  const secondary = makeReader({ status: CANONICAL_JOB_STATUS.Completed }, {
    [resolveTx]: { to: protocol, logs: buildResolverEventLogs(1, 1n, protocol, verdict) },
  });

  const result = await verifySettlement(primary, secondary, {
    protocol,
    token,
    jobId: 1n,
    verdict,
    resolveTx,
  });
  assert.equal(result.state, 'LIVE_VERIFIED');
  assert.equal(result.outcome, 'COMPLETE');
  assert.equal(result.recipient, provider);
  assert.equal(result.amount, 20_000n);
});

test('REJECT for settlement rejection with dual RPC', async () => {
  const resolveTx = `0x${'d'.repeat(64)}` as Hex;
  const verdict: JobVerdictData = {
    jobId: 1n,
    termsCommitment: baseJob.termsCommitment,
    deliveryCommitment: baseJob.deliveryCommitment,
    evidenceCommitment: evidenceHash,
    reasonCommitment: reasonHash,
    decision: 2,
    issuedAt: 2_900_000_000n,
    expiresAt: baseJob.expiresAt,
    nonce: 7n,
  };
  const primary = makeReader({ status: CANONICAL_JOB_STATUS.Rejected }, {
    [resolveTx]: { to: protocol, logs: buildResolverEventLogs(2, 1n, protocol, verdict) },
  });
  const secondary = makeReader({ status: CANONICAL_JOB_STATUS.Rejected }, {
    [resolveTx]: { to: protocol, logs: buildResolverEventLogs(2, 1n, protocol, verdict) },
  });

  const result = await verifySettlement(primary, secondary, {
    protocol,
    token,
    jobId: 1n,
    verdict,
    resolveTx,
  });
  assert.equal(result.state, 'REJECT');
  assert.equal(result.outcome, 'REJECT');
  assert.equal(result.recipient, buyer);
});

test('EXPIRED for expired job with refund tx', async () => {
  const refundTx = `0x${'f'.repeat(64)}` as Hex;
  const now = 3_000_000_001n;
  const blockTimestamp = 3_000_000_002n; // >= job.expiresAt (3_000_000_000n)
  const primary = makeReader(
    { status: CANONICAL_JOB_STATUS.Expired, expiresAt: 3_000_000_000n },
    {
      [refundTx]: {
        to: protocol,
        logs: [
          event(protocol, deliveryProtocolAbi, 'JobExpired', { jobId: 1n, buyer, budget: 20_000n },
            encodeAbiParameters([{ type: 'uint256' }], [20_000n])),
          transfer(protocol, buyer, 20_000n),
        ],
        timestamp: now,
      },
    },
    100n,
    blockTimestamp
  );
  const secondary = makeReader(
    { status: CANONICAL_JOB_STATUS.Expired, expiresAt: 3_000_000_000n },
    {
      [refundTx]: {
        to: protocol,
        logs: [
          event(protocol, deliveryProtocolAbi, 'JobExpired', { jobId: 1n, buyer, budget: 20_000n },
            encodeAbiParameters([{ type: 'uint256' }], [20_000n])),
          transfer(protocol, buyer, 20_000n),
        ],
        timestamp: now,
      },
    },
    100n,
    blockTimestamp
  );

  const result = await verifySettlement(primary, secondary, {
    protocol,
    token,
    jobId: 1n,
    refundTx,
  });
  assert.equal(result.state, 'LIVE_VERIFIED');
  assert.equal(result.outcome, 'EXPIRED');
  assert.equal(result.recipient, buyer);
});

test('PENDING for unfunded job', async () => {
  const primary = makeReader({ status: CANONICAL_JOB_STATUS.Funded });
  const result = await verifySettlement(primary, undefined, { protocol, token, jobId: 1n });
  assert.equal(result.state, 'PENDING');
});

test('REJECT for zero-address protocol', async () => {
  const primary = makeReader();
  await assert.rejects(
    verifySettlement(primary, undefined, { protocol: '0x0000000000000000000000000000000000000000' as Address, token, jobId: 1n }),
    /SETTLEMENT_PROTOCOL_REQUIRED/
  );
});

test('REJECT for zero-address token', async () => {
  const primary = makeReader();
  await assert.rejects(
    verifySettlement(primary, undefined, { protocol, token: '0x0000000000000000000000000000000000000000' as Address, jobId: 1n }),
    /SETTLEMENT_TOKEN_REQUIRED/
  );
});

test('REJECT for verdict without evidence commitment', async () => {
  const resolveTx = `0x${'c'.repeat(64)}` as Hex;
  const primary = makeReader({ status: CANONICAL_JOB_STATUS.Completed }, {
    [resolveTx]: { to: protocol, logs: buildResolverEventLogs(1, 1n, protocol, {
      ...baseJob,
      jobId: 1n,
      evidenceCommitment: evidenceHash,
      reasonCommitment: reasonHash,
      decision: 1,
      issuedAt: 2_900_000_000n,
      expiresAt: baseJob.expiresAt,
      nonce: 7n,
    } as JobVerdictData) },
  });
  const verdict: JobVerdictData = {
    jobId: 1n,
    termsCommitment: baseJob.termsCommitment,
    deliveryCommitment: baseJob.deliveryCommitment,
    evidenceCommitment: zeroHash,
    reasonCommitment: reasonHash,
    decision: 1,
    issuedAt: 2_900_000_000n,
    expiresAt: baseJob.expiresAt,
    nonce: 7n,
  };
  await assert.rejects(
    verifySettlement(primary, primary, { protocol, token, jobId: 1n, verdict, resolveTx }),
    /CANONICAL_EVENT_VERDICT_DIGEST_MISMATCH/
  );
});

// ===========================================================================
// Canonical manifest schema tests
// ===========================================================================

test('canonicalManifestSchema rejects zero protocol address', () => {
  const manifest = {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000000',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [],
  };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'CANONICAL_PROTOCOL_ZERO'));
});

test('canonicalManifestSchema rejects zero token address', () => {
  const manifest = {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000000',
    generatedAt: 1,
    runs: [],
  };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'CANONICAL_TOKEN_ZERO'));
});

test('canonicalManifestSchema rejects run protocol mismatch', () => {
  const manifest = {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [{
      name: 'run1',
      outcome: 'COMPLETE',
      protocol: '0x0000000000000000000000000000000000000003',
      token: '0x0000000000000000000000000000000000000002',
      jobId: '1',
      termsCommitment: `0x${'1'.repeat(64)}`,
      deliveryCommitment: `0x${'2'.repeat(64)}`,
      evidenceCommitment: `0x${'3'.repeat(64)}`,
      reasonCommitment: `0x${'4'.repeat(64)}`,
      decision: 'COMPLETE',
      issuedAt: '100',
      expiresAt: '200',
      nonce: '0',
      resolveTx: `0x${'5'.repeat(64)}`,
    }],
  };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'RUN_PROTOCOL_MISMATCH'));
});

test('canonicalManifestSchema rejects run token mismatch', () => {
  const manifest = {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [{
      name: 'run1',
      outcome: 'COMPLETE',
      protocol: '0x0000000000000000000000000000000000000001',
      token: '0x0000000000000000000000000000000000000003',
      jobId: '1',
      termsCommitment: `0x${'1'.repeat(64)}`,
      deliveryCommitment: `0x${'2'.repeat(64)}`,
      evidenceCommitment: `0x${'3'.repeat(64)}`,
      reasonCommitment: `0x${'4'.repeat(64)}`,
      decision: 'COMPLETE',
      issuedAt: '100',
      expiresAt: '200',
      nonce: '0',
      resolveTx: `0x${'5'.repeat(64)}`,
    }],
  };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'RUN_TOKEN_MISMATCH'));
});

test('canonicalManifestSchema accepts valid COMPLETE run', () => {
  const manifest = {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [{
      name: 'good',
      outcome: 'COMPLETE',
      protocol: '0x0000000000000000000000000000000000000001',
      token: '0x0000000000000000000000000000000000000002',
      jobId: '1',
      termsCommitment: `0x${'1'.repeat(64)}`,
      deliveryCommitment: `0x${'2'.repeat(64)}`,
      evidenceCommitment: `0x${'3'.repeat(64)}`,
      reasonCommitment: `0x${'4'.repeat(64)}`,
      decision: 'COMPLETE',
      issuedAt: '100',
      expiresAt: '200',
      nonce: '0',
      resolveTx: `0x${'5'.repeat(64)}`,
    }],
  };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(result.success);
});

test('canonicalManifestSchema accepts valid EXPIRED run without verdict fields', () => {
  const manifest = {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [{
      name: 'expired',
      outcome: 'EXPIRED',
      protocol: '0x0000000000000000000000000000000000000001',
      token: '0x0000000000000000000000000000000000000002',
      jobId: '2',
      refundTx: `0x${'f'.repeat(64)}`,
    }],
  };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(result.success);
  const run = result.data!.runs[0]!;
  assert.equal(run.outcome, 'EXPIRED');
});

test('canonicalManifestSchema rejects EXPIRED run with verdict placeholders', () => {
  const manifest = {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [{
      name: 'bad-expiry',
      outcome: 'EXPIRED',
      protocol: '0x0000000000000000000000000000000000000001',
      token: '0x0000000000000000000000000000000000000002',
      jobId: '3',
      refundTx: `0x${'f'.repeat(64)}`,
      termsCommitment: `0x${'1'.repeat(64)}`,
      decision: 'COMPLETE',
      resolveTx: `0x${'5'.repeat(64)}`,
    }],
  };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(!result.success);
});

test('canonicalManifestSchema retains duplicate job/name guards', () => {
  const manifest = {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [
      {
        name: 'run1',
        outcome: 'COMPLETE',
        protocol: '0x0000000000000000000000000000000000000001',
        token: '0x0000000000000000000000000000000000000002',
        jobId: '1',
        termsCommitment: `0x${'1'.repeat(64)}`,
        deliveryCommitment: `0x${'2'.repeat(64)}`,
        evidenceCommitment: `0x${'3'.repeat(64)}`,
        reasonCommitment: `0x${'4'.repeat(64)}`,
        decision: 'COMPLETE',
        issuedAt: '100',
        expiresAt: '200',
        nonce: '0',
        resolveTx: `0x${'5'.repeat(64)}`,
      },
      {
        name: 'run1',
        outcome: 'COMPLETE',
        protocol: '0x0000000000000000000000000000000000000001',
        token: '0x0000000000000000000000000000000000000002',
        jobId: '2',
        termsCommitment: `0x${'a'.repeat(64)}`,
        deliveryCommitment: `0x${'b'.repeat(64)}`,
        evidenceCommitment: `0x${'c'.repeat(64)}`,
        reasonCommitment: `0x${'d'.repeat(64)}`,
        decision: 'COMPLETE',
        issuedAt: '100',
        expiresAt: '200',
        nonce: '0',
        resolveTx: `0x${'e'.repeat(64)}`,
      },
    ],
  };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'DUPLICATE_RUN_NAME'));
});

test('canonicalManifestSchema accepts valid REJECT run', () => {
  const manifest = {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [{
      name: 'reject',
      outcome: 'REJECT',
      protocol: '0x0000000000000000000000000000000000000001',
      token: '0x0000000000000000000000000000000000000002',
      jobId: '3',
      termsCommitment: `0x${'1'.repeat(64)}`,
      deliveryCommitment: `0x${'2'.repeat(64)}`,
      evidenceCommitment: `0x${'3'.repeat(64)}`,
      reasonCommitment: `0x${'4'.repeat(64)}`,
      decision: 'REJECT',
      issuedAt: '100',
      expiresAt: '200',
      nonce: '0',
      resolveTx: `0x${'5'.repeat(64)}`,
    }],
  };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(result.success);
  const run = result.data!.runs[0]!;
  assert.equal(run.outcome, 'REJECT');
  assert.equal(run.decision, 'REJECT');
});

// ---------------------------------------------------------------------------
// Discriminated-union consistency (item 1)
// ---------------------------------------------------------------------------

test('canonicalRunSchema rejects COMPLETE outcome carrying a REJECT decision', () => {
  const result = canonicalRunSchema.safeParse({
    name: 'mismatch',
    outcome: 'COMPLETE',
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    jobId: '1',
    termsCommitment: `0x${'1'.repeat(64)}`,
    deliveryCommitment: `0x${'2'.repeat(64)}`,
    evidenceCommitment: `0x${'3'.repeat(64)}`,
    reasonCommitment: `0x${'4'.repeat(64)}`,
    decision: 'REJECT',
    issuedAt: '100',
    expiresAt: '200',
    nonce: '0',
    resolveTx: `0x${'5'.repeat(64)}`,
  });
  assert.ok(!result.success);
});

test('canonicalRunSchema rejects REJECT outcome carrying a COMPLETE decision', () => {
  const result = canonicalRunSchema.safeParse({
    name: 'mismatch',
    outcome: 'REJECT',
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    jobId: '1',
    termsCommitment: `0x${'1'.repeat(64)}`,
    deliveryCommitment: `0x${'2'.repeat(64)}`,
    evidenceCommitment: `0x${'3'.repeat(64)}`,
    reasonCommitment: `0x${'4'.repeat(64)}`,
    decision: 'COMPLETE',
    issuedAt: '100',
    expiresAt: '200',
    nonce: '0',
    resolveTx: `0x${'5'.repeat(64)}`,
  });
  assert.ok(!result.success);
});

test('canonicalRunSchema rejects EXPIRED record carrying any verdict-only field', () => {
  // Every field that exists only on the COMPLETE/REJECT verdict variants.
  const verdictOnlyFields: Record<string, string> = {
    termsCommitment: `0x${'1'.repeat(64)}`,
    deliveryCommitment: `0x${'2'.repeat(64)}`,
    evidenceCommitment: `0x${'3'.repeat(64)}`,
    reasonCommitment: `0x${'4'.repeat(64)}`,
    decision: 'COMPLETE',
    issuedAt: '100',
    expiresAt: '200',
    nonce: '0',
    resolveTx: `0x${'5'.repeat(64)}`,
  };
  for (const [field, value] of Object.entries(verdictOnlyFields)) {
    const result = canonicalRunSchema.safeParse({
      name: 'expired-with-verdict-field',
      outcome: 'EXPIRED',
      protocol: '0x0000000000000000000000000000000000000001',
      token: '0x0000000000000000000000000000000000000002',
      jobId: '4',
      refundTx: `0x${'f'.repeat(64)}`,
      [field]: value,
    });
    assert.ok(!result.success, `EXPIRED record must reject ${field}`);
  }
});

test('canonicalRunSchema narrows outcome to the matching variant', () => {
  const expired = canonicalRunSchema.parse({
    name: 'expired',
    outcome: 'EXPIRED',
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    jobId: '4',
    refundTx: `0x${'f'.repeat(64)}`,
  });
  // The EXPIRED variant is structurally barred from every verdict-only field.
  assert.equal('termsCommitment' in expired, false);
  assert.equal('decision' in expired, false);
  assert.equal('nonce' in expired, false);
  assert.equal('resolveTx' in expired, false);
  if (expired.outcome !== 'EXPIRED') throw new Error('expected EXPIRED variant');
  assert.equal(expired.refundTx, `0x${'f'.repeat(64)}`);
});

// ---------------------------------------------------------------------------
// Relocated cross-field verdict checks
// ---------------------------------------------------------------------------

function completeRun(overrides: Record<string, unknown> = {}) {
  return {
    name: 'run',
    outcome: 'COMPLETE',
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    jobId: '1',
    termsCommitment: `0x${'1'.repeat(64)}`,
    deliveryCommitment: `0x${'2'.repeat(64)}`,
    evidenceCommitment: `0x${'3'.repeat(64)}`,
    reasonCommitment: `0x${'4'.repeat(64)}`,
    decision: 'COMPLETE',
    issuedAt: '100',
    expiresAt: '200',
    nonce: '0',
    resolveTx: `0x${'5'.repeat(64)}`,
    ...overrides,
  };
}

test('canonicalManifestSchema rejects expiresAt not after issuedAt', () => {
  const result = canonicalManifestSchema.safeParse({
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [completeRun({ issuedAt: '200', expiresAt: '200' })],
  });
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'CANONICAL_VERDICT_TIMESTAMP_MISMATCH'));
});

test('canonicalManifestSchema rejects zero commitments on COMPLETE and REJECT runs', () => {
  const zeroHash = `0x${'0'.repeat(64)}`;
  const cases: Array<[string, string]> = [
    ['termsCommitment', 'CANONICAL_TERMS_COMMITMENT_ZERO'],
    ['deliveryCommitment', 'CANONICAL_DELIVERY_COMMITMENT_ZERO'],
    ['evidenceCommitment', 'CANONICAL_EVIDENCE_COMMITMENT_ZERO'],
    ['reasonCommitment', 'CANONICAL_REASON_COMMITMENT_ZERO'],
  ];
  for (const [field, message] of cases) {
    for (const decision of ['COMPLETE', 'REJECT'] as const) {
      const result = canonicalManifestSchema.safeParse({
        kind: 'xyx.monad.canonical-manifest.v1',
        chainId: 10143,
        protocol: '0x0000000000000000000000000000000000000001',
        token: '0x0000000000000000000000000000000000000002',
        generatedAt: 1,
        runs: [completeRun({ [field]: zeroHash, outcome: decision, decision })],
      });
      assert.ok(!result.success, `${decision} run must reject zero ${field}`);
      const errors = result.error?.issues.map(i => i.message) ?? [];
      assert.ok(errors.some(e => e === message), `${decision} run must report ${message}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Shared non-zero address validator (item 2)
// ---------------------------------------------------------------------------

test('canonicalManifestSchema rejects zero run protocol and token', () => {
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  const runZeroProtocol = canonicalManifestSchema.safeParse({
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [completeRun({ protocol: zeroAddress })],
  });
  assert.ok(!runZeroProtocol.success);
  assert.ok((runZeroProtocol.error?.issues.map(i => i.message) ?? []).some(e => e === 'CANONICAL_PROTOCOL_ZERO'));

  const runZeroToken = canonicalManifestSchema.safeParse({
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: '0x0000000000000000000000000000000000000001',
    token: '0x0000000000000000000000000000000000000002',
    generatedAt: 1,
    runs: [completeRun({ token: zeroAddress })],
  });
  assert.ok(!runZeroToken.success);
  assert.ok((runZeroToken.error?.issues.map(i => i.message) ?? []).some(e => e === 'CANONICAL_TOKEN_ZERO'));
});
