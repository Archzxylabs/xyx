/**
 * Strict canonical XYXDeliveryProtocol event decoding.
 *
 * The canonical settlement surface is `XYXDeliveryProtocol.sol` only. Legacy
 * `AgenticCommerce` / `XYXEvaluator` events are not settlement evidence and are
 * never decoded here.
 *
 * SECURITY: every decoder is evidence-grade. It requires the expected protocol
 * address, exact topic counts, exact data lengths, valid 32-byte Hex words, and
 * a canonical decision of exactly 1 or 2. A malformed, incomplete, oversized,
 * wrong-address, wrong-topic, or wrong-decision log can never produce a partial
 * successful result — it always throws.
 *
 * @module @xyx/monad/canonical-events
 */

import { keccak256, toHex, type Address, type Hex } from 'viem';

import { sameAddress, type TransferLog } from './chain-primitives';

// ===========================================================================
// Canonical signatures (never include `indexed` in these strings)
// ===========================================================================

export const JOB_RESOLVED_SIGNATURE = 'JobResolved(uint256,address,uint8,bytes32,bytes32,bytes32)';
export const JOB_EXPIRED_SIGNATURE = 'JobExpired(uint256,address,uint256)';

function signatureTopic(signature: string): Hex {
  return keccak256(toHex(new TextEncoder().encode(signature)));
}
export const JOB_RESOLVED_TOPIC: Hex = signatureTopic(JOB_RESOLVED_SIGNATURE);
export const JOB_EXPIRED_TOPIC: Hex = signatureTopic(JOB_EXPIRED_SIGNATURE);

// ===========================================================================
// Canonical log layout
// ===========================================================================

/**
 * JobResolved(uint256 indexed jobId, address indexed attestor, uint8 decision,
 *              bytes32 indexed verdictDigest, bytes32 evidenceCommitment, bytes32 reasonCommitment)
 *
 * topics[0] = signature hash                (32-byte Hex)
 * topics[1] = jobId                         (32-byte Hex word)
 * topics[2] = attestor, left-padded         (32-byte Hex word)
 * topics[3] = verdictDigest                 (32-byte Hex word)
 * data      = decision + evidenceCommitment + reasonCommitment (3 ABI words)
 */
export const JOB_RESOLVED_TOPIC_COUNT = 4;
/** 2 characters of `0x` plus 3 ABI words of 64 hex characters each. */
export const JOB_RESOLVED_DATA_HEX_LENGTH = 2 + 3 * 64;

/**
 * JobExpired(uint256 indexed jobId, address indexed buyer, uint256 budget)
 *
 * topics[0] = signature hash                (32-byte Hex)
 * topics[1] = jobId                         (32-byte Hex word)
 * topics[2] = buyer, left-padded            (32-byte Hex word)
 * data      = budget                        (one ABI word)
 */
export const JOB_EXPIRED_TOPIC_COUNT = 3;
/** 2 characters of `0x` plus 1 ABI word of 64 hex characters. */
export const JOB_EXPIRED_DATA_HEX_LENGTH = 2 + 64;

/** Canonical verdict decisions: 1 = complete, 2 = reject. Nothing else exists. */
export const CANONICAL_DECISIONS = [1, 2] as const;
export type CanonicalDecision = (typeof CANONICAL_DECISIONS)[number];

/** A raw log as returned by an RPC receipt. */
export type CanonicalLog = TransferLog;

// ===========================================================================
// Safe error codes (mapped to UNVERIFIED / CONFLICT in verification.ts)
// ===========================================================================

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

const HEX_WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function hexWord(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !HEX_WORD_RE.test(value)) {
    fail('CANONICAL_EVENT_MALFORMED', `${field} must be a 32-byte Hex word`);
  }
  return value as Hex;
}

function hexWordToBigInt(value: unknown, field: string): bigint {
  return BigInt(hexWord(value, field));
}

function addressFromTopic(value: unknown, field: string): Address {
  const word = hexWord(value, field);
  const body = word.slice(2);
  if (body.slice(0, 24) !== '0'.repeat(24)) {
    fail('CANONICAL_EVENT_MALFORMED', `${field} is not a left-padded 20-byte address`);
  }
  const address = `0x${body.slice(24)}`;
  if (!ADDRESS_RE.test(address)) {
    fail('CANONICAL_EVENT_MALFORMED', `${field} is not a valid address`);
  }
  return address as Address;
}

function uint8WordToDecision(value: unknown, field: string): CanonicalDecision {
  const word = hexWord(value, field);
  if (word.slice(2, 64) !== '0'.repeat(62)) {
    fail('CANONICAL_EVENT_MALFORMED', `${field} must encode a uint8 decision`);
  }
  const numeric = Number(BigInt(word));
  if (numeric !== 1 && numeric !== 2) {
    fail('CANONICAL_EVENT_INVALID_DECISION', `${field} must be exactly 1 (complete) or 2 (reject)`);
  }
  return numeric as CanonicalDecision;
}

function hexData(value: unknown, exactLength: number, field: string): string {
  if (typeof value !== 'string' || !HEX_RE.test(value) || value.length !== exactLength) {
    fail(
      'CANONICAL_EVENT_MALFORMED',
      `${field} must be exactly ${exactLength} Hex characters (0x plus ABI words)`
    );
  }
  return value.slice(2);
}

function assertProtocol(log: CanonicalLog, expectedProtocol: Address): void {
  if (typeof expectedProtocol !== 'string' || !ADDRESS_RE.test(expectedProtocol)) {
    fail('CANONICAL_EVENT_WRONG_ADDRESS', 'expected protocol address must be a 20-byte Hex address');
  }
  if (!sameAddress(log.address, expectedProtocol)) {
    fail('CANONICAL_EVENT_WRONG_ADDRESS', `log address ${String(log.address)} is not the expected protocol`);
  }
}

// ===========================================================================
// Canonical event shapes
// ===========================================================================

export interface JobResolvedEvent {
  type: 'JobResolved';
  jobId: bigint;
  attestor: Address;
  decision: CanonicalDecision;
  verdictDigest: Hex;
  evidenceCommitment: Hex;
  reasonCommitment: Hex;
}

export interface JobExpiredEvent {
  type: 'JobExpired';
  jobId: bigint;
  buyer: Address;
  budget: bigint;
}

export type CanonicalSettlementEvent = JobResolvedEvent | JobExpiredEvent;

// ===========================================================================
// Strict decoders
// ===========================================================================

/**
 * Decode a single log as a canonical JobResolved event.
 * Throws instead of returning any partial result.
 */
export function decodeJobResolvedLog(log: CanonicalLog, expectedProtocol: Address): JobResolvedEvent {
  assertProtocol(log, expectedProtocol);
  const topics = log.topics;

  if (!Array.isArray(topics) || topics.length !== JOB_RESOLVED_TOPIC_COUNT) {
    fail('CANONICAL_EVENT_MALFORMED', `JobResolved requires exactly ${JOB_RESOLVED_TOPIC_COUNT} topics`);
  }
  if (!sameAddress(topics[0] ?? null, JOB_RESOLVED_TOPIC)) {
    fail('CANONICAL_EVENT_WRONG_TOPIC', `topics[0] is not ${JOB_RESOLVED_SIGNATURE}`);
  }

  const data = hexData(log.data, JOB_RESOLVED_DATA_HEX_LENGTH, 'JobResolved data');

  return {
    type: 'JobResolved',
    jobId: hexWordToBigInt(topics[1], 'topics[1] (jobId)'),
    attestor: addressFromTopic(topics[2], 'topics[2] (attestor)'),
    decision: uint8WordToDecision(`0x${data.slice(0, 64)}`, 'data word 0 (decision)'),
    verdictDigest: hexWord(topics[3], 'topics[3] (verdictDigest)'),
    evidenceCommitment: hexWord(`0x${data.slice(64, 128)}`, 'data word 1 (evidenceCommitment)'),
    reasonCommitment: hexWord(`0x${data.slice(128, 192)}`, 'data word 2 (reasonCommitment)'),
  };
}

/**
 * Decode a single log as a canonical JobExpired event.
 * Throws instead of returning any partial result.
 */
export function decodeJobExpiredLog(log: CanonicalLog, expectedProtocol: Address): JobExpiredEvent {
  assertProtocol(log, expectedProtocol);
  const topics = log.topics;

  if (!Array.isArray(topics) || topics.length !== JOB_EXPIRED_TOPIC_COUNT) {
    fail('CANONICAL_EVENT_MALFORMED', `JobExpired requires exactly ${JOB_EXPIRED_TOPIC_COUNT} topics`);
  }
  if (!sameAddress(topics[0] ?? null, JOB_EXPIRED_TOPIC)) {
    fail('CANONICAL_EVENT_WRONG_TOPIC', `topics[0] is not ${JOB_EXPIRED_SIGNATURE}`);
  }

  const data = hexData(log.data, JOB_EXPIRED_DATA_HEX_LENGTH, 'JobExpired data');

  return {
    type: 'JobExpired',
    jobId: hexWordToBigInt(topics[1], 'topics[1] (jobId)'),
    buyer: addressFromTopic(topics[2], 'topics[2] (buyer)'),
    budget: BigInt(`0x${data.slice(0, 64)}`),
  };
}

// ===========================================================================
// Expectation-checked readers (used by the canonical settlement verifier)
// ===========================================================================

function isCandidate(log: CanonicalLog, expectedProtocol: Address, topic: Hex): boolean {
  if (!sameAddress(log.address, expectedProtocol)) return false;
  const signature = log.topics?.[0];
  return typeof signature === 'string' && signature.toLowerCase() === topic.toLowerCase();
}

function onlyCandidate(
  logs: readonly CanonicalLog[],
  expectedProtocol: Address,
  topic: Hex,
  eventName: string
): CanonicalLog {
  const candidates = logs.filter(log => isCandidate(log, expectedProtocol, topic));
  if (candidates.length === 0) {
    fail('CANONICAL_EVENT_NOT_FOUND', `receipt has no ${eventName} log from ${expectedProtocol}`);
  }
  if (candidates.length > 1) {
    fail('CANONICAL_EVENT_AMBIGUOUS', `receipt has ${candidates.length} ${eventName} logs from ${expectedProtocol}`);
  }
  return candidates[0] as CanonicalLog;
}

function sameHexWord(observed: Hex, expected: Hex, code: string, field: string): void {
  if (typeof expected !== 'string' || !HEX_WORD_RE.test(expected)) {
    fail('CANONICAL_EVENT_MALFORMED', `expected ${field} must be a 32-byte Hex value`);
  }
  if (observed.toLowerCase() !== expected.toLowerCase()) {
    fail(code, `${field} in the event does not match the expected ${field}`);
  }
}

export interface JobResolvedExpectation {
  protocol: Address;
  jobId: bigint;
  attestor: Address;
  decision: CanonicalDecision;
  verdictDigest: Hex;
  evidenceCommitment: Hex;
  reasonCommitment: Hex;
}

export interface JobExpiredExpectation {
  protocol: Address;
  jobId: bigint;
  buyer: Address;
  budget: bigint;
}

/**
 * Return the single canonical JobResolved event from a receipt and prove it
 * matches every expected field. Requires the expected protocol address.
 */
export function readJobResolvedEvent(
  logs: readonly CanonicalLog[],
  expected: JobResolvedExpectation
): JobResolvedEvent {
  const log = onlyCandidate(logs, expected.protocol, JOB_RESOLVED_TOPIC, JOB_RESOLVED_SIGNATURE);
  const event = decodeJobResolvedLog(log, expected.protocol);

  if (event.jobId !== expected.jobId) {
    fail('CANONICAL_EVENT_JOB_MISMATCH', `event jobId ${event.jobId} is not ${expected.jobId}`);
  }
  if (!sameAddress(event.attestor, expected.attestor)) {
    fail('CANONICAL_EVENT_ATTESTOR_MISMATCH', `event attestor ${event.attestor} is not ${expected.attestor}`);
  }
  if (event.decision !== expected.decision) {
    fail('CANONICAL_EVENT_DECISION_MISMATCH', `event decision ${event.decision} is not ${expected.decision}`);
  }
  sameHexWord(event.verdictDigest, expected.verdictDigest, 'CANONICAL_EVENT_VERDICT_DIGEST_MISMATCH', 'verdictDigest');
  sameHexWord(
    event.evidenceCommitment,
    expected.evidenceCommitment,
    'CANONICAL_EVENT_EVIDENCE_MISMATCH',
    'evidenceCommitment'
  );
  sameHexWord(event.reasonCommitment, expected.reasonCommitment, 'CANONICAL_EVENT_REASON_MISMATCH', 'reasonCommitment');

  return event;
}

/**
 * Return the single canonical JobExpired event from a receipt and prove it
 * matches every expected field. Requires the expected protocol address.
 */
export function readJobExpiredEvent(logs: readonly CanonicalLog[], expected: JobExpiredExpectation): JobExpiredEvent {
  const log = onlyCandidate(logs, expected.protocol, JOB_EXPIRED_TOPIC, JOB_EXPIRED_SIGNATURE);
  const event = decodeJobExpiredLog(log, expected.protocol);

  if (event.jobId !== expected.jobId) {
    fail('CANONICAL_EVENT_JOB_MISMATCH', `event jobId ${event.jobId} is not ${expected.jobId}`);
  }
  if (!sameAddress(event.buyer, expected.buyer)) {
    fail('CANONICAL_EVENT_BUYER_MISMATCH', `event buyer ${event.buyer} is not ${expected.buyer}`);
  }
  if (event.budget !== expected.budget) {
    fail('CANONICAL_EVENT_BUDGET_MISMATCH', `event budget ${event.budget} is not ${expected.budget}`);
  }

  return event;
}
