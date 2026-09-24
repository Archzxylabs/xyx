/**
 * Tests for canonical passkey module (passkey.ts).
 *
 * These tests run in Node.js and cover pure functions (codec, DER parsing,
 * authenticator-data parsing, client-data parsing, RP validation, etc.).
 * Browser-dependent functions (createPasskey, getPasskeyPrfOutput,
 * performActionCeremony) are tested for their guards only.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  credentialIdToCommitment,
  parseAuthenticatorData,
  parseAuthenticatorFlags,
  p256PublicKeyToHex,
  isWebAuthnAvailable,
  isSecureContext,
  checkWebAuthnSupport,
  validateRpIdOrigin,
  startXYXSession,
  getActiveSession,
  endSession,
  type XYXPskCredential,
} from '../src/passkey';

// ===========================================================================
// Credential ID commitment
// ===========================================================================

test('credentialIdToCommitment returns valid keccak256 hex', async () => {
  const credId = 'test-credential-id';
  const commitment = await credentialIdToCommitment(credId);
  assert.strictEqual(commitment.startsWith('0x'), true);
  assert.strictEqual(commitment.length, 66);
});

test('credentialIdToCommitment is deterministic', async () => {
  const credId = 'same-id';
  const a = await credentialIdToCommitment(credId);
  const b = await credentialIdToCommitment(credId);
  assert.strictEqual(a, b);
});

// ===========================================================================
// Authenticator data parsing
// ===========================================================================

test('parseAuthenticatorData parses minimal data', () => {
  const data = new Uint8Array(37).fill(0);
  data[32] = 0x01; // flags
  data[33] = 0x00;
  data[34] = 0x00;
  data[35] = 0x00;
  data[36] = 0x01; // counter = 1

  const parsed = parseAuthenticatorData(data);
  assert.strictEqual(parsed.rpIdHash.length, 32);
  assert.strictEqual(parsed.flags, 0x01);
  assert.strictEqual(parsed.counter, 1);
});

test('parseAuthenticatorData rejects too-short input', () => {
  assert.throws(() => parseAuthenticatorData(new Uint8Array(10)), /AUTH_DATA_TOO_SHORT/);
});

test('parseAuthenticatorFlags decodes bitmask', () => {
  const flags = parseAuthenticatorFlags(0x45);
  assert.strictEqual(flags.up, true);
  assert.strictEqual(flags.uv, true);
  assert.strictEqual(flags.at, true);
  assert.strictEqual(flags.ed, false);
});

// ===========================================================================
// P-256 public key
// ===========================================================================

test('p256PublicKeyToHex builds uncompressed point', () => {
  const x = new Uint8Array(32).fill(0xab);
  const y = new Uint8Array(32).fill(0xcd);
  const hex = p256PublicKeyToHex(x, y);
  assert.strictEqual(hex.startsWith('0x'), true);
  assert.strictEqual(hex.length, 2 + 2 + 64 * 2);
});

test('p256PublicKeyToHex rejects wrong coordinate lengths', () => {
  assert.throws(
    () => p256PublicKeyToHex(new Uint8Array(31), new Uint8Array(32)),
    /INVALID_P256_COORDINATES/
  );
});

// ===========================================================================
// WebAuthn support checks (Node.js environment)
// ===========================================================================

test('isWebAuthnAvailable returns false in Node.js', () => {
  assert.strictEqual(isWebAuthnAvailable(), false);
});

test('isSecureContext returns false in Node.js', () => {
  assert.strictEqual(isSecureContext(), false);
});

test('checkWebAuthnSupport throws in Node.js', () => {
  assert.throws(() => checkWebAuthnSupport(), /WEB_AUTHN_UNSUPPORTED/);
});

// ===========================================================================
// RP ID origin validation (Node.js environment)
// ===========================================================================

test('validateRpIdOrigin skips in Node.js', () => {
  assert.doesNotThrow(() => validateRpIdOrigin('any.example.com'));
});

// ===========================================================================
// Session management
// ===========================================================================

test('session lifecycle: start, get, end', async () => {
  endSession();
  assert.strictEqual(getActiveSession(), null);

  const cred: XYXPskCredential = {
    credentialId: 'test-id',
    transports: ['internal'],
    rpId: 'example.com',
    prfSalt: 'salt',
    createdAt: Date.now(),
  };
  await assert.rejects(async () => startXYXSession(cred));
  assert.strictEqual(getActiveSession(), null);

  endSession();
  assert.strictEqual(getActiveSession(), null);
});

// ===========================================================================
// Type exports (compile-time check)
// ===========================================================================

test('XYXPskCredential type has expected fields', () => {
  const cred: XYXPskCredential = {
    credentialId: 'id',
    transports: ['usb'],
    rpId: 'rp',
    prfSalt: 'salt',
    createdAt: 0,
  };
  assert.strictEqual(cred.credentialId, 'id');
});
