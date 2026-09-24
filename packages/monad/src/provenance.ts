/**
 * XYX Canonical Provenance Module
 *
 * Strict no-secret schemas for draft and final deployment records.
 * These records are emitted by operators/CI and written to provenance logs.
 * They contain NO private payloads, salts, keys, or secrets.
 *
 * @module @xyx/monad/provenance
 */

import { z } from 'zod';

// ===========================================================================
// Deployment record types
// ===========================================================================

export type DeploymentEnvironment = 'testnet' | 'mainnet' | 'local' | 'ci';

export type DeploymentStage =
  | 'draft'
  | 'compile'
  | 'verify'
  | 'deploy'
  | 'bind'
  | 'verified'
  | 'failed';

// ===========================================================================
// Deployment stage result schema
// ===========================================================================

const deploymentStageResultSchema = z.object({
  stage: z.enum(['draft', 'compile', 'verify', 'deploy', 'bind', 'verified', 'failed']),
  status: z.enum(['pending', 'success', 'error', 'skipped']),
  startedAt: z.number().int().positive().optional(),
  finishedAt: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().max(1024).optional(),
  output: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).strict();

export type DeploymentStageResult = z.infer<typeof deploymentStageResultSchema>;

// ===========================================================================
// Draft deployment record (no contract addresses yet)
// ===========================================================================

export const draftDeploymentRecordSchema = z.object({
  recordType: z.literal('xyx-deployment-draft'),
  version: z.literal('1'),
  environment: z.enum(['testnet', 'mainnet', 'local', 'ci']),
  chainId: z.literal(10143),
  timestamp: z.number().int().positive(),
  deployer: z.object({
    name: z.string().max(128).optional(),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  }).strict(),
  source: z.object({
    repo: z.string().max(512),
    commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    branch: z.string().max(128).optional(),
  }).strict(),
  contracts: z.object({
    protocol: z.string().max(128),
    registry: z.string().max(128),
    p256Verifier: z.string().max(128),
    paymentToken: z.string().max(128).optional(),
  }).strict(),
  config: z.object({
    rpId: z.string().min(1).max(253),
    rpcUrl: z.string().url(),
    maxVerdictLifetime: z.string().regex(/^(0|[1-9]\d*)$/),
    counterPolicy: z.string().max(128).optional(),
  }).strict(),
  stages: z.array(deploymentStageResultSchema).max(20),
}).strict();

export type DraftDeploymentRecord = z.infer<typeof draftDeploymentRecordSchema>;

// ===========================================================================
// Final deployment record (with contract addresses and tx hashes)
// ===========================================================================

export interface ContractDeployment {
  name: string;
  address: string;
  deployTxHash: string;
  blockNumber: number;
  deployer: string;
  gasUsed: string;
  verifyTxHash?: string;
}

const contractDeploymentSchema = z.object({
  name: z.string().max(128),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  deployTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockNumber: z.number().int().positive(),
  deployer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  gasUsed: z.string().regex(/^(0|[1-9]\d*)$/),
  verifyTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
}).strict();

export const finalDeploymentRecordSchema = z.object({
  recordType: z.literal('xyx-deployment-final'),
  version: z.literal('1'),
  environment: z.enum(['testnet', 'mainnet', 'local', 'ci']),
  chainId: z.literal(10143),
  timestamp: z.number().int().positive(),
  deployer: z.object({
    name: z.string().max(128).optional(),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  }).strict(),
  source: z.object({
    repo: z.string().max(512),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    branch: z.string().max(128).optional(),
  }).strict(),
  contracts: z.array(contractDeploymentSchema).min(1).max(10),
  config: z.object({
    rpId: z.string().min(1).max(253),
    rpcUrl: z.string().url(),
    maxVerdictLifetime: z.string().regex(/^(0|[1-9]\d*)$/),
    counterPolicy: z.string().max(128).optional(),
  }).strict(),
  stages: z.array(deploymentStageResultSchema).max(20),
  bindings: z.object({
    protocol: z.object({
      registry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      p256Verifier: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      paymentToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      attestorSigner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
    }).strict(),
    registry: z.object({
      rpIdHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }).strict(),
  }).strict(),
}).strict();

export type FinalDeploymentRecord = z.infer<typeof finalDeploymentRecordSchema>;

// ===========================================================================
// Binding record (post-deploy contract wiring)
// ===========================================================================

export const bindingRecordSchema = z.object({
  recordType: z.literal('xyx-binding'),
  version: z.literal('1'),
  environment: z.enum(['testnet', 'mainnet', 'local', 'ci']),
  chainId: z.literal(10143),
  timestamp: z.number().int().positive(),
  protocolAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  bindings: z.object({
    registry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    p256Verifier: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    paymentToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
    attestorSigner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  }).strict(),
  registryRpIdHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockNumber: z.number().int().positive(),
}).strict();

export type BindingRecord = z.infer<typeof bindingRecordSchema>;

// ===========================================================================
// Provenance verification record (observed on-chain)
// ===========================================================================

export const provenanceVerificationSchema = z.object({
  recordType: z.literal('xyx-provenance-verification'),
  version: z.literal('1'),
  chainId: z.literal(10143),
  timestamp: z.number().int().positive(),
  deploymentRecord: z.object({
    recordType: z.literal('xyx-deployment-final'),
    timestamp: z.number().int().positive(),
    deployer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    contracts: z.array(z.object({
      name: z.string().max(128),
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    }).strict()).min(1),
  }).strict(),
  verification: z.object({
    sourceVerified: z.boolean(),
    bytecodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    blockNumber: z.number().int().positive(),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }).strict(),
}).strict();

export type ProvenanceVerification = z.infer<typeof provenanceVerificationSchema>;

// ===========================================================================
// No-secret guard
// ===========================================================================

const PROHIBITED_FIELD_NAMES = new Set([
  'privatekey', 'seed', 'mnemonic', 'passphrase',
  'prfsalt', 'prfoutput', 'apikey', 'apisecret', 'token',
  'password', 'credentialprivatekey', 'credentialsecret',
]);

/**
 * Assert that a record contains no secret fields.
 * Throws if any prohibited field is present.
 */
export function assertNoSecrets(record: unknown, recordType: string): void {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return;
  const obj = record as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    for (const prohibited of PROHIBITED_FIELD_NAMES) {
      if (lowerKey === prohibited) {
        throw new Error(
          `SECURITY: ${recordType} contains prohibited field "${key}" — secrets must not be recorded`
        );
      }
    }
    if (obj[key] !== null && typeof obj[key] === 'object') {
      // Recurse into nested objects (e.g., config.bindings)
      try {
        assertNoSecrets(obj[key], `${recordType}.${key}`);
      } catch (e) {
        // Re-throw with full path
        if (e instanceof Error && e.message.includes('SECURITY:')) {
          throw e;
        }
      }
    }
  }
}

// ===========================================================================
// Record type guards
// ===========================================================================

export function isDraftRecord(record: unknown): record is DraftDeploymentRecord {
  const result = draftDeploymentRecordSchema.safeParse(record);
  if (result.success) {
    assertNoSecrets(result.data, 'draft-deployment-record');
    return true;
  }
  return false;
}

export function isFinalRecord(record: unknown): record is FinalDeploymentRecord {
  const result = finalDeploymentRecordSchema.safeParse(record);
  if (result.success) {
    assertNoSecrets(result.data, 'final-deployment-record');
    return true;
  }
  return false;
}

export function isBindingRecord(record: unknown): record is BindingRecord {
  const result = bindingRecordSchema.safeParse(record);
  if (result.success) {
    assertNoSecrets(result.data, 'binding-record');
    return true;
  }
  return false;
}

export function isProvenanceVerification(record: unknown): record is ProvenanceVerification {
  const result = provenanceVerificationSchema.safeParse(record);
  if (result.success) {
    assertNoSecrets(result.data, 'provenance-verification');
    return true;
  }
  return false;
}

// ===========================================================================
// Record serialization (no secrets)
// ===========================================================================

export function serializeDraftRecord(record: DraftDeploymentRecord): string {
  assertNoSecrets(record, 'draft-deployment-record');
  return JSON.stringify(record);
}

export function serializeFinalRecord(record: FinalDeploymentRecord): string {
  assertNoSecrets(record, 'final-deployment-record');
  return JSON.stringify(record);
}

export function serializeBindingRecord(record: BindingRecord): string {
  assertNoSecrets(record, 'binding-record');
  return JSON.stringify(record);
}

// ===========================================================================
// Record canonical hashing (for integrity verification)
// ===========================================================================

import { canonicalJSON } from './canonical';
import { keccak256 } from 'viem';

/**
 * Integrity hash of a deployment record.
 *
 * Returns keccak256 over the UTF-8 bytes of the record's canonical JSON:
 *
 *   digest = keccak256(utf8Bytes(canonicalJSON(record)))
 *
 * This is a one-way digest (bytes32 / 66-char 0x-hex), NOT the canonical JSON
 * rendered as hex. Hex-encoding the plaintext (`'0x' + Buffer.from(canonical)
 * .toString('hex')`) would disclose the entire record to anyone holding the
 * "hash" — you could recover the plaintext by slicing off the 0x prefix — which
 * is the opposite of an integrity anchor. canonicalJSON already sorts keys
 * recursively, so records that are equal up to key order hash identically.
 */
export function hashRecord(record: DraftDeploymentRecord | FinalDeploymentRecord): string {
  assertNoSecrets(record, record.recordType);
  const canonical = canonicalJSON(record);
  return keccak256(new TextEncoder().encode(canonical));
}

// Alias for clarity
export function canonicalHash(record: DraftDeploymentRecord | FinalDeploymentRecord): string {
  return hashRecord(record);
}
