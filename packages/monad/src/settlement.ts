/**
 * Canonical settlement verification for XYXDeliveryProtocol (Monad Testnet).
 *
 * The canonical protocol is the only settlement source: a terminal job resolves
 * through `resolveJob` and emits JobResolved (decision 1 = complete paid to the
 * provider, decision 2 = reject refunded to the buyer), or expires and emits
 * JobExpired when `claimExpiryRefund` returns the budget to the buyer.
 *
 * Legacy `AgenticCommerce` / `XYXEvaluator` events are never decoded here.
 *
 * Vocabulary: LIVE_VERIFIED (finalized facts match), REJECT (a real finalized
 * protocol rejection was observed), PENDING (no terminal outcome yet). Every
 * other outcome throws a coded error that `categorizeError` maps to UNVERIFIED
 * (unavailable, malformed, incomplete, unfinalized, wrong chain) or CONFLICT
 * (independently observed finalized evidence disagrees).
 *
 * @module @xyx/monad/settlement
 */

import type { Address, Hex } from 'viem';

import {
  assertMonadTestnet,
  matchedCanonicalJob,
  readCanonicalJob,
  type CanonicalChainReader,
  type CanonicalFinalizedBlock,
} from './canonical-chain';
import { readJobExpiredEvent, readJobResolvedEvent } from './canonical-events';
import { finalizedReceipt, sameAddress, tokenTransfers, type TransferLog } from './chain-primitives';
import type { JobData, JobVerdictData } from './protocol';
import { hashVerdictDigest } from './verdict';

/** Canonical JobStatus enum values from XYXDeliveryProtocol.sol. */
export const CANONICAL_JOB_STATUS = {
  Proposed: 0,
  Accepted: 1,
  Funded: 2,
  Submitted: 3,
  Completed: 4,
  Rejected: 5,
  Expired: 6,
  Cancelled: 7,
} as const;

export type SettlementState = 'PENDING' | 'LIVE_VERIFIED' | 'REJECT';
export type SettlementOutcome = 'COMPLETE' | 'REJECT' | 'EXPIRED';

export interface CanonicalSettlementInput {
  /** Canonical XYXDeliveryProtocol address. Required: never optional evidence. */
  protocol: Address;
  /** Immutable ERC-20 payment token of the protocol. */
  token: Address;
  jobId: bigint;
  /** Expected canonical verdict (public commitments only, never private payloads). */
  verdict?: JobVerdictData;
  resolveTx?: Hex;
  refundTx?: Hex;
}

export interface CanonicalSettlementResult {
  state: SettlementState;
  outcome?: SettlementOutcome;
  transactionHash?: Hex;
  blockNumber?: bigint;
  blockHash?: Hex;
  observation?: CanonicalFinalizedBlock;
  recipient?: Address;
  amount?: bigint;
}

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Require exactly one ERC-20 Transfer inside the receipt: protocol -> expected
 * recipient for the whole escrowed budget.
 */
function requireSingleProtocolTransfer(
  logs: readonly TransferLog[],
  token: Address,
  protocol: Address,
  recipient: Address,
  budget: bigint
): void {
  const transfers = tokenTransfers(logs, token);
  const fromProtocol = transfers.filter(row => sameAddress(row.from, protocol));
  if (
    fromProtocol.length !== 1 ||
    !sameAddress(fromProtocol[0]!.to, recipient) ||
    BigInt(fromProtocol[0]!.value) !== budget
  ) {
    fail(
      'SETTLEMENT_TOKEN_TRANSFER_MISMATCH',
      `expected one ${budget.toString()} token transfer from ${protocol} to ${recipient}`
    );
  }
}

async function finalizedReceiptAcrossRpc(primary: CanonicalChainReader, secondary: CanonicalChainReader, hash: Hex) {
  await assertMonadTestnet(primary, 'PRIMARY_WRONG_CHAIN');
  await assertMonadTestnet(secondary, 'SECONDARY_WRONG_CHAIN');
  const [first, second] = await Promise.all([finalizedReceipt(primary, hash), finalizedReceipt(secondary, hash)]);
  const describe = (value: Awaited<ReturnType<typeof finalizedReceipt>>) =>
    JSON.stringify({
      status: value.receipt.status,
      to: value.receipt.to,
      block: value.receipt.blockNumber.toString(),
      blockHash: value.receipt.blockHash,
      logs: value.receipt.logs.map(log => ({ address: log.address, data: log.data, topics: log.topics })),
    });
  if (describe(first) !== describe(second)) fail('RPC_RECEIPT_MISMATCH');
  return first;
}

function requireVerdictBinding(jobId: bigint, job: JobData, verdict: JobVerdictData | undefined): JobVerdictData {
  if (!verdict) fail('SETTLEMENT_VERDICT_DATA_MISSING', 'the canonical verdict is required for this terminal status');
  if (verdict.jobId !== jobId) {
    fail('SETTLEMENT_VERDICT_JOB_MISMATCH', `verdict jobId ${verdict.jobId} is not ${jobId}`);
  }
  if (!sameHex(verdict.termsCommitment, job.termsCommitment)) {
    fail('SETTLEMENT_TERMS_COMMITMENT_MISMATCH', 'verdict termsCommitment differs from the on-chain job');
  }
  if (!sameHex(verdict.deliveryCommitment, job.deliveryCommitment)) {
    fail('SETTLEMENT_DELIVERY_COMMITMENT_MISMATCH', 'verdict deliveryCommitment differs from the on-chain job');
  }
  return verdict;
}


/**
 * Verify the terminal settlement of one canonical job.
 *
 * `primary` and `secondary` must be two independent Monad Testnet RPCs. Both
 * chain IDs are checked, the finalized job state must match, the settlement
 * receipt bytes must match, and the receipt must carry the strict canonical
 * event plus exactly one escrow transfer.
 */
export async function verifySettlement(
  primary: CanonicalChainReader,
  secondary: CanonicalChainReader | undefined,
  input: CanonicalSettlementInput
): Promise<CanonicalSettlementResult> {
  const { protocol, token, jobId, verdict, resolveTx, refundTx } = input;
  if (typeof protocol !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(protocol) || protocol === '0x0000000000000000000000000000000000000000') {
    fail('SETTLEMENT_PROTOCOL_REQUIRED', 'the canonical protocol address is required');
  }
  if (typeof token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(token) || token === '0x0000000000000000000000000000000000000000') {
    fail('SETTLEMENT_TOKEN_REQUIRED', 'the canonical payment token address is required');
  }
  if (typeof jobId !== 'bigint' || jobId <= 0n) fail('INVALID_JOB_ID: jobId must be positive');

  await assertMonadTestnet(primary, 'PRIMARY_WRONG_CHAIN');
  const observed = await readCanonicalJob(primary, protocol, jobId);

  if (
    observed.status === CANONICAL_JOB_STATUS.Proposed ||
    observed.status === CANONICAL_JOB_STATUS.Accepted ||
    observed.status === CANONICAL_JOB_STATUS.Funded ||
    observed.status === CANONICAL_JOB_STATUS.Submitted
  ) {
    return { state: 'PENDING' };
  }
  if (observed.status === CANONICAL_JOB_STATUS.Cancelled) {
    fail('SETTLEMENT_CANCELLED_JOB', 'a cancelled proposal never escrowed funds and has no settlement');
  }
  if (!secondary) fail('Secondary RPC is required for LIVE_VERIFIED');

  const { job, observation } = await matchedCanonicalJob(primary, secondary, protocol, jobId);
  if (job.status !== observed.status) {
    fail('OBSERVATION_BLOCK_MISMATCH', 'finalized job state changed between the primary reads');
  }
  if (job.status === CANONICAL_JOB_STATUS.Expired) {
    return verifyExpiryRefund(primary, secondary, { protocol, token, jobId, refundTx }, job, observation);
  }
  if (job.status === CANONICAL_JOB_STATUS.Completed || job.status === CANONICAL_JOB_STATUS.Rejected) {
    return verifyVerdictOutcome(primary, secondary, { protocol, token, jobId, verdict, resolveTx }, job, observation);
  }
  fail('SETTLEMENT_UNSUPPORTED_STATUS', `status ${job.status} has no settlement path`);
}

type TerminalBinding = { protocol: Address; token: Address; jobId: bigint };

async function verifyVerdictOutcome(
  primary: CanonicalChainReader,
  secondary: CanonicalChainReader,
  input: TerminalBinding & { verdict?: JobVerdictData; resolveTx?: Hex },
  job: JobData,
  observation: CanonicalFinalizedBlock
): Promise<CanonicalSettlementResult> {
  const { protocol, token, jobId, verdict, resolveTx } = input;
  const expectedDecision = job.status === CANONICAL_JOB_STATUS.Completed ? 1 : 2;
  const bound = requireVerdictBinding(jobId, job, verdict);
  if (bound.decision !== expectedDecision) {
    fail(
      'SETTLEMENT_STATUS_DECISION_MISMATCH',
      `verdict decision ${bound.decision} does not match terminal status ${job.status}`
    );
  }
  if (bound.issuedAt > bound.expiresAt) {
    fail('SETTLEMENT_VERDICT_TIMESTAMP_MISMATCH', 'verdict expiresAt must be after issuedAt');
  }
  if (bound.expiresAt > job.expiresAt) {
    fail('SETTLEMENT_VERDICT_EXPIRY_MISMATCH', 'verdict expiresAt exceeds the job expiry');
  }
  if (!resolveTx) fail('SETTLEMENT_VERDICT_TX_MISSING', 'the resolution transaction hash is required');

  const { receipt, block } = await finalizedReceiptAcrossRpc(primary, secondary, resolveTx);
  if (!sameAddress(receipt.to, protocol)) {
    fail('SETTLEMENT_WRONG_PROTOCOL_TARGET', `resolution transaction target ${String(receipt.to)} is not the protocol`);
  }
  if (receipt.status !== 'success') fail('TRANSACTION_REVERTED', 'the resolution transaction reverted');
  if (block.timestamp >= job.expiresAt) {
    fail('SETTLEMENT_RESOLVED_AFTER_EXPIRY', 'the resolution receipt is at or after the job expiry');
  }

  readJobResolvedEvent(receipt.logs, {
    protocol,
    jobId,
    attestor: job.attestor,
    decision: expectedDecision,
    verdictDigest: hashVerdictDigest(bound, protocol),
    evidenceCommitment: bound.evidenceCommitment,
    reasonCommitment: bound.reasonCommitment,
  });

  const recipient = expectedDecision === 1 ? job.provider : job.buyer;
  requireSingleProtocolTransfer(receipt.logs, token, protocol, recipient, job.budget);

  return {
    state: expectedDecision === 1 ? 'LIVE_VERIFIED' : 'REJECT',
    outcome: expectedDecision === 1 ? 'COMPLETE' : 'REJECT',
    transactionHash: resolveTx,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    observation,
    recipient,
    amount: job.budget,
  };
}

async function verifyExpiryRefund(
  primary: CanonicalChainReader,
  secondary: CanonicalChainReader,
  input: TerminalBinding & { refundTx?: Hex },
  job: JobData,
  observation: CanonicalFinalizedBlock
): Promise<CanonicalSettlementResult> {
  const { protocol, token, jobId, refundTx } = input;
  if (!refundTx) fail('SETTLEMENT_REFUND_DATA_MISSING', 'the expiry refund transaction hash is required');

  const { receipt, block } = await finalizedReceiptAcrossRpc(primary, secondary, refundTx);
  if (!sameAddress(receipt.to, protocol)) {
    fail('SETTLEMENT_WRONG_PROTOCOL_TARGET', `refund transaction target ${String(receipt.to)} is not the protocol`);
  }
  if (receipt.status !== 'success') fail('TRANSACTION_REVERTED', 'the expiry refund transaction reverted');
  if (block.timestamp < job.expiresAt) {
    fail('SETTLEMENT_INVALID_EXPIRY_REFUND', 'the refund receipt predates the job expiry');
  }

  readJobExpiredEvent(receipt.logs, { protocol, jobId, buyer: job.buyer, budget: job.budget });
  requireSingleProtocolTransfer(receipt.logs, token, protocol, job.buyer, job.budget);

  return {
    state: 'LIVE_VERIFIED',
    outcome: 'EXPIRED',
    transactionHash: refundTx,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    observation,
    recipient: job.buyer,
    amount: job.budget,
  };
}
