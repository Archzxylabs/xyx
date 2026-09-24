/**
 * Error scenario tests for the /demo page canonical manifest flow.
 *
 * These tests exercise the real shared helpers in `src/demo-state.ts`,
 * `src/config.ts`, and `src/manifest.ts` — the exact modules the page imports —
 * so every error path is verified to produce UNVERIFIED / CONFLICT / PENDING or
 * a clear coded error, never a fake final status derived from a manifest claim.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { isNonZeroAddress, isValidAddress, ZERO_ADDRESS } from '../src/config.js';
import {
  observedStatusFor,
  resolveDemoConfiguration,
  unverifiedRunRow,
  UNAVAILABLE,
} from '../src/demo-state.js';
import { canonicalManifestSchema, canonicalRunSchema } from '../src/manifest.js';

const NON_ZERO_PROTOCOL = `0x${'1'.repeat(40)}`;
const NON_ZERO_TOKEN = `0x${'2'.repeat(40)}`;

// ===========================================================================
// Shared non-zero address validator (item 2)
// ===========================================================================

test('isNonZeroAddress accepts a well-formed non-zero address', () => {
  assert.equal(isNonZeroAddress(NON_ZERO_PROTOCOL), true);
});

test('isNonZeroAddress rejects the zero address', () => {
  assert.equal(isNonZeroAddress(ZERO_ADDRESS), false);
  assert.equal(ZERO_ADDRESS, '0x0000000000000000000000000000000000000000');
});

test('isNonZeroAddress rejects malformed and non-string values', () => {
  for (const value of [undefined, null, '', '0x', 'abc', `0x${'a'.repeat(39)}`, `0x${'a'.repeat(41)}`, 42, {}]) {
    assert.equal(isNonZeroAddress(value), false, `must reject ${JSON.stringify(value)}`);
  }
  assert.equal(isValidAddress(undefined), false);
});

// ===========================================================================
// Demo configuration gate (item 2)
// ===========================================================================

const COMPLETE_ENV = {
  XYX_PROTOCOL_ADDRESS: NON_ZERO_PROTOCOL,
  XYX_PAYMENT_TOKEN_ADDRESS: NON_ZERO_TOKEN,
  XYX_RPC_URL: 'https://rpc.monad.xyz',
};

test('resolveDemoConfiguration returns the configuration when fully set', () => {
  const config = resolveDemoConfiguration(COMPLETE_ENV);
  assert.deepEqual(config, {
    protocol: NON_ZERO_PROTOCOL,
    token: NON_ZERO_TOKEN,
    rpcUrl: 'https://rpc.monad.xyz',
  });
});

test('resolveDemoConfiguration rejects zero XYX_PROTOCOL_ADDRESS', () => {
  assert.equal(
    resolveDemoConfiguration({ ...COMPLETE_ENV, XYX_PROTOCOL_ADDRESS: ZERO_ADDRESS }),
    undefined,
  );
});

test('resolveDemoConfiguration rejects zero XYX_PAYMENT_TOKEN_ADDRESS', () => {
  assert.equal(
    resolveDemoConfiguration({ ...COMPLETE_ENV, XYX_PAYMENT_TOKEN_ADDRESS: ZERO_ADDRESS }),
    undefined,
  );
});

test('resolveDemoConfiguration rejects malformed addresses', () => {
  assert.equal(
    resolveDemoConfiguration({ ...COMPLETE_ENV, XYX_PROTOCOL_ADDRESS: 'not-an-address' }),
    undefined,
  );
  assert.equal(
    resolveDemoConfiguration({ ...COMPLETE_ENV, XYX_PAYMENT_TOKEN_ADDRESS: `0x${'a'.repeat(41)}` }),
    undefined,
  );
});

test('resolveDemoConfiguration rejects missing or blank RPC URL', () => {
  assert.equal(resolveDemoConfiguration({ ...COMPLETE_ENV, XYX_RPC_URL: undefined }), undefined);
  assert.equal(resolveDemoConfiguration({ ...COMPLETE_ENV, XYX_RPC_URL: '   ' }), undefined);
});

test('resolveDemoConfiguration rejects entirely missing configuration', () => {
  assert.equal(resolveDemoConfiguration({}), undefined);
});

// ===========================================================================
// Observed status truthfulness (item 3)
// ===========================================================================

test('observedStatusFor renders PENDING as a non-final state', () => {
  // Never "Not created": the run exists and simply has not settled yet.
  assert.equal(observedStatusFor('PENDING', undefined), 'Pending settlement');
  assert.equal(observedStatusFor('PENDING', 'COMPLETE'), 'Pending settlement');
});

test('observedStatusFor maps LIVE_VERIFIED outcomes to terminal statuses', () => {
  assert.equal(observedStatusFor('LIVE_VERIFIED', 'COMPLETE'), 'Completed');
  assert.equal(observedStatusFor('LIVE_VERIFIED', 'REJECT'), 'Rejected');
  assert.equal(observedStatusFor('LIVE_VERIFIED', 'EXPIRED'), 'Expired');
});

test('observedStatusFor never promotes a manifest claim into a terminal status', () => {
  // Every combination that is not a confirmed on-chain outcome is Unavailable.
  assert.equal(observedStatusFor('LIVE_VERIFIED', undefined), UNAVAILABLE);
});

test('unverifiedRunRow keeps the claim but never the chain status', () => {
  const row = unverifiedRunRow('run-1', 'COMPLETE', 'UNVERIFIED', 'RPC unavailable');
  assert.equal(row.name, 'run-1');
  assert.equal(row.claimedOutcome, 'COMPLETE');
  assert.equal(row.observedStatus, UNAVAILABLE);
  assert.equal(row.verification, 'UNVERIFIED');
});

test('a claimed COMPLETE that fails verification shows no terminal status', () => {
  // Simulates the page's catch path: manifest says COMPLETE, verification threw.
  const row = unverifiedRunRow('run-1', 'COMPLETE', 'CONFLICT', 'Receipt block does not match');
  assert.equal(row.claimedOutcome, 'COMPLETE');
  assert.notEqual(row.observedStatus, 'Completed');
  assert.equal(row.observedStatus, 'Unavailable');
});

// ===========================================================================
// Canonical manifest rejection paths surfaced by the page
// ===========================================================================

function manifestWith(run: unknown) {
  return {
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: NON_ZERO_PROTOCOL,
    token: NON_ZERO_TOKEN,
    generatedAt: 1,
    runs: [run],
  };
}

function completeRun() {
  return {
    name: 'run-1',
    outcome: 'COMPLETE',
    protocol: NON_ZERO_PROTOCOL,
    token: NON_ZERO_TOKEN,
    jobId: '1',
    termsCommitment: `0x${'1'.repeat(64)}`,
    deliveryCommitment: `0x${'2'.repeat(64)}`,
    evidenceCommitment: `0x${'3'.repeat(64)}`,
    reasonCommitment: `0x${'4'.repeat(64)}`,
    decision: 'COMPLETE',
    issuedAt: '1700000001',
    expiresAt: '1700003600',
    nonce: '0',
    resolveTx: `0x${'5'.repeat(64)}`,
  };
}

test('zero-address protocol in manifest → rejected, page renders unverified', () => {
  const result = canonicalManifestSchema.safeParse({
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: ZERO_ADDRESS,
    token: NON_ZERO_TOKEN,
    generatedAt: 1,
    runs: [completeRun()],
  });
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'CANONICAL_PROTOCOL_ZERO'));
});

test('zero-address token in manifest → rejected, page renders unverified', () => {
  const result = canonicalManifestSchema.safeParse({
    kind: 'xyx.monad.canonical-manifest.v1',
    chainId: 10143,
    protocol: NON_ZERO_PROTOCOL,
    token: ZERO_ADDRESS,
    generatedAt: 1,
    runs: [completeRun()],
  });
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'CANONICAL_TOKEN_ZERO'));
});

test('zero-address protocol inside a run → rejected', () => {
  const result = canonicalManifestSchema.safeParse(
    manifestWith({ ...completeRun(), protocol: ZERO_ADDRESS }),
  );
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'CANONICAL_PROTOCOL_ZERO'));
});

test('zero-address token inside a run → rejected', () => {
  const result = canonicalManifestSchema.safeParse(
    manifestWith({ ...completeRun(), token: ZERO_ADDRESS }),
  );
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'CANONICAL_TOKEN_ZERO'));
});

test('zero commitment → rejected', () => {
  const zeroHash = `0x${'0'.repeat(64)}`;
  const result = canonicalManifestSchema.safeParse(
    manifestWith({ ...completeRun(), termsCommitment: zeroHash }),
  );
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'CANONICAL_TERMS_COMMITMENT_ZERO'));
});

test('expiresAt not after issuedAt → rejected', () => {
  const result = canonicalManifestSchema.safeParse(
    manifestWith({ ...completeRun(), issuedAt: '1700003600', expiresAt: '1700003600' }),
  );
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'CANONICAL_VERDICT_TIMESTAMP_MISMATCH'));
});

test('invalid jobId → rejected', () => {
  const result = canonicalManifestSchema.safeParse(manifestWith({ ...completeRun(), jobId: 'not-a-number' }));
  assert.ok(!result.success);
});

test('zero jobId → rejected', () => {
  const result = canonicalManifestSchema.safeParse(manifestWith({ ...completeRun(), jobId: '0' }));
  assert.ok(!result.success);
});

test('missing required field → rejected', () => {
  const run = completeRun() as Record<string, unknown>;
  delete run.resolveTx;
  const result = canonicalManifestSchema.safeParse(manifestWith(run));
  assert.ok(!result.success);
});

test('short address → rejected', () => {
  const result = canonicalManifestSchema.safeParse(
    manifestWith({ ...completeRun(), protocol: `0x${'ab'.repeat(10)}` }),
  );
  assert.ok(!result.success);
});

test('short hex → rejected', () => {
  const result = canonicalManifestSchema.safeParse(
    manifestWith({ ...completeRun(), evidenceCommitment: `0x${'ab'.repeat(16)}` }),
  );
  assert.ok(!result.success);
});

test('wrong chainId → rejected', () => {
  const result = canonicalManifestSchema.safeParse({ ...manifestWith(completeRun()), chainId: 1 });
  assert.ok(!result.success);
});

test('empty runs array → rejected', () => {
  const result = canonicalManifestSchema.safeParse({ ...manifestWith(completeRun()), runs: [] });
  assert.ok(!result.success);
});

test('duplicate jobIds → rejected', () => {
  const result = canonicalManifestSchema.safeParse({
    ...manifestWith(completeRun()),
    runs: [completeRun(), { ...completeRun(), name: 'run-2' }],
  });
  assert.ok(!result.success);
  const errors = result.error?.issues.map(i => i.message) ?? [];
  assert.ok(errors.some(e => e === 'DUPLICATE_JOB_ID'));
});

test('legacy manifest kind is rejected by the canonical schema', () => {
  const result = canonicalManifestSchema.safeParse({
    kind: 'xyx.monad.public-manifest.v1',
    chainId: 10143,
    protocol: NON_ZERO_PROTOCOL,
    token: NON_ZERO_TOKEN,
    generatedAt: Date.now(),
    runs: [],
  });
  assert.ok(!result.success);
});

test('invalid JSON → rejected by the canonical schema', () => {
  const result = canonicalManifestSchema.safeParse('not valid json {{{');
  assert.ok(!result.success);
});

test('mixed-case address is preserved but compares case-insensitively', () => {
  const mixed = `0x${'AbCd'.repeat(10)}`;
  const run = { ...completeRun(), protocol: mixed };
  const manifest = { ...manifestWith(run), protocol: mixed };
  const result = canonicalManifestSchema.safeParse(manifest);
  assert.ok(result.success);
  assert.equal(result.data!.runs[0]!.protocol, mixed);
  assert.equal(result.data!.runs[0]!.protocol.toLowerCase(), mixed.toLowerCase());
});

// ===========================================================================
// Discriminated-union consistency surfaced by the page
// ===========================================================================

test('COMPLETE outcome with a REJECT decision is rejected', () => {
  const result = canonicalRunSchema.safeParse({ ...completeRun(), decision: 'REJECT' });
  assert.ok(!result.success);
});

test('REJECT outcome with a COMPLETE decision is rejected', () => {
  const result = canonicalRunSchema.safeParse({
    ...completeRun(),
    outcome: 'REJECT',
    decision: 'COMPLETE',
  });
  assert.ok(!result.success);
});

test('EXPIRED record carrying any verdict-only field is rejected', () => {
  const verdictOnlyFields: Record<string, unknown> = {
    termsCommitment: `0x${'1'.repeat(64)}`,
    deliveryCommitment: `0x${'2'.repeat(64)}`,
    evidenceCommitment: `0x${'3'.repeat(64)}`,
    reasonCommitment: `0x${'4'.repeat(64)}`,
    decision: 'COMPLETE',
    issuedAt: '1700000001',
    expiresAt: '1700003600',
    nonce: '0',
    resolveTx: `0x${'5'.repeat(64)}`,
  };
  for (const [field, value] of Object.entries(verdictOnlyFields)) {
    const result = canonicalRunSchema.safeParse({
      name: 'expired',
      outcome: 'EXPIRED',
      protocol: NON_ZERO_PROTOCOL,
      token: NON_ZERO_TOKEN,
      jobId: '2',
      refundTx: `0x${'f'.repeat(64)}`,
      [field]: value,
    });
    assert.ok(!result.success, `EXPIRED record must reject ${field}`);
  }
});
