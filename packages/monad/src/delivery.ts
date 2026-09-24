/**
 * XYX Canonical Delivery Schemas and Commitment Encoding
 *
 * Strict Zod schemas for private terms, delivery/evidence/reason payloads,
 * verdict, public deployment config, and public status. Domain-separated
 * commitment encoding with high-entropy salt validation.
 *
 * SECURITY: Private payloads, salts, and secret-bearing types are never
 * JSON-serializable by default. They must remain in memory only.
 *
 * @module @xyx/monad/delivery
 */

import { keccak256, toHex, type Hex } from 'viem';
import { z } from 'zod';
import type { Address } from 'viem';

import {
  TERMS_COMMITMENT_DOMAIN,
  DELIVERY_COMMITMENT_DOMAIN,
  EVIDENCE_COMMITMENT_DOMAIN,
  REASON_COMMITMENT_DOMAIN,
  APP_PRF_SALT,
  generateSalt,
  validateSalt,
} from './commitments';
import { canonicalJSON } from './canonical';
import { hashVerdictDigest } from './verdict';
import type { JobVerdictData } from './protocol';

// ===========================================================================
// Domain constants as bytes32 (padded fixed-width encoding)
// ===========================================================================

const DOMAIN_LABEL_SIZE = 32;

function domainToBytes32(domain: string): Hex {
  const encoded = new TextEncoder().encode(domain);
  if (encoded.length > DOMAIN_LABEL_SIZE) {
    throw new Error(`DOMAIN_TOO_LONG: ${domain} exceeds ${DOMAIN_LABEL_SIZE} bytes`);
  }
  const padded = new Uint8Array(DOMAIN_LABEL_SIZE);
  padded.set(encoded, 0);
  return toHex(padded);
}

const TERMS_DOMAIN_BYTES = domainToBytes32(TERMS_COMMITMENT_DOMAIN);
const DELIVERY_DOMAIN_BYTES = domainToBytes32(DELIVERY_COMMITMENT_DOMAIN);
const EVIDENCE_DOMAIN_BYTES = domainToBytes32(EVIDENCE_COMMITMENT_DOMAIN);
const REASON_DOMAIN_BYTES = domainToBytes32(REASON_COMMITMENT_DOMAIN);

// ===========================================================================
// Strict JSON type (for commitment input)
// ===========================================================================

export type StrictJsonValue =
  | string
  | number
  | boolean
  | null
  | StrictJsonArray
  | StrictJsonObject;

export interface StrictJsonArray extends Array<StrictJsonValue> {}
export interface StrictJsonObject {
  [key: string]: StrictJsonValue;
}

/**
 * Validate that a value is strict JSON-safe (no Date, undefined, functions, circular refs).
 */
export function isStrictJsonValue(value: unknown): value is StrictJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) return false;
      if (!isStrictJsonValue(value[i])) return false;
    }
    return true;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!isStrictJsonValue(record[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Convert a strict JSON value to canonical UTF-8 bytes (sorted keys, no spaces).
 */
export function strictJsonToCanonicalBytes(value: StrictJsonValue): Uint8Array {
  const json = canonicalJSON(value);
  return new TextEncoder().encode(json);
}

/**
 * Assert that a validated Zod object is JSON-safe, then convert to canonical bytes.
 */
export function validatedToCanonicalBytes(
  validated: unknown
): Uint8Array {
  if (!isStrictJsonValue(validated)) {
    throw new Error('INVALID_JSON: validated payload contains non-JSON-safe values');
  }
  return strictJsonToCanonicalBytes(validated);
}

// ===========================================================================
// Private terms schema
// ===========================================================================

const privateFieldSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const privateTermsSchema = z.object({
  schema: z.literal('xyx.private-terms'),
  chainId: z.literal(10143),
  protocol: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  paymentToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  buyer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  provider: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  attestor: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  budgetAtomic: z.string().regex(/^[1-9]\d*$/),
  expiresAt: z.number().int().positive(),
  task: z.record(z.string(), privateFieldSchema),
  acceptancePolicy: z.record(z.string(), privateFieldSchema),
}).strict().superRefine((terms, context) => {
  // A committed private terms object must carry the buyer instructions it binds,
  // and must never bind the same wallet to two roles (XYXDeliveryProtocol.proposeJob
  // rejects zero, self-referential, and duplicated actors).
  if (Object.keys(terms.task).length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'task must contain the private instructions' });
  }
  if (Object.keys(terms.acceptancePolicy).length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'acceptancePolicy must contain the acceptance rules' });
  }
  const actor = (value: string) => value.toLowerCase();
  const zero = '0x0000000000000000000000000000000000000000';
  const roles: Array<[string, string]> = [
    ['protocol', terms.protocol],
    ['paymentToken', terms.paymentToken],
    ['buyer', terms.buyer],
    ['provider', terms.provider],
    ['attestor', terms.attestor],
  ];
  const seen = new Map<string, string>();
  for (const [name, value] of roles) {
    if (actor(value) === zero) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must not be the zero address` });
    }
    const previous = seen.get(actor(value));
    if (previous !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must differ from ${previous}` });
    }
    seen.set(actor(value), name);
  }
});

export type PrivateTermsInput = z.infer<typeof privateTermsSchema>;

// ===========================================================================
// Private delivery/evidence/reason payload schemas
// ===========================================================================

export const privateDeliverySchema = z.object({
  schema: z.string().max(128),
  kind: z.string().max(128),
  content: z.record(z.string(), privateFieldSchema),
}).strict();

export const privateEvidenceSchema = z.object({
  schema: z.string().max(128),
  artifacts: z.record(z.string(), privateFieldSchema),
}).strict();

export const privateReasonSchema = z.object({
  schema: z.string().max(128),
  decision: z.enum(['complete', 'reject']),
  notes: z.record(z.string(), privateFieldSchema),
}).strict();

export type PrivateDeliveryInput = z.infer<typeof privateDeliverySchema>;
export type PrivateEvidenceInput = z.infer<typeof privateEvidenceSchema>;
export type PrivateReasonInput = z.infer<typeof privateReasonSchema>;

// ===========================================================================
// Public deployment config
// ===========================================================================

export const deploymentConfigSchema = z.object({
  chainId: z.literal(10143),
  protocolAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  registryAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  p256VerifierAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  paymentTokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  rpId: z.string().min(1).max(253),
  rpcUrl: z.string().url(),
}).strict();

export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

// ===========================================================================
// Public status types (no secrets)
// ===========================================================================

export type JobStatus =
  | 'Proposed'
  | 'Accepted'
  | 'Funded'
  | 'Submitted'
  | 'Completed'
  | 'Rejected'
  | 'Expired'
  | 'Cancelled';

export const JOB_STATUSES: readonly JobStatus[] = [
  'Proposed',
  'Accepted',
  'Funded',
  'Submitted',
  'Completed',
  'Rejected',
  'Expired',
  'Cancelled',
];

export const publicStatusSchema = z.object({
  jobId: z.number().int().nonnegative(),
  status: z.enum([
    'Proposed',
    'Accepted',
    'Funded',
    'Submitted',
    'Completed',
    'Rejected',
    'Expired',
    'Cancelled',
  ]),
  buyer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  provider: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  attestor: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  budget: z.string().regex(/^[1-9]\d*$/),
  expiresAt: z.number().int().positive(),
  termsCommitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  deliveryCommitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
}).strict();

export type PublicStatus = z.infer<typeof publicStatusSchema>;

// ===========================================================================
// JobVerdict — strict mirror of Solidity JobVerdict struct
// ===========================================================================

export const jobVerdictSchema = z.object({
  jobId: z.bigint().positive(),
  termsCommitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  deliveryCommitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  evidenceCommitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  reasonCommitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  decision: z.union([z.literal(1), z.literal(2)]),
  issuedAt: z.bigint().nonnegative(),
  expiresAt: z.bigint().positive(),
  nonce: z.bigint().nonnegative(),
}).strict();

export type JobVerdictInput = z.infer<typeof jobVerdictSchema>;

// ===========================================================================
// Commitment encoding — domain-separated keccak256
// ===========================================================================

function hexToBytes(hex: Hex): Uint8Array {
  const result = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < result.length; i++) {
    result[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return result;
}

/**
 * Create a terms commitment.
 *
 * CANONICAL BINARY FORMAT — raw byte concatenation (NOT abi.encode):
 *
 *   preimage    = DOMAIN_BYTES32 ‖ canonicalTermsBytes ‖ saltBytes
 *   commitment  = keccak256(preimage)
 *
 *   - DOMAIN_BYTES32: the ASCII label "XYX_TERMS_COMMITMENT" left-padded to
 *     exactly 32 bytes (see domainToBytes32). The terms commitment is the only
 *     one WITHOUT a jobId component — a terms object is bound to a job only via
 *     the buyer's proposal, not via this digest.
 *   - canonicalTermsBytes: strict canonical UTF-8 JSON bytes of `terms`
 *     (recursively key-sorted, no whitespace) — see validatedToCanonicalBytes.
 *   - saltBytes: the salt DECODED to bytes. A 32-byte salt is 32 bytes here,
 *     never 66 characters. Size the buffer and every offset from the DECODED
 *     byte length; a 0x-hex string's character length is not a byte length.
 *
 * @param terms - Validated private terms object (from Zod validation)
 * @param salt - 32-byte hex salt (caller-supplied)
 * @returns commitment bytes32 and canonical encoding bytes (for debugging)
 */
export function createTermsCommitment(
  terms: PrivateTermsInput,
  salt: Hex
): { commitment: Hex; canonicalBytes: Uint8Array } {
  validateSalt(salt, 32);
  const canonicalBytes = validatedToCanonicalBytes(terms as unknown as StrictJsonValue);
  // Decode domain and salt to bytes BEFORE sizing: TERMS_DOMAIN_BYTES is a
  // 66-char 0x-hex encoding of 32 bytes, and salt likewise. Using .length on
  // those hex strings would pad the preimage with spurious zero gaps.
  const domainPrefix = hexToBytes(TERMS_DOMAIN_BYTES);
  const saltBytes = hexToBytes(salt);
  const combined = new Uint8Array(domainPrefix.length + canonicalBytes.length + saltBytes.length);
  combined.set(domainPrefix, 0);
  combined.set(canonicalBytes, domainPrefix.length);
  combined.set(saltBytes, domainPrefix.length + canonicalBytes.length);
  return { commitment: keccak256(toHex(combined)), canonicalBytes };
}

/**
 * Create a delivery commitment.
 *
 * encoding: keccak256(DELIVERY_DOMAIN_BYTES32 ‖ uint256(jobId) ‖ canonicalDeliveryBytes ‖ saltBytes)
 *
 * Raw byte concatenation, NOT abi.encode: DOMAIN_BYTES32 is the domain label
 * left-padded to 32 bytes, uint256(jobId) is a big-endian 32-byte integer,
 * and saltBytes is the salt decoded to bytes (byte length, not hex char length).
 */
export function createDeliveryCommitment(
  jobId: bigint,
  delivery: PrivateDeliveryInput,
  salt: Hex
): { commitment: Hex; canonicalBytes: Uint8Array } {
  validateSalt(salt, 32);
  const canonicalBytes = validatedToCanonicalBytes(delivery as unknown as StrictJsonValue);

  // Raw concatenation (NOT abi.encode): bytes32 domain || uint256 jobId || bytes || bytes32 salt
  const domainPrefix = hexToBytes(DELIVERY_DOMAIN_BYTES);
  const jobIdEncoded = new Uint8Array(32);
  // Big-endian 32-byte encoding
  const jobIdHex = jobId.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) {
    jobIdEncoded[i] = parseInt(jobIdHex.slice(i * 2, i * 2 + 2), 16);
  }
  const saltBytes = hexToBytes(salt);
  const combined = new Uint8Array(
    domainPrefix.length + jobIdEncoded.length + canonicalBytes.length + saltBytes.length
  );
  let offset = 0;
  combined.set(domainPrefix, offset); offset += domainPrefix.length;
  combined.set(jobIdEncoded, offset); offset += jobIdEncoded.length;
  combined.set(canonicalBytes, offset); offset += canonicalBytes.length;
  combined.set(saltBytes, offset);

  return { commitment: keccak256(toHex(combined)), canonicalBytes };
}

/**
 * Create an evidence commitment.
 *
 * Raw concatenation (NOT abi.encode):
 *   keccak256(EVIDENCE_DOMAIN_BYTES32 ‖ uint256(jobId) ‖ canonicalEvidenceBytes ‖ saltBytes)
 */
export function createEvidenceCommitment(
  jobId: bigint,
  evidence: PrivateEvidenceInput,
  salt: Hex
): { commitment: Hex; canonicalBytes: Uint8Array } {
  validateSalt(salt, 32);
  const canonicalBytes = validatedToCanonicalBytes(evidence as unknown as StrictJsonValue);
  const domainPrefix = hexToBytes(EVIDENCE_DOMAIN_BYTES);
  const jobIdEncoded = new Uint8Array(32);
  const jobIdHex = jobId.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) {
    jobIdEncoded[i] = parseInt(jobIdHex.slice(i * 2, i * 2 + 2), 16);
  }
  const saltBytes = hexToBytes(salt);
  const combined = new Uint8Array(
    domainPrefix.length + jobIdEncoded.length + canonicalBytes.length + saltBytes.length
  );
  let offset = 0;
  combined.set(domainPrefix, offset); offset += domainPrefix.length;
  combined.set(jobIdEncoded, offset); offset += jobIdEncoded.length;
  combined.set(canonicalBytes, offset); offset += canonicalBytes.length;
  combined.set(saltBytes, offset);
  return { commitment: keccak256(toHex(combined)), canonicalBytes };
}

/**
 * Create a reason commitment.
 *
 * Raw concatenation (NOT abi.encode):
 *   keccak256(REASON_DOMAIN_BYTES32 ‖ uint256(jobId) ‖ canonicalReasonBytes ‖ saltBytes)
 */
export function createReasonCommitment(
  jobId: bigint,
  reason: PrivateReasonInput,
  salt: Hex
): { commitment: Hex; canonicalBytes: Uint8Array } {
  validateSalt(salt, 32);
  const canonicalBytes = validatedToCanonicalBytes(reason as unknown as StrictJsonValue);
  const domainPrefix = hexToBytes(REASON_DOMAIN_BYTES);
  const jobIdEncoded = new Uint8Array(32);
  const jobIdHex = jobId.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) {
    jobIdEncoded[i] = parseInt(jobIdHex.slice(i * 2, i * 2 + 2), 16);
  }
  const saltBytes = hexToBytes(salt);
  const combined = new Uint8Array(
    domainPrefix.length + jobIdEncoded.length + canonicalBytes.length + saltBytes.length
  );
  let offset = 0;
  combined.set(domainPrefix, offset); offset += domainPrefix.length;
  combined.set(jobIdEncoded, offset); offset += jobIdEncoded.length;
  combined.set(canonicalBytes, offset); offset += canonicalBytes.length;
  combined.set(saltBytes, offset);
  return { commitment: keccak256(toHex(combined)), canonicalBytes };
}

// ===========================================================================
// Verdict builder and Solidity conversion
// ===========================================================================

interface BuildVerdictOptions {
  jobId: bigint;
  termsCommitment: Hex;
  deliveryCommitment: Hex;
  evidenceCommitment: Hex;
  reasonCommitment: Hex;
  decision: 1 | 2;
  issuedAt: bigint;
  expiresAt: bigint;
  nonce: bigint;
  maxVerdictLifetime: bigint;
  jobExpiresAt: bigint;
  now?: bigint;
}

export function buildVerdict(input: BuildVerdictOptions): JobVerdictInput {
  const now = input.now ?? BigInt(Math.floor(Date.now() / 1000));

  if (input.decision !== 1 && input.decision !== 2) {
    throw new Error('INVALID_DECISION: must be 1 (complete) or 2 (reject)');
  }

  if (input.termsCommitment === '0x' || input.termsCommitment === '0x0') {
    throw new Error('INVALID_TERMS_COMMITMENT');
  }
  if (input.deliveryCommitment === '0x' || input.deliveryCommitment === '0x0') {
    throw new Error('INVALID_DELIVERY_COMMITMENT');
  }
  if (input.evidenceCommitment === '0x' || input.evidenceCommitment === '0x0') {
    throw new Error('INVALID_EVIDENCE_COMMITMENT: evidence commitment must be non-zero');
  }
  if (input.reasonCommitment === '0x' || input.reasonCommitment === '0x0') {
    throw new Error('INVALID_REASON_COMMITMENT: reason commitment must be non-zero');
  }

  if (input.issuedAt > now) {
    throw new Error('INVALID_TIMESTAMP: issuedAt is in the future');
  }
  if (input.expiresAt <= now) {
    throw new Error('INVALID_TIMESTAMP: expiresAt must be in the future');
  }
  if (input.expiresAt <= input.issuedAt) {
    throw new Error('INVALID_TIMESTAMP: expiresAt must be after issuedAt');
  }
  if (input.expiresAt > input.jobExpiresAt) {
    throw new Error('INVALID_TIMESTAMP: verdict expiresAt exceeds job expiry');
  }

  const lifetime = input.expiresAt - input.issuedAt;
  if (lifetime > input.maxVerdictLifetime) {
    throw new Error(`INVALID_LIFETIME: verdict lifetime exceeds maximum of ${input.maxVerdictLifetime}`);
  }

  if (input.nonce < 0n) {
    throw new Error('INVALID_NONCE: nonce must be non-negative');
  }

  return {
    jobId: input.jobId,
    termsCommitment: input.termsCommitment,
    deliveryCommitment: input.deliveryCommitment,
    evidenceCommitment: input.evidenceCommitment,
    reasonCommitment: input.reasonCommitment,
    decision: input.decision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
  };
}

/**
 * Convert a JobVerdictInput to Solidity-compatible ABI values.
 */
export function toSolidityVerdict(verdict: JobVerdictInput): {
  jobId: bigint;
  termsCommitment: Hex;
  deliveryCommitment: Hex;
  evidenceCommitment: Hex;
  reasonCommitment: Hex;
  decision: number;
  issuedAt: bigint;
  expiresAt: bigint;
  nonce: bigint;
} {
  const UINT64_MAX = BigInt('0xFFFFFFFFFFFFFFFF');
  const fields = ['issuedAt', 'expiresAt', 'nonce'] as const;
  for (const field of fields) {
    const value = verdict[field];
    if (value > UINT64_MAX) {
      throw new Error(`INVALID_UINT64: ${field} exceeds uint64 max`);
    }
  }
  if (verdict.jobId === 0n) {
    throw new Error('INVALID_JOB_ID: jobId must be positive');
  }

  return {
    jobId: verdict.jobId,
    termsCommitment: verdict.termsCommitment as Hex,
    deliveryCommitment: verdict.deliveryCommitment as Hex,
    evidenceCommitment: verdict.evidenceCommitment as Hex,
    reasonCommitment: verdict.reasonCommitment as Hex,
    decision: verdict.decision,
    issuedAt: verdict.issuedAt,
    expiresAt: verdict.expiresAt,
    nonce: verdict.nonce,
  };
}

// ===========================================================================
// Verdict digest (EIP-712 compatible, single canonical implementation)
// ===========================================================================

/**
 * Recompute the canonical EIP-712 verdict digest exactly as
 * `XYXDeliveryProtocol.hashVerdict` does.
 *
 * The domain MUST bind the real protocol contract: pass the deployed protocol
 * address as `verifyingContract`. A digest computed for another contract or
 * chain can never be accepted by the registry's action assertion.
 */
export function hashVerdict(verdict: JobVerdictInput, verifyingContract: Address, chainId = 10143): Hex {
  return hashVerdictDigest(toSolidityVerdict(verdict) as JobVerdictData, verifyingContract, chainId);
}

// ===========================================================================
// Budget/amount validation
// ===========================================================================

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function validateAddress(value: unknown, fieldName: string): Address {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new Error(`INVALID_ADDRESS: ${fieldName} must be a 0x-prefixed 40-char hex address`);
  }
  if (value === '0x0000000000000000000000000000000000000000') {
    throw new Error(`INVALID_ADDRESS: ${fieldName} must not be zero address`);
  }
  return value as Address;
}

export function validatePositiveIntegerString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`INVALID_AMOUNT: ${fieldName} must be a positive integer string`);
  }
  return value;
}

export function validateChainId(chainId: number): void {
  if (chainId !== 10143) {
    throw new Error(`WRONG_NETWORK: chain ID is ${chainId}, expected 10143 (Monad Testnet)`);
  }
}

export function validateDeadline(deadline: number, now: number = Math.floor(Date.now() / 1000)): void {
  if (!Number.isInteger(deadline) || deadline <= 0) {
    throw new Error('INVALID_DEADLINE: must be a positive integer Unix timestamp');
  }
  if (deadline <= now) {
    throw new Error('INVALID_DEADLINE: must be in the future');
  }
}

// ===========================================================================
// Secure serialization guard
// ===========================================================================

const SECRET_FIELD_NAMES = new Set([
  'privateKey',
  'seed',
  'prfOutput',
  'credentialId',
  'mnemonic',
  'privateTerms',
  'evidence',
  'delivery',
  'reason',
  'task',
  'acceptancePolicy',
  'canonicalBytes',
  'prfSalt',
]);

/**
 * Assert that a public-facing object contains no secret fields.
 */
export function assertNoSecretFields(obj: unknown, typeName: string): void {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return;
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      throw new Error(`SECURITY: ${typeName} contains secret field "${key}" — never serialize this`);
    }
  }
}

// ===========================================================================
// Re-export request builders from delivery-chain (the canonical transaction layer)
// ===========================================================================

export {
  buildProposalRequest,
  buildFundRequest,
  buildAcceptRequest,
  buildCancelProposalRequest,
  buildSubmitRequest,
  buildResolveRequest,
  buildClaimExpiryRefundRequest,
  validateContractAddresses,
  extractSettlementEvent,
  type JobData,
  type JobVerdictData,
  type PasskeyCredential,
} from './delivery-chain';

export { validateSalt } from './commitments';
