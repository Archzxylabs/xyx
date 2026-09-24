/**
 * Durable operation types for the canonical XYX platform layer.
 *
 * This module is the vocabulary of a versioned, restart-safe operation journal.
 * Every type here is deliberately free of secrets: no private key, seed phrase,
 * raw signed transaction, calldata, passkey material, private term, or raw
 * private evidence may appear in an operation record. The only chain-adjacent
 * values permitted are those a wallet or an RPC node already publishes to the
 * world: addresses, job IDs, transaction hashes, block numbers, and observed
 * receipt facts.
 *
 * The status vocabulary is the reason this module exists. `PREPARED`,
 * `SUBMITTED`, `PENDING_FINALITY`, `AMBIGUOUS`, `FINALIZED`, and `FAILED` mean
 * strictly different things about what has been *proven*, and
 * `ALLOWED_OPERATION_TRANSITIONS` is the single authority on which steps are
 * legal between them. A caller never sets a status directly: it calls
 * `nextOperationStatus`, which renders an illegal step unrepresentable rather
 * than merely discouraged.
 *
 * @module @xyx/monad/operations
 */

import type { Address, Hex } from 'viem';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * Current durable-operation schema version. A reader that encounters a stored
 * row with an unknown `schema` refuses to interpret it rather than guessing.
 */
export const OPERATION_SCHEMA = 'xyx.monad.operation.v1' as const;
export type OperationSchema = typeof OPERATION_SCHEMA;

/**
 * Runtime representation of a hex 0x-prefixed 32-byte value.
 *
 * Deliberately structural rather than viem's `Hex`: this module must not couple
 * the journal's shape to any client library. Every function that accepts one
 * validates the shape, so a malformed value cannot enter a record through the
 * back door of type inference.
 */
export type Hash = `0x${string}`;

// ---------------------------------------------------------------------------
// Actor roles
// ---------------------------------------------------------------------------

/**
 * The canonical lifecycle roles.
 *
 * `SERVER` is intentionally first and is never a signing actor: it records that
 * the server observed or brokered an operation without ever holding a
 * capability. A server process may never act as buyer, provider, or attestor
 * signer, so no server-held operation may carry a signing role.
 */
export type OperationActorRole = 'buyer' | 'provider' | 'attestor' | 'server';

/** Roles that a server-side operation is allowed to be recorded for. */
export const SERVER_RECORDABLE_ROLES: readonly OperationActorRole[] = ['server'];

// ---------------------------------------------------------------------------
// Operation kinds
// ---------------------------------------------------------------------------

/**
 * Every kind of operation the journal understands.
 *
 * These are the canonical lifecycle actions of `XYXDeliveryProtocol` plus the
 * publish action of the canonical publisher, and nothing else. There is
 * deliberately no generic `SIGN` or `SEND_RAW` kind, because a journal that
 * could describe an arbitrary transaction could also be used to launder one
 * past the lifecycle rules this module enforces.
 */
export type OperationKind =
  | 'PROPOSE_JOB'
  | 'ACCEPT_JOB'
  | 'FUND_JOB'
  | 'SUBMIT_DELIVERY'
  | 'RESOLVE_JOB'
  | 'CANCEL_PROPOSAL'
  | 'CLAIM_EXPIRY_REFUND'
  | 'PUBLISH_CANONICAL_MANIFEST';

export const OPERATION_KINDS: readonly OperationKind[] = [
  'PROPOSE_JOB',
  'ACCEPT_JOB',
  'FUND_JOB',
  'SUBMIT_DELIVERY',
  'RESOLVE_JOB',
  'CANCEL_PROPOSAL',
  'CLAIM_EXPIRY_REFUND',
  'PUBLISH_CANONICAL_MANIFEST',
];

/** Lifecycle actions that terminate a job's existence on chain. */
export const TERMINAL_JOB_ACTIONS: readonly OperationKind[] = [
  'RESOLVE_JOB',
  'CANCEL_PROPOSAL',
  'CLAIM_EXPIRY_REFUND',
];

// ---------------------------------------------------------------------------
// Lifecycle status
// ---------------------------------------------------------------------------

/**
 * Where a single operation stands, defined by what evidence exists.
 *
 * The invariant the whole module defends:
 *
 *   PREPARED             — the operation was computed. Nothing reached a chain.
 *   SUBMITTED            — a wallet or mempool acknowledged it and returned a hash.
 *   PENDING_FINALITY     — the hash's block exists but required observations do
 *                          not yet agree that it is final.
 *   AMBIGUOUS            — the send produced no usable hash. The operation's
 *                          true effect is unknowable without operator action.
 *   FINALIZED            — both independent RPCs attested a successful,
 *                          matching receipt.
 *   FAILED               — a deterministic precondition or postcondition failed.
 *
 * `FINALIZED` is reachable only from `PENDING_FINALITY`, which is reachable
 * only from `SUBMITTED`. So a `PREPARED` operation skips at minimum two
 * independent evidence gates before it can read as final, and `AMBIGUOUS` is a
 * dead end from which the journal will not move an operation on its own.
 */
export type OperationStatus =
  | 'PREPARED'
  | 'SUBMITTED'
  | 'PENDING_FINALITY'
  | 'AMBIGUOUS'
  | 'FINALIZED'
  | 'FAILED';

export const OPERATION_STATUSES: readonly OperationStatus[] = [
  'PREPARED',
  'SUBMITTED',
  'PENDING_FINALITY',
  'AMBIGUOUS',
  'FINALIZED',
  'FAILED',
];

/** Statuses from which no further automatic transition is permitted. */
export const OPERATION_TERMINAL_STATUSES: readonly OperationStatus[] = ['FINALIZED', 'AMBIGUOUS', 'FAILED'];

/**
 * The single authority on legal status steps.
 *
 * Read this as: from the key status, you may move only to the listed statuses.
 * Anything not listed is impossible — `nextOperationStatus` throws
 * `OPERATION_TRANSITION_INVALID` rather than returning a value the caller might
 * mistake for acceptance.
 */
export const ALLOWED_OPERATION_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = Object.freeze({
  // A prepared operation has been computed locally and nothing else. It may be
  // handed to a wallet, sealed as ambiguous (the wallet never answered), or
  // already ruled out by a deterministic check.
  PREPARED: ['SUBMITTED', 'AMBIGUOUS', 'FAILED', 'PENDING_FINALITY'],

  // A returned hash is real but proves nothing about finality yet. The normal
  // next step is to await agreement; a receipt that is already agreed upon is
  // legal too, which is what makes restart-reconciliation safe.
  SUBMITTED: ['PENDING_FINALITY', 'FINALIZED', 'AMBIGUOUS', 'FAILED'],

  // Finality is knowable only once both RPCs agree. `FAILED` is legal here
  // because an RPC disagreement can prove a receipt is not what it seemed.
  // `AMBIGUOUS` is NOT: a pending hash is not a missing hash.
  PENDING_FINALITY: ['FINALIZED', 'FAILED'],

  // A dead end by design. The only way out is a human resolving it, and the
  // journal never makes that resolution itself. Auto-retry is structurally
  // forbidden because AMBIGUOUS lists no successors.
  AMBIGUOUS: [],

  // Final. Any further step would be a second, conflicting submission.
  FINALIZED: [],

  // Failed. Recoverable only by starting a NEW operation with a NEW
  // idempotency key, never by editing this one.
  FAILED: [],
});

/**
 * Move an operation to `next`, or throw.
 *
 * The caller cannot accidentally enact an illegal transition. This is a
 * function rather than a lookup so that every transition in the codebase is
 * forced to pass through one check.
 */
export function nextOperationStatus(from: OperationStatus, to: OperationStatus): OperationStatus {
  if (!OPERATION_STATUSES.includes(from)) throw new Error(`OPERATION_STATUS_INVALID: ${String(from)}`);
  if (!OPERATION_STATUSES.includes(to)) throw new Error(`OPERATION_STATUS_INVALID: ${String(to)}`);
  if (!ALLOWED_OPERATION_TRANSITIONS[from].includes(to)) {
    throw new Error(`OPERATION_TRANSITION_INVALID: ${from} -> ${to} is not an allowed transition`);
  }
  return to;
}

/** True when no further automatic transition is permitted. */
export function isOperationTerminal(status: OperationStatus): boolean {
  return OPERATION_TERMINAL_STATUSES.includes(status);
}

/**
 * True when an operation may be retried automatically.
 *
 * `AMBIGUOUS` is excluded explicitly and by name, even though it is not
 * already terminal, so the intent survives any future edit to the transition
 * table above.
 */
export function isOperationAutoRetryable(status: OperationStatus): boolean {
  return status !== 'AMBIGUOUS' && status !== 'FINALIZED' && status !== 'FAILED';
}

// ---------------------------------------------------------------------------
// Stable failure codes
// ---------------------------------------------------------------------------

/**
 * Machine-readable failure codes.
 *
 * These are the only values a caller should branch on. Every one is stable and
 * names a precondition or postcondition, never an internal detail.
 */
export type OperationFailureCode =
  | 'OPERATION_SCHEMA_UNSUPPORTED'
  | 'OPERATION_ID_INVALID'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'OPERATION_KIND_INVALID'
  | 'ACTOR_ADDRESS_INVALID'
  | 'ACTOR_ROLE_INVALID'
  | 'SERVER_ROLE_NOT_RECORDABLE'
  | 'CHAIN_ID_MISMATCH'
  | 'DEPLOYMENT_BINDING_INCOMPLETE'
  | 'DEPLOYMENT_BINDING_MISMATCH'
  | 'JOB_ID_MISSING'
  | 'JOB_ID_REQUIRED_FOR_KIND'
  | 'INTENT_DIGEST_INVALID'
  | 'NONCE_INVALID'
  | 'NONCE_ALREADY_USED'
  | 'TRANSACTION_HASH_INVALID'
  | 'TRANSACTION_HASH_REQUIRED'
  | 'OPERATION_TRANSITION_INVALID'
  | 'OPERATION_STATUS_INVALID'
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_ALREADY_FINALIZED'
  | 'SIGNER_BUSY'
  | 'LEASE_NOT_HELD'
  | 'SECRET_SHAPED_INPUT_REJECTED'
  | 'UNKNOWN_FIELD_REJECTED'
  | 'RECEIPT_OBSERVATION_INCOMPLETE'
  | 'RECONCILIATION_CONFLICT'
  | 'RECONCILIATION_EVIDENCE_PRESERVED'
  | 'STORAGE_PATH_REQUIRED'
  | 'STORAGE_DURABILITY_REFUSED';

export class OperationError extends Error {
  readonly code: OperationFailureCode;

  constructor(code: OperationFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OperationError';
    this.code = code;
  }

  /**
   * The safe public projection of this error.
   *
   * Returns only the stable code and a diagnostic that is safe by construction
   * because every throw site in this module passes a message built solely from
   * validated, non-secret values.
   */
  toPublic(): OperationErrorPublic {
    return { code: this.code, message: this.message };
  }
}

/** The only error shape that may leave this module. */
export interface OperationErrorPublic {
  readonly code: OperationFailureCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Deployment binding
// ---------------------------------------------------------------------------

/**
 * The canonical deployment the operation is bound to.
 *
 * A binding is required in full (protocol, registry, verifier) because an
 * operation observed against a partially-known deployment cannot be attributed
 * to a specific canonical system. `paymentToken` is required as well: it is
 * both an access-control value in the protocol and the denominator of every
 * amount in the run, so omitting it would make the binding unable to detect a
 * job whose terms were minted against a different token.
 */
export interface OperationDeploymentBinding {
  readonly protocol: Address;
  readonly registry: Address;
  readonly verifier: Address;
  readonly paymentToken: Address;
}

export type OperationDeploymentBindingInput = Partial<Record<keyof OperationDeploymentBinding, unknown>>;

const ADDRESS_SOURCE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_SOURCE = `0x${'0'.repeat(40)}`;

/**
 * Validate and normalise a deployment binding.
 *
 * Every field must be a well-formed, non-zero address. A zero address is
 * refused outright rather than passed through, because a zero binding would let
 * an operation attest to a deployment that does not exist.
 */
export function validateDeploymentBinding(input: OperationDeploymentBindingInput): OperationDeploymentBinding {
  if (input === null || typeof input !== 'object') {
    throw new OperationError('DEPLOYMENT_BINDING_INCOMPLETE', 'a deployment binding object is required');
  }
  const out: Record<keyof OperationDeploymentBinding, Address> = {} as Record<keyof OperationDeploymentBinding, Address>;
  for (const field of ['protocol', 'registry', 'verifier', 'paymentToken'] as const) {
    const value = input[field];
    if (typeof value !== 'string' || !ADDRESS_SOURCE.test(value)) {
      throw new OperationError(
        'DEPLOYMENT_BINDING_INCOMPLETE',
        `deployment binding field ${field} must be a 0x-prefixed address`
      );
    }
    if (value.toLowerCase() === ZERO_ADDRESS_SOURCE) {
      throw new OperationError(
        'DEPLOYMENT_BINDING_MISMATCH',
        `deployment binding field ${field} must not be the zero address`
      );
    }
    out[field] = value as Address;
  }
  return out as OperationDeploymentBinding;
}

/** True when two bindings describe the same canonical deployment. */
export function sameDeploymentBinding(a: OperationDeploymentBinding, b: OperationDeploymentBinding): boolean {
  return (
    a.protocol.toLowerCase() === b.protocol.toLowerCase()
    && a.registry.toLowerCase() === b.registry.toLowerCase()
    && a.verifier.toLowerCase() === b.verifier.toLowerCase()
    && a.paymentToken.toLowerCase() === b.paymentToken.toLowerCase()
  );
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * A single RPC endpoint's observation of a receipt.
 *
 * `rpc` identifies *which* endpoint observed it, and is a label the operator
 * assigned — never a URL. Full RPC URLs are credentials in most deployments and
 * are refused here so one cannot reach a report by way of an operation record.
 */
export type ReceiptObservationSource = 'primary' | 'secondary';

export interface ReceiptObservation {
  readonly source: ReceiptObservationSource;
  /** Operator-assigned label for the RPC endpoint. Never a URL. */
  readonly rpc: string;
  readonly blockNumber: number;
  readonly blockHash: Hash;
  readonly status: 'success' | 'reverted';
}

/**
 * The result of comparing the required independent observations.
 *
 * `PENDING` means at least one required observation is missing. `AGREED` means
 * both arrived and matched. `DISAGREED` means both arrived and did not match —
 * the single most important reason an operation can fail to finalize.
 */
export type ReconciliationResult = 'NOT_STARTED' | 'PENDING' | 'AGREED' | 'DISAGREED';

/**
 * What the caller is allowed to know about an operation's finality.
 *
 * This is the integration boundary: it carries only the fact of finality, the
 * agreement that proves it, and operator-assigned RPC labels. It carries no
 * full RPC URL, no credential, and no lifecycle status that could be mistaken
 * for a submission.
 */
export interface OperationFinalityObservation {
  /** Derived from the recorded observations, never asserted by a caller. */
  readonly reconciliation: ReconciliationResult;
  /** True: the journal never treats one observation as sufficient. */
  readonly requiresAgreement: boolean;
  /** True when at least one required observation has arrived. */
  readonly finalityObserving: boolean;
  /** Operator labels only. Never a URL, never a credential. */
  readonly observedRpcLabels: readonly string[];
  readonly sourcesRequired: readonly ReceiptObservationSource[];
  readonly sourcesObserved: readonly ReceiptObservationSource[];
  /** When the operation was created, in epoch seconds. */
  readonly createdAtEpochSeconds: number;
}

/**
 * What the caller is allowed to know about finality.
 *
 * This is the integration boundary: it carries only the fact of finality and
 * the observations that prove it. No status string that could be mistaken for
 * a submission, no calldata, no keys.
 */
export interface FinalityObservation {
  readonly reconciliation: ReconciliationResult;
  readonly requiredSources: readonly ReceiptObservationSource[];
  readonly observedSources: readonly ReceiptObservationSource[];
  readonly blockNumber: number | null;
  readonly blockHash: Hash | null;
}

// ---------------------------------------------------------------------------
// The durable operation record
// ---------------------------------------------------------------------------

/**
 * One durable operation.
 *
 * Every field is public and non-secret by construction. Note what is absent:
 * there is no calldata field, no raw transaction field, no private-term field,
 * no raw-evidence field. The only digest is `intentDigest`, which commits to
 * the *meaning* of the operation so a replayed body with different parameters
 * is detectable, without ever recording the parameters that would carry
 * private input.
 */
export interface OperationRecord {
  readonly schema: OperationSchema;
  /** Stable identifier of this operation. */
  readonly id: string;
  /** Caller-supplied de-duplication key. Unique across the journal. */
  readonly idempotencyKey: string;
  readonly kind: OperationKind;
  readonly actor: Address;
  readonly actorRole: OperationActorRole;
  /** The chain this operation is bound to; only Monad Testnet exists. */
  readonly expectedChainId: number;
  readonly deployment: OperationDeploymentBinding;
  /** Present once the on-chain job is known. */
  readonly jobId: number | null;
  /** Digest committing to the operation's intent and parameters. */
  readonly intentDigest: Hash;
  /** Present only when a nonce was supplied or observed. */
  readonly nonce: number | null;
  /** Present ONLY once a wallet or mempool returned a real hash. */
  readonly transactionHash: Hash | null;
  /** Epoch seconds. */
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: OperationStatus;
  readonly receiptObservations: readonly ReceiptObservation[];
  readonly reconciliation: ReconciliationResult;
  readonly failureCode: OperationFailureCode | null;
  /** A public diagnostic. Must never contain calldata, keys, or private content. */
  readonly diagnostic: string | null;
}

/** Input for creating an operation. Omits everything the journal owns. */
export interface NewOperationInput {
  readonly idempotencyKey: string;
  readonly kind: OperationKind;
  readonly actor: Address;
  readonly actorRole: OperationActorRole;
  readonly expectedChainId: number;
  readonly deployment: OperationDeploymentBinding;
  readonly jobId?: number | null;
  readonly intentDigest: Hash;
  readonly nonce?: number | null;
}

// ---------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------

/** Canonical chain ID. Monad Testnet only. */
export const CANONICAL_CHAIN_ID = 10143 as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const DIGEST_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function validateOperationId(id: unknown): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new OperationError(
      'OPERATION_ID_INVALID',
      'an operation id is 8-128 characters of letters, digits, dot, underscore, or hyphen'
    );
  }
  return id;
}

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new OperationError('IDEMPOTENCY_KEY_REQUIRED', 'an idempotency key is required');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new OperationError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'an idempotency key is 8-200 characters of letters, digits, dot, underscore, colon, or hyphen'
    );
  }
  return key;
}

export function validateOperationKind(kind: unknown): OperationKind {
  if (typeof kind !== 'string' || !OPERATION_KINDS.includes(kind as OperationKind)) {
    throw new OperationError('OPERATION_KIND_INVALID', `unknown operation kind: ${String(kind)}`);
  }
  return kind as OperationKind;
}

/** Normalise, validate, and checksum-free check an address. */
export function validateOperationAddress(value: unknown, code: OperationFailureCode = 'ACTOR_ADDRESS_INVALID'): Address {
  if (typeof value !== 'string' || !ADDRESS_SOURCE.test(value)) {
    throw new OperationError(code, 'expected a 0x-prefixed 20-byte address');
  }
  return value as Address;
}

export function validateActorRole(role: unknown): OperationActorRole {
  if (typeof role !== 'string' || !['buyer', 'provider', 'attestor', 'server'].includes(role)) {
    throw new OperationError('ACTOR_ROLE_INVALID', `unknown actor role: ${String(role)}`);
  }
  return role as OperationActorRole;
}

export function validateChainId(chainId: unknown): number {
  if (chainId !== CANONICAL_CHAIN_ID) {
    throw new OperationError(
      'CHAIN_ID_MISMATCH',
      `only Monad Testnet chain id ${CANONICAL_CHAIN_ID} is accepted`
    );
  }
  return CANONICAL_CHAIN_ID;
}

export function validateIntentDigest(value: unknown): Hash {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new OperationError('INTENT_DIGEST_INVALID', 'an intent digest must be a 32-byte hex value');
  }
  return value as Hash;
}

export function validateTransactionHash(value: unknown): Hash {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new OperationError('TRANSACTION_HASH_INVALID', 'a transaction hash must be a 32-byte hex value');
  }
  return value as Hash;
}

export function validateNonce(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OperationError('NONCE_INVALID', 'a nonce must be a non-negative safe integer');
  }
  return value;
}

/**
 * Whether a lifecycle kind needs a job ID to be meaningful.
 *
 * `PUBLISH_CANONICAL_MANIFEST` is the only kind that can legitimately exist
 * without a job: it publishes an aggregate over runs whose job IDs may not be
 * known yet. Every lifecycle action is a call into a specific job.
 */
export function kindRequiresJobId(kind: OperationKind): boolean {
  return kind !== 'PUBLISH_CANONICAL_MANIFEST';
}

// ---------------------------------------------------------------------------
// Secret-shaped input rejection
// ---------------------------------------------------------------------------

/**
 * Key names that must never appear in a journal-facing request body, matched
 * case-insensitively against a normalised form (non-alphanumerics removed) so
 * `private_key`, `privateKey`, and `PRIVATE-KEY` are all caught.
 */
export const SECRET_FIELD_NAMES: readonly string[] = [
  'privatekey',
  'secretkey',
  'seedphrase',
  'mnemonic',
  'signature',
  'signedtransaction',
  'signedtx',
  'rawtransaction',
  'rawtx',
  'transactionpayload',
  'passkey',
  'webauthn',
  'authenticatordata',
  'clientdatajson',
  'credentialid',
  'prfoutput',
  'prf',
  'privatematerial',
  'privatekeyhex',
  'apitoken',
  'accesstoken',
  'bearertoken',
  'pinatajwt',
  'jwt',
  'authorization',
  'authorizationheader',
  'rpcpassword',
  'rpcurl',
  'rpcauth',
  'infurakey',
  'alchemykey',
  'mnemonicphrase',
];

/**
 * Value shapes that indicate a secret regardless of field name.
 *
 * Applied to every string in the request body as a second, independent layer:
 * a caller cannot get a credential past the name filter by calling the field
 * something innocuous.
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^0x[0-9a-fA-F]{64}$/,          // bare 32-byte hex (raw key / PRF output)
  /^0x[0-9a-fA-F]{130,}$/,        // longer raw hex blob (raw signed tx)
  /^-----BEGIN [A-Z ]*PRIVATE KEY/,// PEM private key
  /^S\/[0-9]+[A-Z0-9]{8,}$/,       // SLIP-39 seed fragment
  /^(?:[a-z]+\s+){11,23}[a-z]+$/,  // 12/15/18/21/24-word mnemonic phrase
];

/**
 * Field names the schema itself defines as holding a 32-byte hex value.
 *
 * `SECRET_VALUE_PATTERNS[0]` exists to catch a bare private key or PRF output
 * under an innocuous field name. Without this exemption it also catches
 * `intentDigest`, `transactionHash`, and `blockHash` — all of which are
 * required fields — and would make the journal unusable.
 *
 * The exemption is deliberately narrow: it applies only to the exact-32-byte
 * rule, and only to these three fields. Every other pattern (longer hex blobs,
 * PEM keys, SLIP-39 fragments, mnemonic phrases) still applies to them, and no
 * other field is exempted.
 */
export const KNOWN_DIGEST_FIELD_NAMES: readonly string[] = [
  'intentdigest',
  'transactionhash',
  'blockhash',
];

/** Index of the bare-32-byte-hex rule, the only one a digest field may skip. */
const BARE_32_BYTE_HEX_PATTERN_INDEX = 0;

/**
 * True when `name` is a field this module's own schema defines as a 32-byte
 * hex value, so the credential heuristic must not fire on it.
 */
function isKnownDigestField(name: string): boolean {
  return KNOWN_DIGEST_FIELD_NAMES.includes(normaliseFieldName(name));
}

/** The leaf field name of a dotted path, e.g. `receiptObservations[0].blockHash`. */
function leafFieldName(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] ?? '';
}

export interface SecretRejection {
  readonly field: string;
  readonly reason: string;
}

function normaliseFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Scan an arbitrary value for secret-shaped content.
 *
 * Returns the first rejection found, or `null`. Traverses plain objects and
 * arrays with a depth limit, so a deeply nested body cannot be used to hide a
 * credential from the scan or to exhaust the scanner.
 */
export function findSecretShapedValue(
  value: unknown,
  path = '',
  depth = 0
): SecretRejection | null {
  if (depth > 12) return { field: path || '.', reason: 'the request body is nested too deeply to scan' };

  if (typeof value === 'string') {
    const exempt = isKnownDigestField(leafFieldName(path));
    for (let index = 0; index < SECRET_VALUE_PATTERNS.length; index += 1) {
      if (exempt && index === BARE_32_BYTE_HEX_PATTERN_INDEX) continue;
      const pattern = SECRET_VALUE_PATTERNS[index];
      if (pattern?.test(value.trim())) {
        return {
          field: path || '.',
          reason: 'a value in the request body has the shape of a credential or signed material',
        };
      }
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findSecretShapedValue(value[i], `${path}[${i}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_NAMES.includes(normaliseFieldName(key))) {
        return { field: path ? `${path}.${key}` : key, reason: 'this field name is never accepted' };
      }
      const found = findSecretShapedValue(child, path ? `${path}.${key}` : key, depth + 1);
      if (found) return found;
    }
    return null;
  }

  return null;
}

/**
 * Reject any request body that carries a secret-shaped field or value.
 *
 * Throws `SECRET_SHAPED_INPUT_REJECTED`. This runs before anything else touches
 * the body, so no secret-bearing field can reach a record, a log line, or a
 * response — the rejection path itself never echoes the offending value.
 */
export function assertNoSecrets(value: unknown): void {
  const rejection = findSecretShapedValue(value);
  if (rejection) {
    throw new OperationError(
      'SECRET_SHAPED_INPUT_REJECTED',
      `rejected ${rejection.field}: ${rejection.reason}`
    );
  }
}

/**
 * Reject unknown top-level keys.
 *
 * Allow-listing rather than deny-listing is what makes `UNKNOWN_FIELD_REJECTED`
 * meaningful: a field this module has never heard of cannot be silently stored,
 * so a future caller cannot smuggle a credential into the journal under a key
 * that no review has considered.
 */
export function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new OperationError('UNKNOWN_FIELD_REJECTED', `unknown field rejected: ${key}`);
    }
  }
}
