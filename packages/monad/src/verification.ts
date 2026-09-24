export type VerificationCategory = 'PENDING' | 'LIVE_VERIFIED' | 'REJECT' | 'UNVERIFIED' | 'CONFLICT';

export interface VerificationError {
  code: string;
  category: VerificationCategory;
  message: string;
}

export const verificationErrors: VerificationError[] = [
  { code: 'Public manifest configuration is incomplete', category: 'UNVERIFIED', message: 'Manifest URI or hash is not configured on the server.' },
  { code: 'Public IPFS gateway is not configured', category: 'UNVERIFIED', message: 'Public IPFS gateway is not configured.' },
  { code: 'Manifest deployment conflicts with server configuration', category: 'CONFLICT', message: 'Manifest points to a different deployment than this demo.' },
  { code: 'RPC is not Monad Testnet', category: 'UNVERIFIED', message: 'RPC is not on Monad Testnet (expected chain ID 10143).' },
  { code: 'Published specification conflicts with its commitment', category: 'CONFLICT', message: 'Specification hash does not match the on-chain commitment.' },
  { code: 'On-chain job conflicts with published specification', category: 'CONFLICT', message: 'On-chain job terms differ from the published specification.' },
  { code: 'Published verdict evidence is incomplete', category: 'UNVERIFIED', message: 'Verdict evidence is incomplete.' },
  { code: 'Stored evidence conflicts with recomputation', category: 'CONFLICT', message: 'Stored evidence conflicts with recomputed verification.' },
  { code: 'Attested decision conflicts with recomputation', category: 'CONFLICT', message: 'Attestation decision conflicts with chain verification.' },
  { code: 'Secondary RPC is required for LIVE_VERIFIED', category: 'UNVERIFIED', message: 'Secondary RPC is required for full verification.' },
  { code: 'Published contract configuration is incomplete', category: 'UNVERIFIED', message: 'Contract addresses are not configured on the server.' },
  { code: 'JOB_NOT_SUBMITTED', category: 'PENDING', message: 'Job has not been submitted yet.' },
  { code: 'RECEIPT_NOT_FINALIZED', category: 'UNVERIFIED', message: 'Transfer receipt is not yet finalized.' },
  { code: 'SUBMISSION_NOT_FINALIZED', category: 'UNVERIFIED', message: 'Submission is not yet finalized.' },
  { code: 'PRIMARY_WRONG_CHAIN', category: 'UNVERIFIED', message: 'Primary RPC is not on Monad Testnet (expected chain ID 10143).' },
  { code: 'SECONDARY_WRONG_CHAIN', category: 'UNVERIFIED', message: 'Secondary RPC is not on Monad Testnet (expected chain ID 10143).' },
  // Keep WRONG_CHAIN after the role-specific codes: matching is substring-based.
  { code: 'WRONG_CHAIN', category: 'UNVERIFIED', message: 'RPC is not on Monad Testnet (expected chain ID 10143).' },
  { code: 'WRONG_SENDER', category: 'CONFLICT', message: 'Transfer sender does not match the committed provider.' },
  { code: 'WRONG_TOKEN_TARGET', category: 'CONFLICT', message: 'Transfer token target does not match the committed token.' },
  { code: 'TRANSFER_MISMATCH', category: 'CONFLICT', message: 'Transfer recipient or amount does not match the committed terms.' },
  { code: 'TRANSFER_CALL_MISMATCH', category: 'CONFLICT', message: 'Transfer calldata does not match the committed terms.' },
  { code: 'TRANSACTION_REVERTED', category: 'CONFLICT', message: 'Provider transfer transaction reverted.' },
  { code: 'TRANSFER_AFTER_EXPIRY', category: 'CONFLICT', message: 'Provider transfer occurred after job expiry.' },
  { code: 'TRANSFER_NOT_AFTER_FUNDING', category: 'CONFLICT', message: 'Provider transfer occurred before or in the funding block.' },
  { code: 'TRANSFER_NOT_BEFORE_SUBMISSION', category: 'CONFLICT', message: 'Provider transfer occurred in or after the submission block.' },
  { code: 'SETTLEMENT_VERDICT_DATA_MISSING', category: 'UNVERIFIED', message: 'Verdict data is missing for settlement verification.' },
  { code: 'SETTLEMENT_VERDICT_TX_MISSING', category: 'UNVERIFIED', message: 'Resolution transaction hash is missing for settlement verification.' },
  { code: 'CANONICAL_PROTOCOL_ZERO', category: 'CONFLICT', message: 'Manifest or run has zero protocol address.' },
  { code: 'CANONICAL_TOKEN_ZERO', category: 'CONFLICT', message: 'Manifest or run has zero token address.' },
  { code: 'RUN_PROTOCOL_MISMATCH', category: 'CONFLICT', message: 'Run protocol address does not match the manifest protocol.' },
  { code: 'RUN_TOKEN_MISMATCH', category: 'CONFLICT', message: 'Run token address does not match the manifest token.' },
  { code: 'SETTLEMENT_PROTOCOL_REQUIRED', category: 'CONFLICT', message: 'The canonical protocol address is required for settlement verification.' },
  { code: 'SETTLEMENT_TOKEN_REQUIRED', category: 'CONFLICT', message: 'The canonical payment token address is required for settlement verification.' },
  { code: 'SETTLEMENT_CANCELLED_JOB', category: 'UNVERIFIED', message: 'A cancelled proposal has no escrow settlement to verify.' },
  { code: 'SETTLEMENT_UNSUPPORTED_STATUS', category: 'UNVERIFIED', message: 'This job status has no canonical settlement path.' },
  { code: 'SETTLEMENT_WRONG_PROTOCOL_TARGET', category: 'CONFLICT', message: 'Settlement transaction target does not match the canonical protocol.' },
  { code: 'SETTLEMENT_VERDICT_JOB_MISMATCH', category: 'CONFLICT', message: 'Verdict job ID differs from the on-chain job.' },
  { code: 'SETTLEMENT_TERMS_COMMITMENT_MISMATCH', category: 'CONFLICT', message: 'Verdict terms commitment differs from the on-chain job.' },
  { code: 'SETTLEMENT_DELIVERY_COMMITMENT_MISMATCH', category: 'CONFLICT', message: 'Verdict delivery commitment differs from the on-chain job.' },
  { code: 'SETTLEMENT_STATUS_DECISION_MISMATCH', category: 'CONFLICT', message: 'Verdict decision does not match the terminal on-chain status.' },
  { code: 'SETTLEMENT_VERDICT_TIMESTAMP_MISMATCH', category: 'CONFLICT', message: 'Verdict timestamps are internally inconsistent.' },
  { code: 'SETTLEMENT_VERDICT_EXPIRY_MISMATCH', category: 'CONFLICT', message: 'Verdict expiry exceeds the job expiry.' },
  { code: 'SETTLEMENT_RESOLVED_AFTER_EXPIRY', category: 'CONFLICT', message: 'The resolution receipt is at or after the job expiry.' },
  { code: 'SETTLEMENT_TOKEN_TRANSFER_MISMATCH', category: 'CONFLICT', message: 'Settlement token transfer does not match the expected recipient and amount.' },
  { code: 'SETTLEMENT_INVALID_EXPIRY_REFUND', category: 'CONFLICT', message: 'Expiry refund is invalid: receipt to wrong target or timestamp before expiry.' },
  { code: 'SETTLEMENT_REFUND_DATA_MISSING', category: 'UNVERIFIED', message: 'Refund transaction data is missing for expiry verification.' },
  { code: 'CANONICAL_EVENT_NOT_FOUND', category: 'UNVERIFIED', message: 'The receipt does not contain the expected canonical protocol event.' },
  { code: 'CANONICAL_EVENT_MALFORMED', category: 'UNVERIFIED', message: 'A canonical protocol log is malformed, incomplete, or oversized.' },
  { code: 'CANONICAL_EVENT_WRONG_TOPIC', category: 'UNVERIFIED', message: 'A protocol log carries a different event signature than the canonical settlement event.' },
  { code: 'CANONICAL_EVENT_WRONG_ADDRESS', category: 'UNVERIFIED', message: 'A log was not emitted by the expected canonical protocol address.' },
  { code: 'CANONICAL_EVENT_INVALID_DECISION', category: 'UNVERIFIED', message: 'A canonical verdict event carries a decision other than 1 or 2.' },
  { code: 'CANONICAL_EVENT_AMBIGUOUS', category: 'CONFLICT', message: 'The receipt contains more than one canonical settlement event for this job.' },
  { code: 'CANONICAL_EVENT_JOB_MISMATCH', category: 'CONFLICT', message: 'Canonical event job ID differs from the expected job.' },
  { code: 'CANONICAL_EVENT_ATTESTOR_MISMATCH', category: 'CONFLICT', message: 'Canonical event attestor differs from the on-chain job attestor.' },
  { code: 'CANONICAL_EVENT_DECISION_MISMATCH', category: 'CONFLICT', message: 'Canonical event decision differs from the expected verdict decision.' },
  { code: 'CANONICAL_EVENT_VERDICT_DIGEST_MISMATCH', category: 'CONFLICT', message: 'Canonical event verdict digest differs from the recomputed EIP-712 digest.' },
  { code: 'CANONICAL_EVENT_EVIDENCE_MISMATCH', category: 'CONFLICT', message: 'Canonical event evidence commitment differs from the expected commitment.' },
  { code: 'CANONICAL_EVENT_REASON_MISMATCH', category: 'CONFLICT', message: 'Canonical event reason commitment differs from the expected commitment.' },
  { code: 'CANONICAL_EVENT_BUYER_MISMATCH', category: 'CONFLICT', message: 'Canonical expiry event buyer differs from the on-chain job buyer.' },
  { code: 'CANONICAL_EVENT_BUDGET_MISMATCH', category: 'CONFLICT', message: 'Canonical expiry event budget differs from the escrowed budget.' },
  { code: 'RPC_FINALITY_MISMATCH', category: 'CONFLICT', message: 'Primary and secondary RPCs disagree on finalized block.' },
  { code: 'RPC_STATE_MISMATCH', category: 'CONFLICT', message: 'Primary and secondary RPCs return inconsistent job state.' },
  { code: 'RPC_RECEIPT_MISMATCH', category: 'CONFLICT', message: 'Primary and secondary RPCs return inconsistent receipt data.' },
  { code: 'PRIMARY_RPC_DOWN', category: 'UNVERIFIED', message: 'Primary RPC is unavailable.' },
  { code: 'SECONDARY_RPC_DOWN', category: 'UNVERIFIED', message: 'Secondary RPC is unavailable.' },
  { code: 'FINALIZED_SNAPSHOT_UNAVAILABLE', category: 'UNVERIFIED', message: 'Finalized block snapshot is unavailable.' },
  { code: 'OBSERVATION_BLOCK_MISMATCH', category: 'UNVERIFIED', message: 'Observed block does not match the finalized snapshot.' },
  { code: 'RECEIPT_BLOCK_MISMATCH', category: 'UNVERIFIED', message: 'Receipt block does not match the transaction block.' },
  { code: 'MALFORMED_READCONTRACT_RESULT', category: 'UNVERIFIED', message: 'RPC returned an uniterable result for readContract.' },
  { code: 'INVALID_IPFS_CID', category: 'UNVERIFIED', message: 'IPFS CID is invalid.' },
  { code: 'EVIDENCE_STORAGE_UNAVAILABLE', category: 'UNVERIFIED', message: 'IPFS gateway is unavailable.' },
  { code: 'EVIDENCE_TOO_LARGE', category: 'UNVERIFIED', message: 'IPFS evidence exceeds size limit.' },
  { code: 'EVIDENCE_HASH_MISMATCH', category: 'CONFLICT', message: 'IPFS evidence hash does not match the published commitment.' },
  { code: 'EVIDENCE_INVALID_JSON', category: 'UNVERIFIED', message: 'IPFS evidence is not valid JSON.' },
  { code: 'EVIDENCE_NOT_CANONICAL', category: 'CONFLICT', message: 'IPFS evidence is not in canonical JSON form.' },
  { code: 'EVIDENCE_PERSISTENCE_MISMATCH', category: 'CONFLICT', message: 'IPFS readback does not match the published evidence hash.' },
  { code: 'INCOMPLETE_VERDICT_RUN', category: 'UNVERIFIED', message: 'Published verdict run is missing required transactions or evidence.' },
  { code: 'INCOMPLETE_EXPIRY_RUN', category: 'UNVERIFIED', message: 'Published expiry run is missing the refund receipt.' },
  { code: 'SPEC_HASH_MISMATCH', category: 'CONFLICT', message: 'Run spec hash does not match the manifest commitment.' },
  { code: 'RUN_DEPLOYMENT_MISMATCH', category: 'CONFLICT', message: 'Run deployment addresses do not match the manifest.' },
  { code: 'conflict', category: 'CONFLICT', message: 'Published data conflicts with on-chain observation.' },
  { code: 'mismatch', category: 'CONFLICT', message: 'Published data conflicts with on-chain observation.' },
  { code: 'unavailable', category: 'UNVERIFIED', message: 'Verification data is currently unavailable.' },
  { code: 'incomplete', category: 'UNVERIFIED', message: 'Published run data is incomplete.' },
];

export function categorizeError(error: unknown): VerificationError {
  const message = error instanceof Error ? error.message : 'Verification unavailable';
  const upper = message.toUpperCase();
  for (const entry of verificationErrors) {
    if (upper.includes(entry.code.toUpperCase())) {
      return entry;
    }
  }
  if (/conflict|mismatch/i.test(message)) {
    return { code: 'GENERIC_CONFLICT', category: 'CONFLICT', message: 'Published data conflicts with on-chain observation.' };
  }
  if (/unavailable/i.test(message)) {
    return { code: 'GENERIC_UNAVAILABLE', category: 'UNVERIFIED', message: 'Verification data is currently unavailable.' };
  }
  if (/incomplete/i.test(message)) {
    return { code: 'GENERIC_INCOMPLETE', category: 'UNVERIFIED', message: 'Published run data is incomplete.' };
  }
  return { code: 'UNKNOWN', category: 'UNVERIFIED', message: 'Verification could not be completed.' };
}

export function verificationLabel(category: VerificationCategory, _status: string): string {
  if (category === 'LIVE_VERIFIED') return 'LIVE_VERIFIED';
  if (category === 'CONFLICT') return 'CONFLICT';
  if (category === 'UNVERIFIED') return 'UNVERIFIED';
  return 'PENDING';
}
