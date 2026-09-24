/**
 * XYX Monad SDK — Canonical public API surface.
 *
 * These exports are safe to import from browser components.
 * Private commitment data, salts, credentials, and key material
 * never leave the browser by default.
 *
 * @module @xyx/monad
 */

// Config and validation
export {
  ENV,
  MONAD_TESTNET_CHAIN_ID,
  ZERO_ADDRESS,
  readConfig,
  validateConfig,
  isValidAddress,
  isNonZeroAddress,
  isValidRpId,
  formatAddress,
  formatHash,
  type XYXConfig,
} from './config';

// Commitments and privacy
//
// There is exactly ONE canonical commitment family. The domain labels and the
// salt/validator primitives are re-exported here from ./commitments; the actual
// creators (createTermsCommitment, createDeliveryCommitment,
// createEvidenceCommitment, createReasonCommitment) plus credentialIdToCommitment
// are re-exported from ./delivery and ./passkey further below. The former
// ASCII-interpolated creators (termsCommitment, deliveryCommitment,
// evidenceCommitment, reasonCommitment, credentialIdCommitment) were removed
// from the public surface: zero production consumers, and a divergent algorithm
// that hashed ASCII text — see ./commitments for the canonical binary format.
export {
  TERMS_COMMITMENT_DOMAIN,
  DELIVERY_COMMITMENT_DOMAIN,
  EVIDENCE_COMMITMENT_DOMAIN,
  REASON_COMMITMENT_DOMAIN,
  CREDENTIAL_ID_COMMITMENT_DOMAIN,
  APP_PRF_SALT,
  generateSalt,
  validateSalt,
  validateTermsPayload,
  termsSummary,
  type TermsPayload,
  type TermsSummary,
} from './commitments';

// Canonical XYXDeliveryProtocol / XYXPasskeyRegistry ABIs and read helpers
export {
  deliveryProtocolAbi,
  passkeyRegistryAbi,
  createXYXClient,
  readJob,
  readJobCounter,
  readPaymentToken,
  readMaxVerdictLifetime,
  readCredentialOf,
  readRegistryRpIdHash,
  validateProtocolConfig,
  jobStatusLabel,
  JOB_STATUS_LABELS,
  type JobStatus,
  type JobData,
  type JobVerdictData,
  type PasskeyCredential,
  type TxStatus,
  type ProtocolConfigStatus,
} from './protocol';

// ===========================================================
// Legacy RPC primitives (re-exported via payout from chain-primitives)
// ===========================================================

// Note: sameAddress, tokenTransfers, finalizedReceipt, encodeErc20Transfer,
// TransferLog, Receipt, ReceiptReader are re-exported from ./payout below.

// ===========================================================
// Canonical modules
// ===========================================================

// Canonical delivery schemas and commitments
export {
  privateTermsSchema,
  privateDeliverySchema,
  privateEvidenceSchema,
  privateReasonSchema,
  deploymentConfigSchema,
  publicStatusSchema,
  jobVerdictSchema,
  createTermsCommitment,
  createDeliveryCommitment,
  createEvidenceCommitment,
  createReasonCommitment,
  buildVerdict,
  toSolidityVerdict,
  hashVerdict,
  validateAddress,
  validatePositiveIntegerString,
  validateChainId,
  validateDeadline,
  assertNoSecretFields,
  isStrictJsonValue,
  strictJsonToCanonicalBytes,
  validatedToCanonicalBytes,
  type PrivateTermsInput,
  type PrivateDeliveryInput,
  type PrivateEvidenceInput,
  type PrivateReasonInput,
  type DeploymentConfig,
  type PublicStatus,
  type JobVerdictInput,
  type StrictJsonValue,
} from './delivery';

// Canonical chain API with Monad Testnet guard
// Note: readJobCounter re-exported from delivery-chain (same impl as protocol)
export {
  createMonadClient,
  validateContractAddresses,
  buildProposalRequest,
  buildAcceptRequest,
  buildCancelProposalRequest,
  buildFundRequest,
  buildSubmitRequest,
  buildResolveRequest,
  buildClaimExpiryRefundRequest,
  readJobData,
  readVerdictConsumed,
  fetchTxReceipt,
  waitForFinalization,
  extractSettlementEvent,
  computeDomainSeparator,
  DEFAULT_MONAD_RPC,
  type ContractAddresses,
  type ContractRequest,
  type SolidityJobStatus,
  type ProposalParams,
  type AcceptParams,
  type CancelProposalParams,
  type FundParams,
  type SubmissionParams,
  type ResolutionParams,
  type ExpiryRefundParams,
  type WebAuthnAssertionInput,
  type ReadJobOptions,
  type TxReceiptInfo,
} from './delivery-chain';

// Strict canonical XYXDeliveryProtocol event decoding (evidence-grade)
export {
  JOB_RESOLVED_SIGNATURE,
  JOB_EXPIRED_SIGNATURE,
  JOB_RESOLVED_TOPIC,
  JOB_EXPIRED_TOPIC,
  JOB_RESOLVED_TOPIC_COUNT,
  JOB_EXPIRED_TOPIC_COUNT,
  JOB_RESOLVED_DATA_HEX_LENGTH,
  JOB_EXPIRED_DATA_HEX_LENGTH,
  CANONICAL_DECISIONS,
  decodeJobResolvedLog,
  decodeJobExpiredLog,
  readJobResolvedEvent,
  readJobExpiredEvent,
  type CanonicalDecision,
  type CanonicalLog,
  type CanonicalSettlementEvent,
  type JobResolvedEvent,
  type JobExpiredEvent,
  type JobResolvedExpectation,
  type JobExpiredExpectation,
} from './canonical-events';

// Canonical EIP-712 verdict digest (single implementation)
export {
  VERDICT_CHAIN_ID,
  VERDICT_TYPEHASH_STRING,
  EIP712_DOMAIN_TYPEHASH_STRING,
  computeVerdictDomainSeparator,
  hashVerdictDigest,
} from './verdict';

// Canonical finalized reads and cross-RPC agreement
export {
  assertMonadTestnet,
  finalizedBlock,
  validateJobData,
  readCanonicalJob,
  sameCanonicalJob,
  matchedCanonicalJob,
  matchedFinalizedReceipt,
  viemPublicClientToCanonicalChainReader,
  type CanonicalChainReader,
  type CanonicalFinalizedBlock,
} from './canonical-chain';
export { MONAD_TESTNET_CHAIN_ID as CANONICAL_MONAD_TESTNET_CHAIN_ID } from './config';

// Canonical passkey and WebAuthn helpers
export {
  toBase64url,
  fromBase64url,
  derEcdsaToRS,
  derEcdsaToConcatRS,
  p256PublicKeyToHex,
  parseAuthenticatorData,
  verifyRpIdHash,
  computeRpIdHash,
  isWebAuthnAvailable,
  checkWebAuthnSupport,
  createXYXPasskey,
  startXYXSession,
  getActiveSession,
  wipeSession,
  endSession,
  credentialIdToCommitment,
  performActionCeremony,
  validateRpIdOrigin,
  parseAuthenticatorFlags,
  readSignCount,
  wipeBytes,
  wipeAll,
  type XYXPskCredential,
  type XYXPskSession,
  type ParsedAuthenticatorData,
  type ParsedClientDataJSON,
  type AuthenticatorFlags,
  type ActionCeremonyOptions,
  type ActionCeremonyResult,
  type CreateXYXPasskeyOptions,
} from './passkey';

// Canonical provenance schemas (no secrets)
export {
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
  type DeploymentEnvironment,
  type DeploymentStage,
  type DeploymentStageResult,
  type DraftDeploymentRecord,
  type FinalDeploymentRecord,
  type BindingRecord,
  type ProvenanceVerification,
  type ContractDeployment,
} from './provenance';

// ===========================================================
// Canonical manifest schema (COMPLETE / REJECT / EXPIRED)
// ===========================================================

export {
  canonicalManifestSchema,
  canonicalRunSchema,
  type CanonicalManifest,
  type CanonicalRun,
} from './manifest';

export {
  CANONICAL_JOB_STATUS,
  verifySettlement,
  type SettlementState,
  type SettlementOutcome,
  type CanonicalSettlementInput,
  type CanonicalSettlementResult,
} from './settlement';

export {
  verificationErrors,
  categorizeError,
  verificationLabel,
  type VerificationCategory,
  type VerificationError,
} from './verification';

export {
  EvidenceStorage,
  PublicEvidenceReader,
  publicEvidenceReaderFromEnvironment,
  evidenceStorageFromEnvironment,
} from './storage';

// ===========================================================
// Non-broadcast deployment readiness (C0 dry-run harness)
// ===========================================================

export {
  EXPECTED_CHAIN_ID,
  EXPECTED_TOKEN_DECIMALS,
  CANONICAL_CONTRACTS,
  NATIVE_TRANSFER_GAS_LIMIT,
  MAX_GAS_BUFFER_BPS,
  MONAD_TX_GAS_LIMIT_CAP,
  READINESS_ENV_KEYS,
  READINESS_FAILURE_CODES,
  READINESS_STATUS,
  SECRET_ENV_NAME_PATTERN,
  TOKEN_DECIMALS_SELECTOR,
  TOKEN_SYMBOL_SELECTOR,
  GasBufferError,
  assertReportHasNoSecrets,
  checkGasLimitWithinTxCap,
  isDeploymentEnvName,
  isReportableEnvKey,
  isSecretEnvName,
  normalizeEndpoint,
  redactRpcUrl,
  redactUrlsInText,
  resolveGasLimit,
  rpIdToHash,
  runReadiness,
  serializeReadinessReport,
  type CanonicalContractName,
  type GasLimitDecision,
  type ReadinessArtifact,
  type ReadinessCheck,
  type ReadinessEnv,
  type ReadinessFailureCode,
  type ReadinessObservedChainIds,
  type ReadinessOptions,
  type ReadinessReport,
  type ReadinessRpcProbe,
  type ReadinessRpcProbes,
  type ReadinessStatus,
} from './deployment-readiness';

// Internal engineering workflow: real-only, advisory Jev triage.
// It cannot authorize a merge, deploy, broadcast, signature, or settlement.
export {
  WORKFLOW_REPORT_SCHEMA,
  WORKFLOW_TRIAGE_SCHEMA,
  TYPESAFE_SYSTEM_ONE_URL,
  workflowReportSchema,
  parseWorkflowReport,
  determineWorkflowHardGate,
  runJevWorkflowTriage,
  type WorkflowReport,
  type WorkflowReviewLane,
  type WorkflowHardGate,
  type ClaimIntegrity,
  type ChoiceJudgment,
  type JevWorkflowAssessment,
  type WorkflowTriageResult,
} from './workflow-triage';

// Checkpoint-by-checkpoint implementer supervision. Deterministic ownership and
// gates override Jev; output can only route correction/review work.
export {
  SUPERVISOR_REPORT_SCHEMA,
  SUPERVISOR_RESULT_SCHEMA,
  supervisorCheckpointSchema,
  parseSupervisorCheckpoint,
  inspectSupervisorCheckpoint,
  runJevBuildSupervisor,
  type SupervisorStage,
  type SupervisorClaimIntegrity,
  type SupervisorJevLane,
  type SupervisorCheck,
  type SupervisorNextAction,
  type SupervisorCheckpoint,
  type SupervisorDeterministicState,
  type SupervisorJevAssessment,
  type SupervisorResult,
} from './workflow-supervisor';

// ===========================================================
// Retired payout/commerce API (explicitly namespaced)
//
// `export * as legacy` keeps the retired AgenticCommerce /
// XYXEvaluator surface off the canonical entry point. Import it
// only for historical read-only reference:
//
//   import { legacy } from '@xyx/monad';
//
// Canonical modules and new code must not use it.
// ===========================================================

export * as legacy from './legacy';
