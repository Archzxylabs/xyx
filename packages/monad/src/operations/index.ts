/**
 * The public status vocabulary other components depend on.
 *
 * This module is the half of the durable operation layer that other
 * implementers are allowed to import: it re-exports the narrow surface
 * described in the integration contract and deliberately omits the SQLite
 * implementation, the lease internals, and the secret scanners, none of which
 * a provider-runner or web component should need in order to read an
 * operation's lifecycle status.
 *
 * Everything here is safe to render. `OperationPublicRecord` is a projection
 * of the internal record with no additional fields, and there is no function
 * anywhere in this module that returns calldata, signed material, private
 * terms, raw private evidence, passkey material, or a storage credential.
 *
 * @module @xyx/monad/operations
 */

export {
  ALLOWED_OPERATION_TRANSITIONS,
  CANONICAL_CHAIN_ID,
  OperationError,
  OPERATION_KINDS,
  OPERATION_SCHEMA,
  OPERATION_STATUSES,
  OPERATION_TERMINAL_STATUSES,
  kindRequiresJobId,
  nextOperationStatus,
  isOperationTerminal,
  isOperationAutoRetryable,
  sameDeploymentBinding,
  validateActorRole,
  validateChainId,
  validateDeploymentBinding,
  validateIdempotencyKey,
  validateIntentDigest,
  validateNonce,
  validateOperationAddress,
  validateOperationId,
  validateOperationKind,
  validateTransactionHash,
  assertKnownFields,
  assertNoSecrets,
  findSecretShapedValue,
  SECRET_FIELD_NAMES,
  SECRET_VALUE_PATTERNS,
} from './types';

export type {
  Hash,
  NewOperationInput,
  OperationActorRole,
  OperationDeploymentBinding,
  OperationDeploymentBindingInput,
  OperationFinalityObservation,
  OperationKind,
  OperationFailureCode,
  OperationRecord,
  OperationSchema,
  OperationStatus,
  ReceiptObservation,
  ReconciliationResult,
} from './types';

export {
  canAwaitFinality,
  evaluateFinality,
  mustReadAsAmbiguous,
  observationsAreIndependent,
} from './reconciliation';

export type { FinalityEvaluation, FinalitySubject, FinalityVerdict } from './reconciliation';

// Local imports are required even though these types are re-exported above:
// a re-export is erased at compile time, so the annotations in this file's own
// function bodies still need the symbols in scope.
import type {
  OperationFinalityObservation,
  ReceiptObservation,
  ReceiptObservationSource,
  ReconciliationResult,
} from './types';

export {
  InMemoryOperationStore,
  SqliteOperationStore,
  openOperationStore,
  isDurableJournalFile,
  OperationStoreError,
} from './store';

export type {
  OperationJournal,
  SignerLease,
  SignerLeaseRequest,
  TransitionDetail,
} from './store';

/**
 * The only projection of an operation other components may see.
 *
 * This is the integration boundary in one type. It carries exactly what the
 * contract requires and nothing more:
 *
 *   - operation identifier
 *   - idempotency key
 *   - safe lifecycle status
 *   - public reconciliation result
 *   - finality observation
 *   - stable error code
 *   - safe redacted diagnostic
 *
 * It has no field for a private key, a signer capability, a raw signed
 * transaction, or full calldata, so no projection can be made to leak one.
 */
export interface OperationPublicRecord {
  readonly schema: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly actorAddress: string;
  readonly actorRole: string;
  readonly expectedChainId: number;
  readonly deployment: {
    readonly protocol: string;
    readonly registry: string;
    readonly verifier: string;
    readonly paymentToken: string;
  };
  readonly jobId: number | null;
  readonly intentDigest: string;
  readonly nonce: number | null;
  /** Present only once a wallet or mempool returned a real hash. */
  readonly transactionHash: string | null;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reconciliation: ReconciliationResult;
  readonly finality: OperationFinalityObservation;
  readonly failureCode: string | null;
  /** Safe by construction: never contains calldata, keys, or private content. */
  readonly diagnostic: string | null;
}

/** The projection function. Pure, total, and free of secret-shaped data. */
export function toPublicOperationRecord(record: {
  schema: string;
  id: string;
  idempotencyKey: string;
  kind: string;
  actor: string;
  actorRole: string;
  expectedChainId: number;
  deployment: { protocol: string; registry: string; verifier: string; paymentToken: string };
  jobId: number | null;
  intentDigest: string;
  nonce: number | null;
  transactionHash: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  reconciliation: ReconciliationResult;
  receiptObservations: readonly ReceiptObservation[];
  failureCode: string | null;
  diagnostic: string | null;
}): OperationPublicRecord {
  const sources: ReceiptObservationSource[] = record.receiptObservations.map(o => o.source);
  const finality: OperationFinalityObservation = {
    reconciliation: record.reconciliation,
    requiresAgreement: true,
    finalityObserving: sources.includes('primary') || sources.includes('secondary'),
    observedRpcLabels: uniqueSorted(record.receiptObservations.map(o => o.rpc)),
    sourcesRequired: ['primary', 'secondary'],
    sourcesObserved: uniqueSorted(sources),
    createdAtEpochSeconds: record.createdAt,
  };
  return {
    schema: record.schema,
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    kind: record.kind,
    actorAddress: record.actor,
    actorRole: record.actorRole,
    expectedChainId: record.expectedChainId,
    deployment: record.deployment,
    jobId: record.jobId,
    intentDigest: record.intentDigest,
    nonce: record.nonce,
    transactionHash: record.transactionHash,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    reconciliation: record.reconciliation,
    finality,
    failureCode: record.failureCode,
    diagnostic: record.diagnostic,
  };
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values.filter(v => typeof v === 'string' && v.length > 0))].sort();
}
