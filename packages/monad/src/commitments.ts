import type { Address, Hex } from 'viem';
import { toHex } from 'viem';

/**
 * Canonical commitment helpers for XYX.
 *
 * All public values are bytes32 Keccak-256 commitments, computed from strict
 * canonical UTF-8 JSON plus a high-entropy per-object random salt.
 *
 * Commitments are integrity anchors, not a privacy system. Raw payloads and
 * salts MUST remain in memory and never enter browser persistence, console,
 * URLs, or error telemetry.
 */

export const TERMS_COMMITMENT_DOMAIN = 'XYX_TERMS_COMMITMENT';
export const DELIVERY_COMMITMENT_DOMAIN = 'XYX_DELIVERY_COMMITMENT';
export const EVIDENCE_COMMITMENT_DOMAIN = 'XYX_EVIDENCE_COMMITMENT';
export const REASON_COMMITMENT_DOMAIN = 'XYX_REASON_COMMITMENT';
export const CREDENTIAL_ID_COMMITMENT_DOMAIN = 'XYX_CREDENTIAL_ID';
export const APP_PRF_SALT = 'xyx://mera/prf/salt/v1';

// ===========================================================================
// Commitment creators live in ./delivery — this module owns the shared primitives
// ===========================================================================
//
// There is exactly ONE canonical public commitment family, implemented in
// ./delivery (createTermsCommitment / createDeliveryCommitment /
// createEvidenceCommitment / createReasonCommitment) and the credential-ID
// commitment in ./passkey (credentialIdToCommitment). All of them use a single
// binary format: DOMAIN_BYTES32 (32-byte left-padded ASCII label) ‖ optional
// uint256(jobId) (big-endian 32 bytes) ‖ canonical JSON bytes ‖ salt bytes
// (salt DECODED to bytes, never a hex string's character length), then
// keccak256. The credential-ID commitment is keccak256 of the raw decoded
// credential-ID bytes.
//
// This module keeps ONLY the shared primitives those creators depend on: the
// domain-separation labels, the PRF salt, salt generation/validation, and the
// legacy terms-payload validator. The former ASCII-interpolated creators
// (termsCommitment, deliveryCommitment, evidenceCommitment, reasonCommitment,
// credentialIdCommitment) were REMOVED: they interpolated a hex salt's
// characters and hashed ASCII text with toHex, producing different digests than
// the canonical binary format, and no production code consumed them. They are
// not converted to delegates because their signatures cannot compute the
// canonical preimage without creating an import cycle with ./delivery. The file
// is intentionally retained (not deleted) for its primitives.

/**
 * Strict terms object type.
 * Integrators must include all required binding fields.
 */
export interface TermsPayload {
  schema: string;
  chainId: number;
  protocol: Address;
  paymentToken: Address;
  buyer: Address;
  provider: Address;
  attestor: Address;
  budget: string;
  expiry: number;
  [key: string]: unknown;
}

/**
 * Validate a terms payload against required binding fields.
 */
export function validateTermsPayload(payload: unknown): TermsPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('TERMS_MUST_BE_OBJECT');
  }
  const record = payload as Record<string, unknown>;

  const errors: string[] = [];
  if (typeof record.schema !== 'string' || record.schema.length === 0) errors.push('schema is required');
  if (typeof record.chainId !== 'number' || record.chainId !== 10143) errors.push('chainId must be 10143');
  if (typeof record.protocol !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(record.protocol as string)) errors.push('protocol address required');
  if (typeof record.paymentToken !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(record.paymentToken as string)) errors.push('paymentToken address required');
  if (typeof record.buyer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(record.buyer as string)) errors.push('buyer address required');
  if (typeof record.provider !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(record.provider as string)) errors.push('provider address required');
  if (typeof record.attestor !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(record.attestor as string)) errors.push('attestor address required');
  if (typeof record.budget !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(record.budget as string)) errors.push('budget must be a positive decimal string');
  if (typeof record.expiry !== 'number' || !Number.isInteger(record.expiry) || record.expiry <= 0) errors.push('expiry must be a positive integer Unix timestamp');

  // Roles must be pairwise distinct
  const buyer = (record.buyer as string).toLowerCase();
  const provider = (record.provider as string).toLowerCase();
  const attestor = (record.attestor as string).toLowerCase();
  if (buyer === provider) errors.push('buyer and provider must be distinct');
  if (buyer === attestor) errors.push('buyer and attestor must be distinct');
  if (provider === attestor) errors.push('provider and attestor must be distinct');

  if (errors.length > 0) {
    throw new Error(`INVALID_TERMS: ${errors.join('; ')}`);
  }

  return record as TermsPayload;
}

/**
 * Generate a cryptographically random hex salt of the given byte length.
 */
export function generateSalt(byteLength: number = 32): Hex {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Validate a caller-supplied salt.
 *
 * Canonical salts are `0x`-prefixed Hex strings of at least `minBytes` bytes
 * (32 bytes by default). Non-Hex values, values without the `0x` prefix, odd
 * numbers of Hex characters (ambiguous byte encoding), and too-short values are
 * rejected. Arbitrary strings are never hashed as a salt.
 */
export function validateSalt(salt: unknown, minBytes: number = 32): void {
  if (!Number.isInteger(minBytes) || minBytes <= 0) {
    throw new Error('SALT_MIN_BYTES_INVALID: minBytes must be a positive integer');
  }
  if (typeof salt !== 'string' || !/^0x[0-9a-fA-F]*$/.test(salt)) {
    throw new Error('SALT_MUST_BE_HEX: salt must be a 0x-prefixed Hex string');
  }
  const hex = salt.slice(2);
  if (hex.length % 2 !== 0) {
    throw new Error('SALT_ODD_LENGTH: salt must contain an even number of Hex characters');
  }
  const byteLength = hex.length / 2;
  if (byteLength < minBytes) {
    throw new Error(`SALT_TOO_SHORT: expected at least ${minBytes} bytes, got ${byteLength}`);
  }
}

/**
 * Human-readable terms summary for preview. Never includes raw private fields.
 */
export interface TermsSummary {
  protocol: Address;
  paymentToken: Address;
  buyer: Address;
  provider: Address;
  attestor: Address;
  budget: string;
  expiry: number;
  chainId: number;
}

export function termsSummary(payload: TermsPayload): TermsSummary {
  return {
    protocol: payload.protocol as Address,
    paymentToken: payload.paymentToken as Address,
    buyer: payload.buyer as Address,
    provider: payload.provider as Address,
    attestor: payload.attestor as Address,
    budget: payload.budget as string,
    expiry: payload.expiry,
    chainId: payload.chainId,
  };
}
