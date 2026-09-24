/**
 * Tests for canonical provenance module (provenance.ts).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  draftDeploymentRecordSchema,
  finalDeploymentRecordSchema,
  bindingRecordSchema,
  provenanceVerificationSchema,
  assertNoSecrets,
  isDraftRecord,
  isFinalRecord,
  isBindingRecord,
  isProvenanceVerification,
  serializeDraftRecord,
  serializeFinalRecord,
  serializeBindingRecord,
  hashRecord,
  canonicalHash,
} from '../src/provenance';

// ===========================================================================
// Draft deployment record schema
// ===========================================================================

const validDraftRecord = {
  recordType: 'xyx-deployment-draft',
  version: '1',
  environment: 'testnet',
  chainId: 10143,
  timestamp: Date.now(),
  deployer: {
    name: 'Alice',
    address: '0x' + 'ab'.repeat(20),
  },
  source: {
    repo: 'https://github.com/xyx/protocol',
    commit: 'a'.repeat(40),
    branch: 'main',
  },
  contracts: {
    protocol: 'XYXDeliveryProtocol.sol',
    registry: 'XYXPasskeyRegistry.sol',
    p256Verifier: 'MonadP256Verifier.sol',
  },
  config: {
    rpId: 'localhost',
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    maxVerdictLifetime: '86400',
  },
  stages: [],
};

test('draftDeploymentRecordSchema accepts valid record', () => {
  const result = draftDeploymentRecordSchema.safeParse(validDraftRecord);
  assert.ok(result.success, `parse failed: ${result.error?.message}`);
});

test('draftDeploymentRecordSchema rejects wrong recordType', () => {
  const result = draftDeploymentRecordSchema.safeParse({
    ...validDraftRecord,
    recordType: 'wrong',
  });
  assert.ok(!result.success);
});

test('draftDeploymentRecordSchema rejects wrong chainId', () => {
  const result = draftDeploymentRecordSchema.safeParse({
    ...validDraftRecord,
    chainId: 1,
  });
  assert.ok(!result.success);
});

test('draftDeploymentRecordSchema rejects unknown fields (strict)', () => {
  const result = draftDeploymentRecordSchema.safeParse({
    ...validDraftRecord,
    extraField: 'should fail',
  });
  assert.ok(!result.success);
});

test('draftDeploymentRecordSchema requires chainId 10143', () => {
  const result = draftDeploymentRecordSchema.safeParse({
    ...validDraftRecord,
    chainId: 10144,
  });
  assert.ok(!result.success);
});

// ===========================================================================
// hashRecord must be a real keccak256 digest, not the plaintext in hex
// ===========================================================================

test('hashRecord returns exactly a bytes32 (66-char 0x hex)', () => {
  const digest = hashRecord(validDraftRecord);
  assert.match(digest, /^0x[0-9a-f]{64}$/);
  assert.strictEqual(digest.length, 66);
});

test('hashRecord equals an independently computed keccak256 of canonical JSON', async () => {
  const { keccak256 } = await import('viem');
  const { canonicalJSON } = await import('../src/canonical');
  const expected = keccak256(new TextEncoder().encode(canonicalJSON(validDraftRecord)));
  assert.strictEqual(hashRecord(validDraftRecord), expected);
});

test('key-order-equivalent records hash identically after canonicalization', () => {
  const reordered = {
    version: validDraftRecord.version,
    timestamp: validDraftRecord.timestamp,
    recordType: validDraftRecord.recordType,
    environment: validDraftRecord.environment,
    chainId: validDraftRecord.chainId,
    stages: validDraftRecord.stages,
    source: {
      branch: validDraftRecord.source.branch,
      commit: validDraftRecord.source.commit,
      repo: validDraftRecord.source.repo,
    },
    deployer: {
      address: validDraftRecord.deployer.address,
      name: validDraftRecord.deployer.name,
    },
    config: {
      maxVerdictLifetime: validDraftRecord.config.maxVerdictLifetime,
      rpcUrl: validDraftRecord.config.rpcUrl,
      rpId: validDraftRecord.config.rpId,
    },
    contracts: {
      p256Verifier: validDraftRecord.contracts.p256Verifier,
      registry: validDraftRecord.contracts.registry,
      protocol: validDraftRecord.contracts.protocol,
    },
  };
  assert.strictEqual(hashRecord(reordered), hashRecord(validDraftRecord));
});

test('a changed field changes the digest', () => {
  const original = hashRecord(validDraftRecord);
  const changed = hashRecord({ ...validDraftRecord, environment: 'ci' });
  assert.notStrictEqual(original, changed);
});

test('the canonical plaintext is not recoverable by stripping 0x from the digest', () => {
  const digest = hashRecord(validDraftRecord);
  const stripped = digest.slice(2);
  const canonicalPlaintextHex = Buffer.from(
    new TextEncoder().encode(JSON.stringify(validDraftRecord))
  ).toString('hex');
  // The digest must not BE the plaintext hex (the old implementation returned exactly that).
  assert.notStrictEqual(stripped, canonicalPlaintextHex);
  // And the digest must not even contain a readable fragment of the record.
  assert.ok(!stripped.includes('xyx-deployment-draft'));
  assert.ok(!stripped.includes('testnet'));
});

test('canonicalHash is the same keccak256 digest as hashRecord', () => {
  assert.strictEqual(canonicalHash(validDraftRecord), hashRecord(validDraftRecord));
  assert.notStrictEqual(canonicalHash(validDraftRecord), '0x' + Buffer.from(JSON.stringify(validDraftRecord)).toString('hex'));
});

const validFinalRecord = {
  ...validDraftRecord,
  recordType: 'xyx-deployment-final',
  contracts: [
    {
      name: 'XYXDeliveryProtocol',
      address: '0x' + 'ab'.repeat(20),
      deployTxHash: '0x' + 'cd'.repeat(32),
      blockNumber: 1000000,
      deployer: '0x' + 'ef'.repeat(20),
      gasUsed: '1500000',
    },
  ],
  bindings: {
    protocol: {
      registry: '0x' + '12'.repeat(20),
      p256Verifier: '0x' + '34'.repeat(20),
      paymentToken: '0x' + '56'.repeat(20),
    },
    registry: {
      rpIdHash: '0x' + '78'.repeat(32),
    },
  },
};

test('finalDeploymentRecordSchema accepts valid record', () => {
  const result = finalDeploymentRecordSchema.safeParse(validFinalRecord);
  assert.ok(result.success, `parse failed: ${result.error?.message}`);
});

test('finalDeploymentRecordSchema rejects invalid address', () => {
  const result = finalDeploymentRecordSchema.safeParse({
    ...validFinalRecord,
    contracts: [
      {
        name: 'XYXDeliveryProtocol',
        address: 'not-an-address',
        deployTxHash: '0x' + 'cd'.repeat(32),
        blockNumber: 1000000,
        deployer: '0x' + 'ef'.repeat(20),
        gasUsed: '1500000',
      },
    ],
  });
  assert.ok(!result.success);
});

// ===========================================================================
// Binding record schema
// ===========================================================================

const validBindingRecord = {
  recordType: 'xyx-binding',
  version: '1',
  environment: 'testnet',
  chainId: 10143,
  timestamp: Date.now(),
  protocolAddress: '0x' + 'ab'.repeat(20),
  bindings: {
    registry: '0x' + 'cd'.repeat(20),
    p256Verifier: '0x' + 'ef'.repeat(20),
    paymentToken: '0x' + '01'.repeat(20),
  },
  registryRpIdHash: '0x' + '23'.repeat(32),
  txHash: '0x' + '45'.repeat(32),
  blockNumber: 1000001,
};

test('bindingRecordSchema accepts valid record', () => {
  const result = bindingRecordSchema.safeParse(validBindingRecord);
  assert.ok(result.success, `parse failed: ${result.error?.message}`);
});

test('bindingRecordSchema rejects short txHash', () => {
  const result = bindingRecordSchema.safeParse({
    ...validBindingRecord,
    txHash: '0x' + 'ab',
  });
  assert.ok(!result.success);
});

// ===========================================================================
// Provenance verification schema
// ===========================================================================

const validProvenanceVerification = {
  recordType: 'xyx-provenance-verification',
  version: '1',
  chainId: 10143,
  timestamp: Date.now(),
  deploymentRecord: {
    recordType: 'xyx-deployment-final',
    timestamp: Date.now(),
    deployer: '0x' + 'ab'.repeat(20),
    commit: 'a'.repeat(40),
    contracts: [
      { name: 'XYXDeliveryProtocol', address: '0x' + 'ab'.repeat(20) },
    ],
  },
  verification: {
    sourceVerified: true,
    bytecodeHash: '0x' + 'cd'.repeat(32),
    blockNumber: 1000002,
    txHash: '0x' + 'ef'.repeat(32),
  },
};

test('provenanceVerificationSchema accepts valid record', () => {
  const result = provenanceVerificationSchema.safeParse(validProvenanceVerification);
  assert.ok(result.success, `parse failed: ${result.error?.message}`);
});

test('provenanceVerificationSchema rejects missing sourceVerified', () => {
  const result = provenanceVerificationSchema.safeParse({
    ...validProvenanceVerification,
    verification: {
      ...validProvenanceVerification.verification,
      sourceVerified: undefined,
    },
  });
  assert.ok(!result.success);
});

// ===========================================================================
// No-secret guard
// ===========================================================================

test('assertNoSecrets passes clean record', () => {
  assert.doesNotThrow(() => assertNoSecrets({ name: 'test' }, 'test'));
});

test('assertNoSecrets throws on privateKey', () => {
  assert.throws(
    () => assertNoSecrets({ privateKey: 'secret' }, 'test'),
    /SECURITY.*privateKey/
  );
});

test('assertNoSecrets throws on prfSalt', () => {
  assert.throws(
    () => assertNoSecrets({ prfSalt: 'base64urlsalt' }, 'test'),
    /SECURITY.*prfSalt/
  );
});

test('assertNoSecrets throws on apiKey', () => {
  assert.throws(
    () => assertNoSecrets({ config: { apiKey: 'xyz' } }, 'test'),
    /SECURITY.*apiKey/
  );
});

test('assertNoSecrets is case-insensitive', () => {
  assert.throws(
    () => assertNoSecrets({ PrivateKey: 'secret' }, 'test'),
    /SECURITY.*PrivateKey/
  );
});

test('assertNoSecrets skips non-objects', () => {
  assert.doesNotThrow(() => assertNoSecrets(null, 'test'));
  assert.doesNotThrow(() => assertNoSecrets('string', 'test'));
  assert.doesNotThrow(() => assertNoSecrets([1, 2, 3], 'test'));
});

// ===========================================================================
// Type guards
// ===========================================================================

test('isDraftRecord returns true for valid draft', () => {
  assert.strictEqual(isDraftRecord(validDraftRecord), true);
});

test('isDraftRecord returns false for wrong recordType', () => {
  assert.strictEqual(isDraftRecord(validFinalRecord), false);
});

test('isDraftRecord rejects record with secrets', () => {
  assert.strictEqual(isDraftRecord({ ...validDraftRecord, privateKey: 'x' }), false);
});

test('isFinalRecord returns true for valid final', () => {
  assert.strictEqual(isFinalRecord(validFinalRecord), true);
});

test('isBindingRecord returns true for valid binding', () => {
  assert.strictEqual(isBindingRecord(validBindingRecord), true);
});

test('isProvenanceVerification returns true for valid verification', () => {
  assert.strictEqual(isProvenanceVerification(validProvenanceVerification), true);
});

// ===========================================================================
// Serialization
// ===========================================================================

test('serializeDraftRecord returns JSON string', () => {
  const json = serializeDraftRecord(validDraftRecord as any);
  assert.strictEqual(typeof json, 'string');
  assert.deepStrictEqual(JSON.parse(json).recordType, 'xyx-deployment-draft');
});

test('serializeFinalRecord returns JSON string', () => {
  const json = serializeFinalRecord(validFinalRecord as any);
  assert.strictEqual(typeof json, 'string');
  assert.deepStrictEqual(JSON.parse(json).recordType, 'xyx-deployment-final');
});

test('serializeBindingRecord returns JSON string', () => {
  const json = serializeBindingRecord(validBindingRecord as any);
  assert.strictEqual(typeof json, 'string');
  assert.deepStrictEqual(JSON.parse(json).recordType, 'xyx-binding');
});

// ===========================================================================
// Record hashing
// ===========================================================================

test('hashRecord returns deterministic hex string', () => {
  const h1 = hashRecord(validDraftRecord as any);
  const h2 = hashRecord(validDraftRecord as any);
  assert.strictEqual(h1, h2);
  assert.strictEqual(typeof h1, 'string');
});

test('canonicalHash is an alias for hashRecord', () => {
  const h1 = hashRecord(validDraftRecord as any);
  const h2 = canonicalHash(validDraftRecord as any);
  assert.strictEqual(h1, h2);
});
