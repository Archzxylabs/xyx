/**
 * Tests for canonical delivery schemas and commitment encoding.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';

import {
  privateTermsSchema,
  privateDeliverySchema,
  privateEvidenceSchema,
  privateReasonSchema,
  jobVerdictSchema,
  createTermsCommitment,
  createEvidenceCommitment,
  buildVerdict,
  hashVerdict,
  toSolidityVerdict,
  validateAddress,
  validateChainId,
  validateDeadline,
  assertNoSecretFields,
  isStrictJsonValue,
  strictJsonToCanonicalBytes,
  buildProposalRequest,
  buildFundRequest,
  buildAcceptRequest,
  buildSubmitRequest,
  buildResolveRequest,
  buildClaimExpiryRefundRequest,
  validateSalt,
} from '../src/delivery';

// The exact JSON text a WebAuthn authenticator returns for a `get` assertion.
// `clientDataJSON` is a Solidity `string`, so it reaches the request builder as
// a plain string and must never be Hex-encoded — the registry re-serializes the
// same text when it verifies the P-256 signature.
const REAL_CLIENT_DATA_JSON =
  '{"type":"webauthn.get","challenge":"QUJDRA","origin":"https://xyx.local","crossOrigin":false}';

const TEST_ADDR = '0x' + '12'.repeat(20);

// ===========================================================================
// Schema validation tests
// ===========================================================================

describe('privateTermsSchema', () => {
  it('accepts valid terms', () => {
    const terms = {
      schema: 'xyx.private-terms',
      chainId: 10143,
      protocol: '0x' + 'ab'.repeat(20),
      paymentToken: '0x' + 'cd'.repeat(20),
      buyer: '0x' + 'ef'.repeat(20),
      provider: '0x' + '01'.repeat(20),
      attestor: '0x' + '23'.repeat(20),
      budgetAtomic: '1000000000000000000',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      task: { description: 'test task' },
      acceptancePolicy: { rule: 'threshold:1' },
    };
    const result = privateTermsSchema.safeParse(terms);
    assert.ok(result.success, `should accept valid terms: ${result.error?.message}`);
  });

  it('rejects unknown fields with .strict()', () => {
    const terms = {
      schema: 'xyx.private-terms',
      chainId: 10143,
      protocol: '0x' + 'ab'.repeat(20),
      paymentToken: '0x' + 'cd'.repeat(20),
      buyer: '0x' + 'ef'.repeat(20),
      provider: '0x' + '01'.repeat(20),
      attestor: '0x' + '23'.repeat(20),
      budgetAtomic: '1000000000000000000',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      task: { description: 'test' },
      acceptancePolicy: { rule: 'threshold:1' },
      unexpectedField: 'should fail',
    };
    const result = privateTermsSchema.safeParse(terms);
    assert.ok(!result.success, 'should reject unknown field');
  });

  it('rejects empty task', () => {
    const result = privateTermsSchema.safeParse({
      schema: 'xyx.private-terms',
      chainId: 10143,
      protocol: '0x' + 'ab'.repeat(20),
      paymentToken: '0x' + 'cd'.repeat(20),
      buyer: '0x' + 'ef'.repeat(20),
      provider: '0x' + '01'.repeat(20),
      attestor: '0x' + '23'.repeat(20),
      budgetAtomic: '1000000000000000000',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      task: {},
      acceptancePolicy: { rule: 'threshold:1' },
    });
    assert.ok(!result.success);
  });
});

describe('privateDeliverySchema', () => {
  it('accepts valid delivery', () => {
    const delivery = {
      schema: 'xyx.private-delivery',
      kind: 'artifact',
      content: { description: 'delivered work' },
    };
    const result = privateDeliverySchema.safeParse(delivery);
    assert.ok(result.success);
  });

  it('rejects unknown fields', () => {
    const delivery = {
      schema: 'xyx.private-delivery',
      kind: 'artifact',
      content: { description: 'test' },
      unexpectedField: 'should fail',
    };
    assert.ok(!privateDeliverySchema.safeParse(delivery).success);
  });
});

describe('privateEvidenceSchema', () => {
  it('accepts valid evidence', () => {
    const evidence = {
      schema: 'xyx.private-evidence',
      artifacts: { report: 'looks good' },
    };
    const result = privateEvidenceSchema.safeParse(evidence);
    assert.ok(result.success);
  });

  it('rejects unknown fields', () => {
    const evidence = {
      schema: 'xyx.private-evidence',
      artifacts: { report: 'good' },
      unexpected: true,
    };
    assert.ok(!privateEvidenceSchema.safeParse(evidence).success);
  });
});

describe('privateReasonSchema', () => {
  it('accepts valid reason', () => {
    const reason = {
      schema: 'xyx.private-reason',
      decision: 'complete',
      notes: { summary: 'passed' },
    };
    const result = privateReasonSchema.safeParse(reason);
    assert.ok(result.success);
  });

  it('accepts reject decision', () => {
    const reason = {
      schema: 'xyx.private-reason',
      decision: 'reject',
      notes: { summary: 'failed' },
    };
    assert.ok(privateReasonSchema.safeParse(reason).success);
  });

  it('rejects unknown fields', () => {
    const reason = {
      schema: 'xyx.private-reason',
      decision: 'complete',
      notes: { summary: 'passed' },
      unexpected: true,
    };
    assert.ok(!privateReasonSchema.safeParse(reason).success);
  });
});

describe('jobVerdictSchema', () => {
  it('accepts valid verdict', () => {
    const verdict = {
      jobId: 1n,
      termsCommitment: '0x' + 'ab'.repeat(32),
      deliveryCommitment: '0x' + 'cd'.repeat(32),
      evidenceCommitment: '0x' + 'ef'.repeat(32),
      reasonCommitment: '0x' + '01'.repeat(32),
      decision: 1,
      issuedAt: 1_700_000_000n,
      expiresAt: 1_700_003_600n,
      nonce: 0n,
    };
    const result = jobVerdictSchema.safeParse(verdict);
    assert.ok(result.success, `should accept valid verdict: ${JSON.stringify(result.error?.issues)}`);
  });

  it('rejects unknown fields', () => {
    const verdict = {
      jobId: 1n,
      termsCommitment: '0x' + 'ab'.repeat(32),
      deliveryCommitment: '0x' + 'cd'.repeat(32),
      evidenceCommitment: '0x' + 'ef'.repeat(32),
      reasonCommitment: '0x' + '01'.repeat(32),
      decision: 1,
      issuedAt: 1n,
      expiresAt: 2n,
      nonce: 0n,
      unexpected: true,
    };
    assert.ok(!jobVerdictSchema.safeParse(verdict).success);
  });

  it('rejects zero jobId', () => {
    const verdict = {
      jobId: 0n,
      termsCommitment: '0x' + 'ab'.repeat(32),
      deliveryCommitment: '0x' + 'cd'.repeat(32),
      evidenceCommitment: '0x' + 'ef'.repeat(32),
      reasonCommitment: '0x' + '01'.repeat(32),
      decision: 1,
      issuedAt: 1n,
      expiresAt: 2n,
      nonce: 0n,
    };
    assert.ok(!jobVerdictSchema.safeParse(verdict).success);
  });
});

// ===========================================================================
// Commitment tests
// ===========================================================================

describe('commitment encoding', () => {
  const salt = '0x' + randomBytes(32).toString('hex');

  it('createTermsCommitment returns 32-byte hex', () => {
    const terms = {
      schema: 'xyx.private-terms',
      chainId: 10143,
      protocol: TEST_ADDR,
      paymentToken: TEST_ADDR,
      buyer: TEST_ADDR,
      provider: TEST_ADDR,
      attestor: TEST_ADDR,
      budgetAtomic: '1000',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      task: { description: 'test' },
      acceptancePolicy: { rule: 'threshold:1' },
    };
    const result = createTermsCommitment(terms, salt);
    assert.strictEqual(result.commitment.length, 66);
    assert.ok(result.commitment !== '0x' + '00'.repeat(32));
  });

  it('same inputs produce same commitment', () => {
    const evidence = {
      schema: 'xyx.private-evidence',
      artifacts: { hash: '0x' + 'ab'.repeat(32), note: 'note' },
    };
    const c1 = createEvidenceCommitment(1n, evidence, salt);
    const c2 = createEvidenceCommitment(1n, evidence, salt);
    assert.strictEqual(c1.commitment, c2.commitment);
  });

  it('different salts produce different commitments', () => {
    const evidence = {
      schema: 'xyx.private-evidence',
      artifacts: { hash: '0x' + 'ab'.repeat(32), note: 'note' },
    };
    const salt1 = '0x' + randomBytes(32).toString('hex');
    const salt2 = '0x' + randomBytes(32).toString('hex');
    const c1 = createEvidenceCommitment(1n, evidence, salt1);
    const c2 = createEvidenceCommitment(1n, evidence, salt2);
    assert.notStrictEqual(c1.commitment, c2.commitment);
  });

  it('different jobIds produce different commitments', () => {
    const evidence = {
      schema: 'xyx.private-evidence',
      artifacts: { hash: '0x' + 'cd'.repeat(32), note: 'note' },
    };
    const c1 = createEvidenceCommitment(1n, evidence, salt);
    const c2 = createEvidenceCommitment(2n, evidence, salt);
    assert.notStrictEqual(c1.commitment, c2.commitment);
  });

  it('rejects non-32-byte salt in validateSalt', () => {
    assert.throws(() => validateSalt('0x' + 'ab'.repeat(16), 32));
  });
});

// ===========================================================================
// Verdict builder tests
// ===========================================================================

describe('buildVerdict and hashVerdict', () => {
  it('builds valid verdict', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const verdict = buildVerdict({
      jobId: 1n,
      termsCommitment: '0x' + 'ab'.repeat(32),
      deliveryCommitment: '0x' + 'cd'.repeat(32),
      evidenceCommitment: '0x' + 'ef'.repeat(32),
      reasonCommitment: '0x' + '01'.repeat(32),
      decision: 1,
      issuedAt: now - 3600n,
      expiresAt: now + 3600n,
      nonce: 0n,
      maxVerdictLifetime: 7200n,
      jobExpiresAt: now + 7200n,
    });
    assert.strictEqual(verdict.jobId, 1n);
    assert.strictEqual(verdict.decision, 1);
    assert.strictEqual(verdict.nonce, 0n);
  });

  it('hashVerdict produces 32-byte hex', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const verdict = buildVerdict({
      jobId: 1n,
      termsCommitment: '0x' + 'ab'.repeat(32),
      deliveryCommitment: '0x' + 'cd'.repeat(32),
      evidenceCommitment: '0x' + 'ef'.repeat(32),
      reasonCommitment: '0x' + '01'.repeat(32),
      decision: 1,
      issuedAt: now - 3600n,
      expiresAt: now + 3600n,
      nonce: 0n,
      maxVerdictLifetime: 7200n,
      jobExpiresAt: now + 7200n,
    });
    const h = hashVerdict(verdict, TEST_ADDR);
    assert.strictEqual(h.length, 66);
  });

  it('toSolidityVerdict converts types', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const verdict = buildVerdict({
      jobId: 1n,
      termsCommitment: '0x' + 'ab'.repeat(32),
      deliveryCommitment: '0x' + 'cd'.repeat(32),
      evidenceCommitment: '0x' + 'ef'.repeat(32),
      reasonCommitment: '0x' + '01'.repeat(32),
      decision: 1,
      issuedAt: now - 3600n,
      expiresAt: now + 3600n,
      nonce: 0n,
      maxVerdictLifetime: 7200n,
      jobExpiresAt: now + 7200n,
    });
    const sv = toSolidityVerdict(verdict);
    assert.strictEqual(typeof sv.nonce, 'bigint');
    assert.strictEqual(sv.nonce, 0n);
  });

  it('rejects decision 3', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    assert.throws(() =>
      buildVerdict({
        jobId: 1n,
        termsCommitment: '0x' + 'ab'.repeat(32),
        deliveryCommitment: '0x' + 'cd'.repeat(32),
        evidenceCommitment: '0x' + 'ef'.repeat(32),
        reasonCommitment: '0x' + '01'.repeat(32),
        decision: 3,
        issuedAt: now - 3600n,
        expiresAt: now + 3600n,
        nonce: 0n,
        maxVerdictLifetime: 7200n,
        jobExpiresAt: now + 7200n,
      })
    );
  });
});

// ===========================================================================
// Validation helpers
// ===========================================================================

describe('validateAddress', () => {
  it('accepts valid address', () => {
    const addr = validateAddress(TEST_ADDR, 'address');
    assert.strictEqual(addr, TEST_ADDR.toLowerCase());
  });

  it('rejects zero address', () => {
    assert.throws(() => validateAddress('0x' + '00'.repeat(20), 'address'));
  });

  it('rejects non-string', () => {
    assert.throws(() => validateAddress(123, 'address'));
  });
});

describe('validateChainId', () => {
  it('accepts 10143', () => {
    assert.doesNotThrow(() => validateChainId(10143));
  });

  it('rejects other chain IDs', () => {
    assert.throws(() => validateChainId(1));
    assert.throws(() => validateChainId(11155111));
  });
});

describe('validateDeadline', () => {
  it('rejects past deadline', () => {
    assert.throws(() => validateDeadline(Math.floor(Date.now() / 1000) - 1));
  });

  it('accepts future deadline', () => {
    assert.doesNotThrow(() => validateDeadline(Math.floor(Date.now() / 1000) + 100));
  });
});

// ===========================================================================
// Security guard tests
// ===========================================================================

describe('assertNoSecretFields', () => {
  it('passes clean object', () => {
    assert.doesNotThrow(() => assertNoSecretFields({ name: 'test' }, 'TestType'));
  });

  it('throws on secret fields', () => {
    assert.throws(() => assertNoSecretFields({ privateKey: 'secret' }, 'TestType'), /SECURITY.*privateKey/);
  });

  it('passes null/array', () => {
    assert.doesNotThrow(() => assertNoSecretFields(null, 'TestType'));
    assert.doesNotThrow(() => assertNoSecretFields([1, 2, 3], 'TestType'));
  });
});

describe('isStrictJsonValue', () => {
  it('accepts primitive JSON values', () => {
    assert.ok(isStrictJsonValue('hello'));
    assert.ok(isStrictJsonValue(42));
    assert.ok(isStrictJsonValue(true));
    assert.ok(isStrictJsonValue(null));
  });

  it('rejects Date', () => {
    assert.ok(!isStrictJsonValue(new Date()));
  });

  it('accepts arrays of strict values', () => {
    assert.ok(isStrictJsonValue([1, 'two', true, null]));
  });

  it('rejects arrays with gaps', () => {
    const arr = [1, 2, 3];
    delete arr[1];
    assert.ok(!isStrictJsonValue(arr));
  });
});

// ===========================================================================
// Transaction builder tests
// ===========================================================================

describe('transaction builders', () => {
  const addresses = {
    protocol: TEST_ADDR,
    registry: '0x' + '34'.repeat(20),
    p256Verifier: '0x' + '56'.repeat(20),
  };

  it('buildProposalRequest returns valid calldata', () => {
    const req = buildProposalRequest({
      buyer: TEST_ADDR,
      provider: '0x' + '78'.repeat(20),
      attestor: '0x' + '9a'.repeat(20),
      termsCommitment: '0x' + 'ab'.repeat(32),
      budget: 1000000000000000000n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }, addresses);
    assert.strictEqual(req.address, TEST_ADDR);
    assert.strictEqual(req.functionName, 'proposeJob');
    assert.ok(Array.isArray(req.args));
    assert.strictEqual(req.from, TEST_ADDR);
  });

  it('buildFundRequest returns valid calldata', () => {
    const req = buildFundRequest({ jobId: 1n }, addresses);
    assert.strictEqual(req.address, TEST_ADDR);
    assert.strictEqual(req.functionName, 'fundJob');
    assert.deepStrictEqual(req.args, [1n]);
  });

  it('buildAcceptRequest returns valid calldata', () => {
    const req = buildAcceptRequest({ jobId: 1n }, addresses);
    assert.strictEqual(req.address, TEST_ADDR);
    assert.strictEqual(req.functionName, 'acceptJob');
    assert.deepStrictEqual(req.args, [1n]);
  });

  it('buildSubmitRequest returns valid calldata', () => {
    const req = buildSubmitRequest({ jobId: 1n, deliveryCommitment: '0x' + 'cd'.repeat(32) }, addresses);
    assert.strictEqual(req.address, TEST_ADDR);
    assert.strictEqual(req.functionName, 'submitDelivery');
    assert.deepStrictEqual(req.args, [1n, '0x' + 'cd'.repeat(32)]);
  });

  it('buildClaimExpiryRefundRequest returns valid calldata', () => {
    const req = buildClaimExpiryRefundRequest({ jobId: 1n }, addresses);
    assert.strictEqual(req.address, TEST_ADDR);
    assert.strictEqual(req.functionName, 'claimExpiryRefund');
    assert.deepStrictEqual(req.args, [1n]);
  });

  it('buildResolveRequest returns valid calldata', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const verdict = buildVerdict({
      jobId: 1n,
      termsCommitment: '0x' + 'ab'.repeat(32),
      deliveryCommitment: '0x' + 'cd'.repeat(32),
      evidenceCommitment: '0x' + 'ef'.repeat(32),
      reasonCommitment: '0x' + '01'.repeat(32),
      decision: 1,
      issuedAt: now - 3600n,
      expiresAt: now + 3600n,
      nonce: 0n,
      maxVerdictLifetime: 7200n,
      jobExpiresAt: now + 7200n,
    });
    const req = buildResolveRequest({
      jobId: 1n,
      verdict,
      attestor: TEST_ADDR,
      assertion: {
        authenticatorData: '0x' + 'aa'.repeat(37),
        clientDataJSON: REAL_CLIENT_DATA_JSON,
        challengeIndex: 33,
        typeIndex: 55,
        r: '0x' + 'cc'.repeat(32),
        s: '0x' + 'dd'.repeat(32),
      },
    }, addresses);
    assert.strictEqual(req.address, TEST_ADDR);
    assert.strictEqual(req.functionName, 'resolveJob');
    assert.strictEqual(req.args.length, 2);
    assert.strictEqual(req.args[0].jobId, 1n);
    assert.strictEqual(req.from, TEST_ADDR);
  });
});
