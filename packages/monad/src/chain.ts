/**
 * LEGACY MODULE — retired AgenticCommerce / XYXEvaluator payout reads.
 *
 * This module is not canonical. It reads the retired `AgenticCommerce` and
 * `XYXEvaluator` contracts and the `xyx.payout.v1` spec format. It is reachable
 * only through the legacy namespace:
 *
 *   import { legacy } from '@xyx/monad';        // or '@xyx/monad/legacy'
 *
 * Canonical modules and new code must not import this file directly. The
 * canonical delivery-protocol read path lives in `delivery-chain.ts` and
 * `protocol.ts`.
 */

import type { Abi, Address, Hex } from 'viem';
import commerceArtifact from '../../contracts/out/AgenticCommerce.sol/AgenticCommerce.json' with {type: 'json'};
import evaluatorArtifact from '../../contracts/out/XYXEvaluator.sol/XYXEvaluator.json' with {type: 'json'};
import type { PayoutBinding } from './payout';
import type { JobSnapshot } from './payout';
import {
  finalizedBlock,
  matchedFinalizedReceipt,
  type CanonicalChainReader,
  type CanonicalFinalizedBlock,
} from './canonical-chain';

export const commerceAbi = commerceArtifact.abi as Abi;
export const evaluatorAbi = evaluatorArtifact.abi as Abi;

// Retro-compatible aliases: finalizedBlock/matchedFinalizedReceipt are owned by
// the canonical chain module; this legacy module only re-exports them.
export { finalizedBlock, matchedFinalizedReceipt };
export type FinalizedBlock = CanonicalFinalizedBlock;
export type ChainReader = CanonicalChainReader & {
  getTransaction(args: {hash: Hex}): Promise<{hash: Hex; from: Address; to: Address | null; input: Hex; blockNumber: bigint | null; blockHash: Hex | null}>;
};

export type PayoutSnapshot = {
  blockNumber: bigint; blockHash: Hex; timestamp: bigint; job: JobSnapshot; binding: PayoutBinding;
};


export async function readPayoutSnapshotAt(reader: ChainReader, commerce: Address, evaluator: Address, jobId: bigint, provider: Address, transfer: Hex, target:FinalizedBlock): Promise<PayoutSnapshot> {
  const block=await reader.getBlock({blockNumber:target.number});
  if(block.number!==target.number||block.hash!==target.hash||block.timestamp!==target.timestamp)throw new Error('OBSERVATION_BLOCK_MISMATCH');
  const blockNumber=target.number;
  const blockHash=target.hash;
  const read = (functionName: string, args: readonly unknown[]) => reader.readContract({address: commerce, abi: commerceAbi, functionName, args, blockNumber});
  const [fundedBlock, submittedBlock, deliverable, claimedJobId, job] = await Promise.all([
    read('fundedAtBlock', [jobId]), read('submittedAtBlock', [jobId]), read('deliverables', [jobId]), read('deliverableJob', [provider, transfer]), read('getJob',[jobId]),
  ]);
  return {blockNumber,blockHash,timestamp:target.timestamp,job:job as JobSnapshot,binding:{commerce, evaluator, jobId,
    fundedBlock: fundedBlock as bigint, submittedBlock: submittedBlock as bigint, deliverable: deliverable as Hex, claimedJobId: claimedJobId as bigint,
    observedAtBlock:blockNumber,observedAtBlockHash:blockHash,observedAtTimestamp:block.timestamp}};
}

export async function readPayoutSnapshot(reader: ChainReader, commerce: Address, evaluator: Address, jobId: bigint, provider: Address, transfer: Hex): Promise<PayoutSnapshot> {
  return readPayoutSnapshotAt(reader,commerce,evaluator,jobId,provider,transfer,await finalizedBlock(reader));
}

function sameSnapshot(a:PayoutSnapshot,b:PayoutSnapshot){
  return a.blockNumber===b.blockNumber&&a.blockHash===b.blockHash&&a.timestamp===b.timestamp
    && a.job.client.toLowerCase()===b.job.client.toLowerCase()&&a.job.provider.toLowerCase()===b.job.provider.toLowerCase()
    &&a.job.evaluator.toLowerCase()===b.job.evaluator.toLowerCase()&&a.job.description===b.job.description&&a.job.budget===b.job.budget
    &&a.job.expiredAt===b.job.expiredAt&&a.job.status===b.job.status&&a.binding.fundedBlock===b.binding.fundedBlock
    &&a.binding.submittedBlock===b.binding.submittedBlock&&a.binding.deliverable.toLowerCase()===b.binding.deliverable.toLowerCase()
    &&a.binding.claimedJobId===b.binding.claimedJobId;
}

export async function matchedPayoutSnapshot(primary:ChainReader,secondary:ChainReader,commerce:Address,evaluator:Address,jobId:bigint,provider:Address,transfer:Hex){
  const [primaryHead,secondaryHead]=await Promise.all([finalizedBlock(primary),finalizedBlock(secondary)]);
  const targetNumber=primaryHead.number<secondaryHead.number?primaryHead.number:secondaryHead.number;
  const [primaryBlock,secondaryBlock]=await Promise.all([primary.getBlock({blockNumber:targetNumber}),secondary.getBlock({blockNumber:targetNumber})]);
  if(primaryBlock.hash===null||secondaryBlock.hash===null||primaryBlock.hash!==secondaryBlock.hash||primaryBlock.timestamp!==secondaryBlock.timestamp)throw new Error('RPC_FINALITY_MISMATCH');
  const target:FinalizedBlock={number:targetNumber,hash:primaryBlock.hash,timestamp:primaryBlock.timestamp};
  const [first,second]=await Promise.all([
    readPayoutSnapshotAt(primary,commerce,evaluator,jobId,provider,transfer,target),readPayoutSnapshotAt(secondary,commerce,evaluator,jobId,provider,transfer,target),
  ]);
  if(!sameSnapshot(first,second))throw new Error('RPC_STATE_MISMATCH');
  return first;
}
