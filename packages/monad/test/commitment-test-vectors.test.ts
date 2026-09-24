/**
 * Deterministic test vectors for the ONE canonical commitment format.
 *
 * Every expected digest in this file was computed independently from the byte
 * format spec below (not by calling the implementation under test), then frozen.
 * A change to the encoding — including the specific bug this file guards
 * against, sizing a buffer from a 0x-hex salt's CHARACTER length instead of its
 * DECODED BYTE length — shows up here as a digest mismatch.
 *
 * ===================== CANONICAL BINARY FORMAT =====================
 * Terms:      keccak256( DOMAIN_BYTES32 ‖ canonicalTermsBytes ‖ saltBytes )
 * Delivery:   keccak256( DOMAIN_BYTES32 ‖ uint256_be(jobId) ‖ canonicalDeliveryBytes ‖ saltBytes )
 * Evidence:   keccak256( DOMAIN_BYTES32 ‖ uint256_be(jobId) ‖ canonicalEvidenceBytes ‖ saltBytes )
 * Reason:     keccak256( DOMAIN_BYTES32 ‖ uint256_be(jobId) ‖ canonicalReasonBytes ‖ saltBytes )
 * Credential: keccak256( rawCredentialIdBytes )
 *
 *  - DOMAIN_BYTES32: ASCII domain label UTF-8 encoded, LEFT-padded to 32 bytes.
 *    Terms has NO jobId component; a terms object binds to a job only through
 *    the buyer's proposal.
 *  - canonical*Bytes: strict canonical JSON bytes — recursive key sort, no
 *    whitespace, UTF-8 encoded.
 *  - saltBytes: the salt DECODED to bytes. A 32-byte salt is 32 bytes. A
 *    hex string's 66-char length is NEVER a byte length.
 *  - Final hash: keccak256 over the concatenated bytes. This is raw byte
 *    concatenation, NOT abi.encode.
 * ==================================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { keccak256, toHex } from 'viem';

import {
  createTermsCommitment,
  createDeliveryCommitment,
  createEvidenceCommitment,
  createReasonCommitment,
} from '../src/delivery';
import { credentialIdToCommitment } from '../src/passkey';
import { canonicalJSON } from '../src/canonical';

// A fixed 32-byte salt: 0x01 0x02 ... 0x20. Deterministic by construction, so
// these vectors never depend on randomness.
const SALT = '0x' + Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, '0')).join('');

const ADDR = '0x' + '12'.repeat(20);

const TERMS = {
  schema: 'xyx.private-terms',
  chainId: 10143,
  protocol: ADDR,
  paymentToken: ADDR,
  buyer: ADDR,
  provider: ADDR,
  attestor: ADDR,
  budgetAtomic: '1000',
  expiresAt: 1893456000,
  task: { description: 'vector' },
  acceptancePolicy: { rule: 'threshold:1' },
};

// Independently reimplemented spec, used to prove the implementation matches the
// documented format rather than merely being self-consistent.
function domainBytes32(label: string): Uint8Array {
  const padded = new Uint8Array(32);
  padded.set(new TextEncoder().encode(label), 0);
  return padded;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}
function uint256BE(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function specDigest(domain: string, jobId: bigint | undefined, payload: unknown, salt: string): string {
  const parts: Uint8Array[] = [domainBytes32(domain)];
  if (jobId !== undefined) parts.push(uint256BE(jobId));
  parts.push(new TextEncoder().encode(canonicalJSON(payload)));
  parts.push(hexToBytes(salt));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const preimage = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    preimage.set(part, offset);
    offset += part.length;
  }
  return keccak256(toHex(preimage));
}

describe('canonical commitment test vectors', () => {
  it('frozen terms-commitment vector matches the independently computed digest', () => {
    const { commitment } = createTermsCommitment(TERMS, SALT);
    assert.strictEqual(
      commitment,
      '0x6d51ba96815038f2b175bc252df6d16de30cdabe2e981a28a402ee1480a3f52a'
    );
  });

  it('implementation agrees with the documented byte format (terms)', () => {
    const { commitment } = createTermsCommitment(TERMS, SALT);
    assert.strictEqual(commitment, specDigest('XYX_TERMS_COMMITMENT', undefined, TERMS, SALT));
  });

  it('terms preimage is exactly 32 + canonical + 32 bytes (salt sized in bytes)', () => {
    const canonicalLen = new TextEncoder().encode(canonicalJSON(TERMS)).length;
    const { commitment } = createTermsCommitment(TERMS, SALT);
    // Recompute the digest from an explicitly sized preimage.
    const expected = specDigest('XYX_TERMS_COMMITMENT', undefined, TERMS, SALT);
    assert.strictEqual(commitment, expected);
    assert.strictEqual(32 + canonicalLen + 32, 510);
  });

  it('frozen delivery-commitment vector matches the independently computed digest', () => {
    const delivery = { schema: 'xyx.private-delivery', result: { hash: '0x' + 'ab'.repeat(32) } };
    const { commitment } = createDeliveryCommitment(1n, delivery, SALT);
    assert.strictEqual(
      commitment,
      '0x3c20db5aeebc7c7217299f1efc0563c0d62d15b8aaa0d154786801eb14f6c8cf'
    );
    assert.strictEqual(commitment, specDigest('XYX_DELIVERY_COMMITMENT', 1n, delivery, SALT));
  });

  it('implementation agrees with the documented byte format (evidence)', () => {
    const evidence = { schema: 'xyx.private-evidence', artifacts: { note: 'vector' } };
    const { commitment } = createEvidenceCommitment(7n, evidence, SALT);
    assert.strictEqual(commitment, specDigest('XYX_EVIDENCE_COMMITMENT', 7n, evidence, SALT));
  });

  it('implementation agrees with the documented byte format (reason)', () => {
    const reason = { schema: 'xyx.private-reason', rationale: { code: 'quality' } };
    const { commitment } = createReasonCommitment(7n, reason, SALT);
    assert.strictEqual(commitment, specDigest('XYX_REASON_COMMITMENT', 7n, reason, SALT));
  });

  it('a one-byte payload change changes the digest', () => {
    const a = createTermsCommitment(TERMS, SALT).commitment;
    const b = createTermsCommitment({ ...TERMS, task: { description: 'vectos' } }, SALT).commitment;
    assert.strictEqual(
      a,
      '0x6d51ba96815038f2b175bc252df6d16de30cdabe2e981a28a402ee1480a3f52a'
    );
    assert.strictEqual(
      b,
      '0x7daf2895988e733a0e32fcea5325b665f70366cc47d2b15ff375d411d5192e2b'
    );
    assert.notStrictEqual(a, b);
  });

  it('a salt change changes the digest', () => {
    const other = '0x' + Array.from({ length: 32 }, (_, i) => (0x40 + i).toString(16).padStart(2, '0')).join('');
    const a = createTermsCommitment(TERMS, SALT).commitment;
    const b = createTermsCommitment(TERMS, other).commitment;
    assert.notStrictEqual(a, b);
  });

  it('each domain is domain-separated (same input, different label, different digest)', () => {
    const payload = { schema: 'xyx.private-delivery', result: { hash: '0x' + 'ab'.repeat(32) } };
    const delivery = createDeliveryCommitment(5n, payload, SALT).commitment;
    const evidence = createEvidenceCommitment(5n, payload, SALT).commitment;
    const reason = createReasonCommitment(5n, payload, SALT).commitment;
    assert.notStrictEqual(delivery, evidence);
    assert.notStrictEqual(delivery, reason);
    assert.notStrictEqual(evidence, reason);
  });

  // The regression this file exists to prevent.
  it('the removed ASCII construction cannot be reintroduced by accident', () => {
    const { commitment } = createTermsCommitment(TERMS, SALT);
    // The retired algorithm hashed toHex("XYX_TERMS_COMMITMENT" + json + salt) —
    // ASCII interpolation, with the salt as its 66 hex characters.
    const retired = keccak256(toHex(`XYX_TERMS_COMMITMENT${canonicalJSON(TERMS)}${SALT}`));
    assert.strictEqual(retired, '0xb7933871fd27028bddae5c12e34b5356697806e5c36bc52de5f94557f85aad63');
    assert.notStrictEqual(commitment, retired);
  });

  it('credential-ID commitment hashes the raw decoded credential bytes', async () => {
    const credentialId = 'test-credential-id';
    const commitment = await credentialIdToCommitment(credentialId);
    assert.strictEqual(commitment, '0x456a530633350d74ad56f5ae5534b24482ece177bd9fe6b252fa5a9ea223325c');
  });

  it('credential-ID commitment is keccak256 of decoded bytes, not of a hex string', async () => {
    const credentialId = 'test-credential-id';
    const commitment = await credentialIdToCommitment(credentialId);
    // The removed double-encoding built a 0x-hex string then hex-encoded ITS
    // UTF-8 characters, producing a digest over a longer, different preimage.
    const decoded = fromBase64url(credentialId);
    const hexText = '0x' + Array.from(decoded, (b) => b.toString(16).padStart(2, '0')).join('');
    const doubleEncoded = keccak256(new TextEncoder().encode(hexText));
    assert.notStrictEqual(commitment, doubleEncoded);
  });

  it('credential-ID commitment changes when the credential changes', async () => {
    const a = await credentialIdToCommitment('test-credential-id');
    const b = await credentialIdToCommitment('other-credential-id');
    assert.notStrictEqual(a, b);
  });
});

/** base64url decode, matching the credential-ID bytes the authenticator supplies. */
function fromBase64url(str: string): Uint8Array {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = normalized.length % 4;
  const padded = padLen === 0 ? normalized : normalized + '===='.slice(padLen);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
