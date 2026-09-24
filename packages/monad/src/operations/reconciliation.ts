/**
 * Operation reconciliation: the narrow gate between evidence and FINALIZED.
 *
 * This module owns one question and refuses to answer any other: *may this
 * operation be read as FINALIZED?*
 *
 * The answer requires all of the following, and a single missing one is a
 * `RECONCILIATION_CONFLICT` rather than a reason to hedge:
 *
 *   1. a real transaction hash, not an empty one;
 *   2. at least one observation from the primary RPC and one from a *different*
 *      secondary RPC — the two are identified by their operator labels, so two
 *      endpoints with the same label can never be counted as independent;
 *   3. the two agreeing on status, block hash, and block number;
 *   4. a successful receipt status.
 *
 * When the answer is no, the operation is left exactly as it was: no
 * observation is deleted, no status is advanced, and the diagnostic names which
 * gate failed. A failed reconciliation therefore cannot erase evidence — it
 * can only record that the evidence is insufficient, which is why
 * `evaluateFinality` never mutates the operation it inspects.
 *
 * @module @xyx/monad/operations
 */

import type { ReceiptObservation, ReconciliationResult } from './types';

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type FinalityVerdict = 'FINALIZED' | 'NOT_FINALIZED';

export interface FinalityEvaluation {
  readonly verdict: FinalityVerdict;
  /** Which gates passed, for the machine-readable side of the response. */
  readonly satisfied: readonly string[];
  /** Which gates failed, each with the reason it failed. */
  readonly missing: readonly string[];
  readonly reconciliation: ReconciliationResult;
}

/** What the evaluator needs: the operation's hash and its observations. */
export interface FinalitySubject {
  readonly transactionHash: string | null;
  readonly receiptObservations: readonly ReceiptObservation[];
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Decide whether a subject may be read as FINALIZED.
 *
 * Pure: it reads, it judges, it returns. No caller can obtain a FINALIZED
 * verdict for a subject that lacks a hash or a matching pair of independent
 * observations, so no downstream code needs to re-check the same conditions.
 */
export function evaluateFinality(subject: FinalitySubject): FinalityEvaluation {
  const satisfied: string[] = [];
  const missing: string[] = [];

  // Gate 1: a real transaction hash. An empty or absent hash means the send
  // may never have happened, which is the definition of AMBIGUOUS, not PENDING.
  if (typeof subject.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(subject.transactionHash)) {
    satisfied.push('TRANSACTION_HASH_PRESENT');
  } else {
    missing.push('TRANSACTION_HASH_REQUIRED');
  }

  const observations = subject.receiptObservations;
  const primary = observations.find(o => o.source === 'primary');
  const secondary = observations.find(o => o.source === 'secondary');

  // Gate 2: exactly one observation from each required source. Extra
  // observations from unknown sources are simply ignored — they never
  // substitute for a missing required observation.
  if (primary) satisfied.push('PRIMARY_OBSERVATION_PRESENT');
  else missing.push('PRIMARY_OBSERVATION_MISSING');

  if (secondary) satisfied.push('SECONDARY_OBSERVATION_PRESENT');
  else missing.push('SECONDARY_OBSERVATION_MISSING');

  // Gate 3: the two observations come from genuinely different endpoints. The
  // rpc label is the whole basis of independence here, so identical labels are
  // a conflict even if the block facts happen to match.
  const independent = Boolean(primary && secondary && primary.rpc !== secondary.rpc);

  // Gate 4: the two agree on every fact that matters, and the receipt is a
  // success.
  const agreeing = Boolean(
    primary
    && secondary
    && primary.status === secondary.status
    && primary.blockHash === secondary.blockHash
    && primary.blockNumber === secondary.blockNumber
    && primary.status === 'success'
  );

  if (independent) satisfied.push('OBSERVATIONS_INDEPENDENT');
  else missing.push('OBSERVATIONS_NOT_INDEPENDENT');

  if (agreeing) satisfied.push('RECEIPT_FACTS_AGREE');
  else missing.push('RECEIPT_FACTS_DISAGREE');

  const reconciliation: ReconciliationResult = primary && secondary
    ? (independent && agreeing ? 'AGREED' : 'DISAGREED')
    : observations.length === 0 ? 'NOT_STARTED' : 'PENDING';

  return {
    verdict: missing.length === 0 ? 'FINALIZED' : 'NOT_FINALIZED',
    satisfied,
    missing,
    reconciliation,
  };
}

/**
 * Whether the two given sources are independent endpoints.
 *
 * Exposed so a caller that wants to record observations can decide which label
 * to use a source with before committing to it, without having to run the full
 * finality evaluation to find out.
 */
export function observationsAreIndependent(a: ReceiptObservation, b: ReceiptObservation): boolean {
  return a.source !== b.source || a.rpc !== b.rpc;
}

/**
 * Whether an operation may advance to PENDING_FINALITY.
 *
 * Requires a real hash. Without one, the operation is AMBIGUOUS: a send that
 * returned nothing cannot be polled into finality, because there is nothing to
 * look up. This is the distinction between "we know it is not final yet" and
 * "we do not know what happened at all", and it is enforced separately so
 * neither state can be manufactured by lifting the other's conditions.
 */
export function canAwaitFinality(subject: FinalitySubject): boolean {
  return typeof subject.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(subject.transactionHash);
}

/**
 * Whether an operation must be read as AMBIGUOUS.
 *
 * The complement of `canAwaitFinality`. An operation with no usable hash is
 * ambiguous forever until a human says otherwise, regardless of how many
 * observations happen to exist.
 */
export function mustReadAsAmbiguous(subject: FinalitySubject): boolean {
  return !canAwaitFinality(subject);
}
