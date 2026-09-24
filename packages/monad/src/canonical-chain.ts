/**
 * Canonical chain helpers for XYXDeliveryProtocol.
 *
 * Everything here is evidence-grade: reads are pinned to a finalized block,
 * job data is validated against the canonical `Job` struct, and cross-RPC
 * helpers require both RPCs to be Monad Testnet (chain ID 10143) and to agree
 * byte-for-byte before returning a result.
 *
 * @module @xyx/monad/canonical-chain
 */

import type { Abi, Address, Hex } from 'viem';
import { type PublicClient } from 'viem';

import { type Receipt, type Transaction, finalizedReceipt, sameAddress } from './chain-primitives';
import { MONAD_TESTNET_CHAIN_ID } from './config';
import { deliveryProtocolAbi, type JobData, type JobStatus } from './protocol';

export type CanonicalChainReader = {
  getChainId(): Promise<number>;
  getBlock(args: { blockNumber: bigint } | { blockTag: 'finalized' }): Promise<{
    number: bigint | null;
    hash: Hex | null;
    timestamp: bigint;
  }>;
  getTransaction(args: { hash: Hex }): Promise<Transaction>;
  getTransactionReceipt(args: { hash: Hex }): Promise<Receipt>;
  readContract(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown>;
};

export interface CanonicalFinalizedBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}
/** Chain guard: refuse to interpret any read that is not Monad Testnet. */
export async function assertMonadTestnet(reader: { getChainId(): Promise<number> }, code: string): Promise<void> {
  let observed: number;
  try {
    observed = await reader.getChainId();
  } catch {
    throw new Error(`${code}: RPC is unavailable before the chain ID could be read`);
  }
  if (observed !== MONAD_TESTNET_CHAIN_ID) {
    throw new Error(`${code}: RPC reports chain ID ${observed}, expected ${MONAD_TESTNET_CHAIN_ID}`);
  }
}

/** Read the current finalized block snapshot (number, hash, timestamp). */
export async function finalizedBlock(reader: CanonicalChainReader): Promise<CanonicalFinalizedBlock> {
  const block = await reader.getBlock({ blockTag: 'finalized' });
  if (block.number === null || block.hash === null) throw new Error('FINALIZED_SNAPSHOT_UNAVAILABLE');
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_WORD_RE = /^0x[0-9a-fA-F]{64}$/;

/** Validate the canonical `Job` struct returned by `getJob`. */
export function validateJobData(value: unknown): JobData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MALFORMED_READCONTRACT_RESULT: getJob did not return a job struct');
  }
  const job = value as Record<string, unknown>;
  const address = (field: string): Address => {
    const raw = job[field];
    if (typeof raw !== 'string' || !ADDRESS_RE.test(raw)) {
      throw new Error(`MALFORMED_READCONTRACT_RESULT: job.${field} is not an address`);
    }
    return raw as Address;
  };
  const word = (field: string): Hex => {
    const raw = job[field];
    if (typeof raw !== 'string' || !HEX_WORD_RE.test(raw)) {
      throw new Error(`MALFORMED_READCONTRACT_RESULT: job.${field} is not a 32-byte commitment`);
    }
    return raw as Hex;
  };
  const amount = (field: string): bigint => {
    const raw = job[field];
    if (typeof raw !== 'bigint' || raw < 0n) {
      throw new Error(`MALFORMED_READCONTRACT_RESULT: job.${field} is not a non-negative integer`);
    }
    return raw;
  };
  const status = job.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 7) {
    throw new Error('MALFORMED_READCONTRACT_RESULT: job.status is not a canonical JobStatus');
  }

  return {
    buyer: address('buyer'),
    provider: address('provider'),
    attestor: address('attestor'),
    termsCommitment: word('termsCommitment'),
    deliveryCommitment: word('deliveryCommitment'),
    budget: amount('budget'),
    expiresAt: amount('expiresAt'),
    status: status as JobStatus,
  };
}

/**
 * Read the canonical job at a block (finalized tag by default) and validate its
 * shape. The caller must already have proven the chain ID.
 */
export async function readCanonicalJob(
  reader: CanonicalChainReader,
  protocol: Address,
  jobId: bigint,
  blockNumber?: bigint
): Promise<JobData> {
  if (typeof jobId !== 'bigint' || jobId <= 0n) throw new Error('INVALID_JOB_ID: jobId must be positive');
  const result = await reader.readContract({
    address: protocol,
    abi: deliveryProtocolAbi as Abi,
    functionName: 'getJob',
    args: [jobId],
    blockNumber,
  });
  return validateJobData(result);
}

/** Compare the immutable fields of two canonical job snapshots. */
export function sameCanonicalJob(a: JobData, b: JobData): boolean {
  return (
    sameAddress(a.buyer, b.buyer) &&
    sameAddress(a.provider, b.provider) &&
    sameAddress(a.attestor, b.attestor) &&
    a.termsCommitment.toLowerCase() === b.termsCommitment.toLowerCase() &&
    a.deliveryCommitment.toLowerCase() === b.deliveryCommitment.toLowerCase() &&
    a.budget === b.budget &&
    a.expiresAt === b.expiresAt &&
    a.status === b.status
  );
}

/**
 * Cross-RPC observation of one canonical job.
 *
 * Both RPCs must be Monad Testnet, must agree on the same finalized block hash
 * and timestamp, and must return the same canonical job state. Any disagreement
 * is conflicting finalized evidence and throws RPC_STATE_MISMATCH.
 */
export async function matchedCanonicalJob(
  primary: CanonicalChainReader,
  secondary: CanonicalChainReader,
  protocol: Address,
  jobId: bigint
): Promise<{ job: JobData; observation: CanonicalFinalizedBlock }> {
  await assertMonadTestnet(primary, 'PRIMARY_WRONG_CHAIN');
  await assertMonadTestnet(secondary, 'SECONDARY_WRONG_CHAIN');

  const [primaryHead, secondaryHead] = await Promise.all([finalizedBlock(primary), finalizedBlock(secondary)]);
  const blockNumber = primaryHead.number < secondaryHead.number ? primaryHead.number : secondaryHead.number;
  const [primaryBlock, secondaryBlock] = await Promise.all([
    primary.getBlock({ blockNumber }),
    secondary.getBlock({ blockNumber }),
  ]);
  if (
    primaryBlock.hash === null ||
    secondaryBlock.hash === null ||
    primaryBlock.hash !== secondaryBlock.hash ||
    primaryBlock.timestamp !== secondaryBlock.timestamp
  ) {
    throw new Error('RPC_FINALITY_MISMATCH');
  }
  const observation: CanonicalFinalizedBlock = {
    number: blockNumber,
    hash: primaryBlock.hash,
    timestamp: primaryBlock.timestamp,
  };

  const [first, second] = await Promise.all([
    readCanonicalJob(primary, protocol, jobId, blockNumber),
    readCanonicalJob(secondary, protocol, jobId, blockNumber),
  ]);
  if (!sameCanonicalJob(first, second)) throw new Error('RPC_STATE_MISMATCH');
  return { job: first, observation };
}

/**
 * Require two RPCs to return identical finalized receipt bytes for one
 * transaction. Uses the single shared finalization implementation.
 */
export async function matchedFinalizedReceipt(
  primary: CanonicalChainReader,
  secondary: CanonicalChainReader,
  hash: Hex
): Promise<{ receipt: Receipt; block: { number: bigint | null; hash: Hex | null; timestamp: bigint } }> {
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
  if (describe(first) !== describe(second)) throw new Error('RPC_RECEIPT_MISMATCH');
  return first;
}

/**
 * Adapt a viem PublicClient into a CanonicalChainReader.
 *
 * The PublicClient is assumed to already target Monad Testnet. The adapter
 * simply forwards every method call with structural typing — no runtime chain
 * guard is added here because `assertMonadTestnet` in settlement.ts checks the
 * chain before reading.
 */
export function viemPublicClientToCanonicalChainReader(publicClient: PublicClient): CanonicalChainReader {
  return {
    getChainId: () => publicClient.getChainId(),
    getBlock: (args) => publicClient.getBlock(args) as Promise<{
      number: bigint | null;
      hash: Hex | null;
      timestamp: bigint;
    }>,
    getTransaction: (args) => publicClient.getTransaction(args) as Promise<Transaction>,
    getTransactionReceipt: (args) => publicClient.getTransactionReceipt(args) as Promise<Receipt>,
    readContract: (args) => publicClient.readContract(args) as Promise<unknown>,
  };
}
