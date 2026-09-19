import { decodeEventLog, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { canonicalJSON, hashJSON } from './canonical';

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const payoutSpecSchema = z.object({
  kind: z.literal('xyx.payout.v1'),
  chainId: z.literal(MONAD_TESTNET_CHAIN_ID),
  commerce: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  buyer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  provider: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amountAtomic: z.string().regex(/^[1-9][0-9]*$/),
  rewardAtomic: z.string().regex(/^[1-9][0-9]*$/),
  expiresAt: z.number().int().positive(),
}).strict();
export type PayoutSpec = z.infer<typeof payoutSpecSchema>;

export const payoutDescriptionSchema = z.object({
  kind: z.literal('xyx.payout.v1'),
  specHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  specURI: z.string().regex(/^ipfs:\/\/b[a-z2-7]{20,}$/),
}).strict();

export function payoutDescription(spec: PayoutSpec, specURI: string): string {
  payoutSpecSchema.parse(spec);
  return canonicalJSON(payoutDescriptionSchema.parse({kind: spec.kind, specHash: hashJSON(spec), specURI}));
}

export function parsePayoutDescription(description: string) {
  const value = payoutDescriptionSchema.parse(JSON.parse(description));
  if (canonicalJSON(value) !== description) throw new Error('NON_CANONICAL_DESCRIPTION');
  return value;
}

type Transaction = { hash: Hex; from: Address; to: Address | null; input: Hex; blockNumber: bigint | null; blockHash: Hex | null };
export type TransferLog = { address: Address; data: Hex; topics: readonly Hex[] };
export type Receipt = { transactionHash: Hex; blockNumber: bigint; blockHash: Hex; status: 'success' | 'reverted'; to: Address | null; logs: readonly TransferLog[] };
type Block = { number: bigint | null; hash: Hex | null; timestamp: bigint };
export type ReceiptReader = {
  getChainId(): Promise<number>;
  getTransaction(args: {hash: Hex}): Promise<Transaction>;
  getTransactionReceipt(args: {hash: Hex}): Promise<Receipt>;
  getBlock(args: {blockNumber: bigint} | {blockTag: 'finalized'}): Promise<Block>;
};

export type PayoutBinding = {
  jobId: bigint; commerce: Address; evaluator: Address; fundedBlock: bigint;
  submittedBlock: bigint; deliverable: Hex; claimedJobId: bigint;
  observedAtBlock: bigint; observedAtBlockHash: Hex; observedAtTimestamp: bigint;
};

export const sameAddress = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();

export function tokenTransfers(logs: readonly TransferLog[], token: string) {
  return logs.flatMap(log => {
    if (!sameAddress(log.address, token)) return [];
    try {
      const decoded = decodeEventLog({abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true});
      return [{from: decoded.args.from, to: decoded.args.to, value: decoded.args.value.toString()}];
    } catch { return []; }
  });
}

export async function finalizedReceipt(reader: ReceiptReader, hash: Hex) {
  const receipt = await reader.getTransactionReceipt({hash});
  const [block, finalized] = await Promise.all([
    reader.getBlock({blockNumber: receipt.blockNumber}), reader.getBlock({blockTag: 'finalized'}),
  ]);
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || block.number !== receipt.blockNumber
    || block.hash !== receipt.blockHash) throw new Error('RECEIPT_BLOCK_MISMATCH');
  if (finalized.number === null || finalized.number < receipt.blockNumber) throw new Error('RECEIPT_NOT_FINALIZED');
  return {receipt, block};
}

export type JobSnapshot = {
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
};

export async function verifyPayout(reader: ReceiptReader, spec: PayoutSpec, job: JobSnapshot, transferHash: Hex, binding: PayoutBinding) {
  payoutSpecSchema.parse(spec);
  const failures: string[] = [];
  const same = sameAddress;
  if (await reader.getChainId() !== MONAD_TESTNET_CHAIN_ID) throw new Error('WRONG_CHAIN');
  const description = parsePayoutDescription(job.description);
  if (description.specHash.toLowerCase() !== hashJSON(spec).toLowerCase()) throw new Error('SPEC_COMMITMENT_MISMATCH');
  if (!same(job.client, spec.buyer) || !same(job.provider, spec.provider)) throw new Error('JOB_PARTICIPANT_MISMATCH');
  if (job.budget !== BigInt(spec.rewardAtomic) || job.expiredAt !== BigInt(spec.expiresAt)) throw new Error('JOB_TERMS_MISMATCH');
  // A settled job still needs to be independently verifiable by the demo UI.
  if (![2, 3, 4, 5].includes(job.status)) throw new Error('JOB_NOT_SUBMITTED');
  if (!same(binding.commerce, spec.commerce) || !same(binding.evaluator, job.evaluator)) throw new Error('DEPLOYMENT_BINDING_MISMATCH');
  if (binding.jobId <= 0n || binding.claimedJobId !== binding.jobId || !same(binding.deliverable, transferHash)) throw new Error('DELIVERABLE_BINDING_MISMATCH');
  if (binding.fundedBlock <= 0n || binding.submittedBlock <= binding.fundedBlock) throw new Error('INVALID_JOB_BLOCKS');
  if (binding.observedAtBlock < binding.submittedBlock || binding.observedAtBlockHash === '0x' || binding.observedAtTimestamp <= 0n) throw new Error('INVALID_OBSERVATION_SNAPSHOT');
  const [transaction, {receipt, block}, finalized] = await Promise.all([
    reader.getTransaction({hash: transferHash}), finalizedReceipt(reader, transferHash), reader.getBlock({blockTag: 'finalized'}),
  ]);
  if (finalized.number === null || finalized.number < binding.observedAtBlock) throw new Error('SUBMISSION_NOT_FINALIZED');
  if (!same(transaction.hash, transferHash) || transaction.blockNumber !== receipt.blockNumber
    || transaction.blockHash !== receipt.blockHash || !same(transaction.to, receipt.to ?? '')) throw new Error('TRANSACTION_RECEIPT_MISMATCH');
  // Conservative P0: each operation must be in a separate block, as in the CLI.
  if (receipt.blockNumber > binding.observedAtBlock) throw new Error('TRANSFER_AFTER_OBSERVATION_SNAPSHOT');
  if (receipt.blockNumber <= binding.fundedBlock) failures.push('TRANSFER_NOT_AFTER_FUNDING');
  if (receipt.blockNumber >= binding.submittedBlock) failures.push('TRANSFER_NOT_BEFORE_SUBMISSION');
  if (block.timestamp >= BigInt(spec.expiresAt)) failures.push('TRANSFER_AFTER_EXPIRY');
  if (receipt.status !== 'success') failures.push('TRANSACTION_REVERTED');
  if (!same(transaction.from, spec.provider)) failures.push('WRONG_SENDER');
  if (!same(transaction.to, spec.token) || !same(receipt.to, spec.token)) failures.push('WRONG_TOKEN_TARGET');
  const expectedInput = encodeFunctionData({abi: erc20Abi, functionName: 'transfer', args: [spec.recipient as Address, BigInt(spec.amountAtomic)]});
  if (transaction.input.toLowerCase() !== expectedInput.toLowerCase()) failures.push('TRANSFER_CALL_MISMATCH');
  const transfers = tokenTransfers(receipt.logs, spec.token);
  const matched = transfers.length === 1 && transfers.some(row => same(row.from, spec.provider) && same(row.to, spec.recipient)
    && row.value === spec.amountAtomic);
  if (!matched) failures.push('TRANSFER_MISMATCH');
  return {
    kind: 'xyx.payout.evidence.v2' as const,
    chainId: MONAD_TESTNET_CHAIN_ID,
    specHash: hashJSON(spec),
    transferHash,
    binding: {jobId: binding.jobId.toString(), commerce: binding.commerce, evaluator: binding.evaluator,
      fundedBlock: binding.fundedBlock.toString(), submittedBlock: binding.submittedBlock.toString(),
      observedAtBlock: binding.observedAtBlock.toString(), observedAtBlockHash: binding.observedAtBlockHash,
      observedAtTimestamp: binding.observedAtTimestamp.toString()},
    expected: {provider: spec.provider, recipient: spec.recipient, token: spec.token, amountAtomic: spec.amountAtomic},
    observed: {sender: transaction.from, target: transaction.to, status: receipt.status, transfers,
      blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, timestamp: block.timestamp.toString()},
    decision: failures.length ? 'REJECT' as const : 'COMPLETE' as const,
    failures,
  };
}
