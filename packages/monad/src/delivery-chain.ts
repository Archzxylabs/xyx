/**
 * XYX Canonical Chain API
 *
 * ABI re-exports and types for 3 Monad contracts, chain ID 10143 guard,
 * typed request builders for each protocol action, and receipt/finality helpers.
 *
 * @module @xyx/monad/delivery-chain
 */

import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';
import { validateChainId, validateAddress } from './delivery';
import { ABIs } from './protocol';
import type { JobData, JobVerdictData, PasskeyCredential } from './protocol';
import {
  JOB_EXPIRED_TOPIC,
  JOB_RESOLVED_TOPIC,
  decodeJobExpiredLog,
  decodeJobResolvedLog,
  type CanonicalSettlementEvent,
} from './canonical-events';
import { sameAddress } from './chain-primitives';
import { computeVerdictDomainSeparator } from './verdict';

// ===========================================================================
// Chain configuration
// ===========================================================================

/** Monad Testnet chain ID — hard guard to prevent cross-chain use. */
export const MONAD_TESTNET_CHAIN_ID = 10143;

/** Default Monad Testnet RPC. */
export const DEFAULT_MONAD_RPC = 'https://testnet-rpc.monad.xyz';

export function createMonadClient(rpcUrl?: string): PublicClient {
  validateChainId(MONAD_TESTNET_CHAIN_ID);
  const url = rpcUrl ?? DEFAULT_MONAD_RPC;
  const transport = http(url);
  return createPublicClient({
    chain: monadTestnet,
    transport,
  });
}
// ===========================================================================
// Contract addresses
// ===========================================================================

export interface ContractAddresses {
  protocol: Address;
  registry: Address;
  p256Verifier: Address;
  paymentToken?: Address;
}

export function validateContractAddresses(addresses: {
  protocol: unknown;
  registry: unknown;
  p256Verifier: unknown;
  paymentToken?: unknown;
}): ContractAddresses {
  return {
    protocol: validateAddress(addresses.protocol, 'protocol'),
    registry: validateAddress(addresses.registry, 'registry'),
    p256Verifier: validateAddress(addresses.p256Verifier, 'p256Verifier'),
    paymentToken: addresses.paymentToken !== undefined
      ? validateAddress(addresses.paymentToken, 'paymentToken')
      : undefined,
  };
}

// ===========================================================================
// SolidityJobStatus enum values (0-7 matching contract)
// ===========================================================================

export type SolidityJobStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

// Re-export types from protocol for convenience
export type { JobData, JobVerdictData, PasskeyCredential };

// ===========================================================================
// Request builders
//
// Every builder returns the canonical target, function name, and calldata
// arguments for XYXDeliveryProtocol.sol. Where the contract restricts msg.sender
// (buyer, provider, attestor), the optional caller field is validated and echoed
// as `from` so a caller can prove which wallet must sign.
// ===========================================================================

export interface ContractRequest {
  abi: readonly unknown[];
  address: Address;
  functionName: string;
  args: readonly unknown[];
  /** Expected msg.sender when the contract restricts the caller. */
  from?: Address;
}

function protocolCall(
  addresses: ContractAddresses,
  functionName: string,
  args: readonly unknown[],
  caller?: Address,
  callerField?: string
): ContractRequest {
  const request: ContractRequest = {
    abi: ABIs.deliveryProtocol as readonly unknown[],
    address: addresses.protocol,
    functionName,
    args,
  };
  if (caller !== undefined) {
    request.from = validateAddress(caller, callerField ?? 'caller');
  }
  return request;
}

export interface ProposalParams {
  provider: Address;
  attestor: Address;
  budget: bigint;
  termsCommitment: Hex;
  expiresAt: bigint;
  /** msg.sender of proposeJob; the contract stores it as the job buyer. */
  buyer?: Address;
}

export function buildProposalRequest(
  params: ProposalParams,
  addresses: ContractAddresses,
  chainId = MONAD_TESTNET_CHAIN_ID
): ContractRequest {
  validateChainId(chainId);
  const provider = validateAddress(params.provider, 'provider');
  const attestor = validateAddress(params.attestor, 'attestor');
  if (params.budget <= 0n) throw new Error('INVALID_BUDGET: budget must be positive');
  if (params.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error('INVALID_EXPIRY: expiresAt must be in the future');
  }
  if (typeof params.termsCommitment !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(params.termsCommitment)) {
    throw new Error('INVALID_TERMS_COMMITMENT: termsCommitment must be a 32-byte Hex value');
  }
  if (/^0x0{64}$/.test(params.termsCommitment)) {
    throw new Error('INVALID_TERMS_COMMITMENT: termsCommitment must not be zero');
  }
  if (provider.toLowerCase() === attestor.toLowerCase()) {
    throw new Error('INVALID_PARTICIPANTS: provider must differ from attestor');
  }
  if (params.buyer !== undefined) {
    const buyer = validateAddress(params.buyer, 'buyer');
    // XYXDeliveryProtocol.proposeJob: provider == msg.sender || attestor == msg.sender reverts.
    if (buyer.toLowerCase() === provider.toLowerCase()) {
      throw new Error('INVALID_CALLER: buyer must differ from provider');
    }
    if (buyer.toLowerCase() === attestor.toLowerCase()) {
      throw new Error('INVALID_CALLER: buyer must differ from attestor');
    }
  }

  return protocolCall(
    addresses,
    'proposeJob',
    [provider, attestor, params.termsCommitment, params.budget, params.expiresAt],
    params.buyer,
    'buyer'
  );
}

export interface AcceptParams {
  jobId: bigint;
  /** msg.sender of acceptJob; the contract requires the job provider. */
  provider?: Address;
}

export function buildAcceptRequest(
  params: AcceptParams,
  addresses: ContractAddresses,
  chainId = MONAD_TESTNET_CHAIN_ID
): ContractRequest {
  validateChainId(chainId);
  if (params.jobId <= 0n) throw new Error('INVALID_JOB_ID');
  return protocolCall(addresses, 'acceptJob', [params.jobId], params.provider, 'provider');
}

export interface CancelProposalParams {
  jobId: bigint;
  /** msg.sender of cancelProposal; the contract requires the job buyer. */
  buyer?: Address;
}

export function buildCancelProposalRequest(
  params: CancelProposalParams,
  addresses: ContractAddresses,
  chainId = MONAD_TESTNET_CHAIN_ID
): ContractRequest {
  validateChainId(chainId);
  if (params.jobId <= 0n) throw new Error('INVALID_JOB_ID');
  return protocolCall(addresses, 'cancelProposal', [params.jobId], params.buyer, 'buyer');
}

export interface FundParams {
  jobId: bigint;
  /** msg.sender of fundJob; the contract requires the job buyer. */
  buyer?: Address;
}

export function buildFundRequest(
  params: FundParams,
  addresses: ContractAddresses,
  chainId = MONAD_TESTNET_CHAIN_ID
): ContractRequest {
  validateChainId(chainId);
  if (params.jobId <= 0n) throw new Error('INVALID_JOB_ID');
  return protocolCall(addresses, 'fundJob', [params.jobId], params.buyer, 'buyer');
}

export interface SubmissionParams {
  jobId: bigint;
  deliveryCommitment: Hex;
  /** msg.sender of submitDelivery; the contract requires the job provider. */
  provider?: Address;
}

export function buildSubmitRequest(
  params: SubmissionParams,
  addresses: ContractAddresses,
  chainId = MONAD_TESTNET_CHAIN_ID
): ContractRequest {
  validateChainId(chainId);
  if (params.jobId <= 0n) throw new Error('INVALID_JOB_ID');
  if (typeof params.deliveryCommitment !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(params.deliveryCommitment)) {
    throw new Error('INVALID_DELIVERY_COMMITMENT: deliveryCommitment must be a 32-byte Hex value');
  }
  if (/^0x0{64}$/.test(params.deliveryCommitment)) {
    throw new Error('INVALID_DELIVERY_COMMITMENT: deliveryCommitment must not be zero');
  }

  return protocolCall(
    addresses,
    'submitDelivery',
    [params.jobId, params.deliveryCommitment],
    params.provider,
    'provider'
  );
}

export interface WebAuthnAssertionInput {
  /**
   * 0x-prefixed `bytes` — arbitrary length.
   */
  authenticatorData: Hex;
  /**
   * The WebAuthn clientDataJSON as a plain UTF-8 `string`.
   *
   * This is NOT Hex and is never hex-encoded here: Solidity declares the field
   * `string clientDataJSON`, so viem must UTF-8 encode it. Re-encoding an
   * already-encoded string would change the signed bytes and break the P-256
   * verification inside XYXPasskeyRegistry.
   */
  clientDataJSON: string;
  challengeIndex: number;
  typeIndex: number;
  /** 32-byte hex: exactly 0x + 64 hex characters. */
  r: Hex;
  /** 32-byte hex: exactly 0x + 64 hex characters. */
  s: Hex;
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function assertHexBytes(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`INVALID_ASSERTION: ${field} must be 0x-prefixed byte Hex`);
  }
  return value as Hex;
}

function assertBytes32(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !BYTES32_RE.test(value)) {
    throw new Error(`INVALID_ASSERTION: ${field} must be a 32-byte Hex value (0x + 64 hex characters)`);
  }
  return value as Hex;
}

function assertUintIndex(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`INVALID_ASSERTION: ${field} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Validate that clientDataJSON is a UTF-8 JSON `string`, never Hex.
 *
 * `XYXPasskeyRegistry` re-serializes the clientDataJSON the verifier is handed
 * by locating a `"type":"webauthn.get"` substring at `typeIndex`, so the value
 * must arrive as the exact JSON text the authenticator signed. Hex-encoding it
 * here would shift every byte offset and silently invalidate every assertion.
 */
function assertClientDataJSON(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('INVALID_ASSERTION: clientDataJSON must be a JSON string, not Hex');
  }
  if (value.length === 0) {
    throw new Error('INVALID_ASSERTION: clientDataJSON must not be empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('INVALID_ASSERTION: clientDataJSON must be valid JSON text');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('INVALID_ASSERTION: clientDataJSON must be a JSON object');
  }
  const type = (parsed as { type?: unknown }).type;
  if (type !== 'webauthn.get') {
    throw new Error('INVALID_ASSERTION: clientDataJSON.type must be "webauthn.get"');
  }
  return value;
}

export interface ResolutionParams {
  jobId: bigint;
  /**
   * Canonical JobVerdict fields. `jobId` is injected from `params.jobId` so the
   * tuple and the call can never disagree.
   */
  verdict: {
    termsCommitment: Hex;
    deliveryCommitment: Hex;
    evidenceCommitment: Hex;
    reasonCommitment: Hex;
    decision: number;
    issuedAt: bigint;
    expiresAt: bigint;
    nonce: bigint;
  };
  /** msg.sender of resolveJob; the contract requires the job attestor. */
  attestor: Address;
  assertion: WebAuthnAssertionInput;
}

export function buildResolveRequest(
  params: ResolutionParams,
  addresses: ContractAddresses,
  chainId = MONAD_TESTNET_CHAIN_ID
): ContractRequest {
  validateChainId(chainId);
  if (params.jobId <= 0n) throw new Error('INVALID_JOB_ID');
  if (params.verdict.decision !== 1 && params.verdict.decision !== 2) {
    throw new Error('INVALID_DECISION: must be 1 (complete) or 2 (reject)');
  }
  const attestor = validateAddress(params.attestor, 'attestor');
  const verdict = {
    jobId: params.jobId,
    termsCommitment: assertBytes32(params.verdict.termsCommitment, 'termsCommitment'),
    deliveryCommitment: assertBytes32(params.verdict.deliveryCommitment, 'deliveryCommitment'),
    evidenceCommitment: assertBytes32(params.verdict.evidenceCommitment, 'evidenceCommitment'),
    reasonCommitment: assertBytes32(params.verdict.reasonCommitment, 'reasonCommitment'),
    decision: params.verdict.decision,
    issuedAt: params.verdict.issuedAt,
    expiresAt: params.verdict.expiresAt,
    nonce: params.verdict.nonce,
  };
  if (/^0x0{64}$/.test(verdict.evidenceCommitment) || /^0x0{64}$/.test(verdict.reasonCommitment)) {
    throw new Error('INVALID_COMMITMENT: evidence and reason commitments must not be zero');
  }
  const assertion = {
    authenticatorData: assertHexBytes(params.assertion.authenticatorData, 'authenticatorData'),
    // Never re-encoded, never hex-decoded: the contract declares
    // `string clientDataJSON`, so viem must UTF-8 encode this string verbatim.
    clientDataJSON: assertClientDataJSON(params.assertion.clientDataJSON),
    challengeIndex: assertUintIndex(params.assertion.challengeIndex, 'challengeIndex'),
    typeIndex: assertUintIndex(params.assertion.typeIndex, 'typeIndex'),
    r: assertBytes32(params.assertion.r, 'r'),
    s: assertBytes32(params.assertion.s, 's'),
  };

  // resolveJob(JobVerdict verdict, WebAuthn.WebAuthnAuth assertion)
  //
  // The tuple order below MUST match the field order the ABI declares, and the
  // ABI MUST match `struct WebAuthn.WebAuthnAuth` in OpenZeppelin. A parity test
  // (packages/monad/test/abi-parity.test.ts) asserts both against the compiled
  // XYXDeliveryProtocol artifact, so drift here fails `npm test`.
  return protocolCall(addresses, 'resolveJob', [verdict, assertion], attestor, 'attestor');
}

export interface ExpiryRefundParams {
  jobId: bigint;
  /**
   * Optional caller. claimExpiryRefund is permissionless: the protocol refunds
   * the recorded buyer regardless of msg.sender, so any relayer may call it.
   */
  caller?: Address;
}

export function buildClaimExpiryRefundRequest(
  params: ExpiryRefundParams,
  addresses: ContractAddresses,
  chainId = MONAD_TESTNET_CHAIN_ID
): ContractRequest {
  validateChainId(chainId);
  if (params.jobId <= 0n) throw new Error('INVALID_JOB_ID');
  return protocolCall(addresses, 'claimExpiryRefund', [params.jobId], params.caller, 'caller');
}

// ===========================================================================
// Read helpers
// ===========================================================================

export interface ReadJobOptions {
  client: PublicClient;
  addresses: ContractAddresses;
  jobId: bigint;
}

export async function readJobData(opts: ReadJobOptions): Promise<JobData> {
  const result = await opts.client.readContract({
    abi: ABIs.deliveryProtocol as readonly unknown[],
    address: opts.addresses.protocol,
    functionName: 'getJob',
    args: [opts.jobId],
  });
  return result as unknown as JobData;
}

/**
 * Read `consumedVerdicts(bytes32)`. XYXDeliveryProtocol does not store verdict
 * structs; it only records which verdict digests were already consumed.
 */
export async function readVerdictConsumed(opts: {
  client: PublicClient;
  addresses: ContractAddresses;
  verdictDigest: Hex;
}): Promise<boolean> {
  if (typeof opts.verdictDigest !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(opts.verdictDigest)) {
    throw new Error('INVALID_VERDICT_DIGEST: verdictDigest must be a 32-byte Hex value');
  }
  const result = await opts.client.readContract({
    abi: ABIs.deliveryProtocol as readonly unknown[],
    address: opts.addresses.protocol,
    functionName: 'consumedVerdicts',
    args: [opts.verdictDigest],
  });
  return result as boolean;
}

export async function readJobCounter(opts: {
  client: PublicClient;
  addresses: ContractAddresses;
}): Promise<bigint> {
  const result = await opts.client.readContract({
    abi: ABIs.deliveryProtocol as readonly unknown[],
    address: opts.addresses.protocol,
    functionName: 'jobCounter',
    args: [],
  });
  return result as bigint;
}

// ===========================================================================
// Receipt and finality helpers
// ===========================================================================

export interface TxReceiptInfo {
  blockNumber: bigint;
  transactionHash: Hex;
  status: 'success' | 'reverted';
  gasUsed: bigint;
  logs: Array<{ address: Address; topics: Hex[]; data: Hex }>;
}

export async function fetchTxReceipt(
  client: PublicClient,
  txHash: Hex
): Promise<TxReceiptInfo | null> {
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    return {
      blockNumber: receipt.blockNumber ?? 0n,
      transactionHash: receipt.transactionHash,
      status: receipt.status === 'success' ? 'success' : 'reverted',
      gasUsed: receipt.gasUsed,
      logs: receipt.logs.map(log => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
      })),
    };
  } catch {
    return null;
  }
}

export async function waitForFinalization(
  client: PublicClient,
  txHash: Hex,
  confirmations = 1
): Promise<TxReceiptInfo | null> {
  const receipt = await fetchTxReceipt(client, txHash);
  if (receipt === null) return null;

  if (receipt.status === 'success') {
    try {
      await client.waitForTransactionReceipt({
        hash: txHash,
        confirmations,
        timeout: 120_000,
      });
    } catch {
      // Receipt was found but wait timed out — return what we have
    }
  }

  return receipt;
}

/**
 * Display-only canonical settlement event lookup.
 *
 * This is the same strict decoder used by the canonical settlement verifier: it
 * requires the expected canonical protocol address, exact topic counts, exact
 * data lengths, and a canonical decision. It never produces a partial result,
 * and it never decodes legacy AgenticCommerce/XYXEvaluator events.
 */
export function extractSettlementEvent(
  receipt: TxReceiptInfo,
  expectedProtocol: Address
): CanonicalSettlementEvent | null {
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, expectedProtocol)) continue;
    const signature = log.topics?.[0];
    if (typeof signature !== 'string') continue;
    const normalized = signature.toLowerCase();
    if (normalized === JOB_RESOLVED_TOPIC.toLowerCase()) {
      return decodeJobResolvedLog(log, expectedProtocol);
    }
    if (normalized === JOB_EXPIRED_TOPIC.toLowerCase()) {
      return decodeJobExpiredLog(log, expectedProtocol);
    }
  }
  return null;
}

// ===========================================================================
// EIP-712 domain separator (single canonical implementation)
// ===========================================================================

/**
 * EIP-712 domain separator of one XYXDeliveryProtocol deployment.
 * Delegates to the canonical verdict module so the SDK can never compute two
 * different domains for the same contract.
 */
export function computeDomainSeparator(
  verifyingContract: Address,
  chainId = MONAD_TESTNET_CHAIN_ID
): Hex {
  if (chainId !== MONAD_TESTNET_CHAIN_ID) {
    throw new Error(`WRONG_NETWORK: chain ID is ${chainId}, expected ${MONAD_TESTNET_CHAIN_ID} (Monad Testnet)`);
  }
  return computeVerdictDomainSeparator(verifyingContract, chainId);
}
