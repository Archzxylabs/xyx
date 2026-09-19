import type { Abi, Address, Hex } from 'viem';
import commerceArtifact from '../../contracts/out/AgenticCommerce.sol/AgenticCommerce.json' with {type: 'json'};
import evaluatorArtifact from '../../contracts/out/XYXEvaluator.sol/XYXEvaluator.json' with {type: 'json'};
import type { PayoutBinding, ReceiptReader } from './payout';
import { finalizedReceipt } from './payout';
import type { JobSnapshot } from './payout';

export const commerceAbi = commerceArtifact.abi as Abi;
export const evaluatorAbi = evaluatorArtifact.abi as Abi;
export type ChainReader = ReceiptReader & {
  readContract(args: {address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; blockNumber?: bigint}): Promise<unknown>;
};

export type PayoutSnapshot = {
  blockNumber: bigint; blockHash: Hex; timestamp: bigint; job: JobSnapshot; binding: PayoutBinding;
};

export type FinalizedBlock={number:bigint;hash:Hex;timestamp:bigint};
export async function finalizedBlock(reader:ReceiptReader):Promise<FinalizedBlock>{
  const block=await reader.getBlock({blockTag:'finalized'});
  if(block.number===null || block.hash===null)throw new Error('FINALIZED_SNAPSHOT_UNAVAILABLE');
  return {number:block.number,hash:block.hash,timestamp:block.timestamp};
}

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

export async function matchedFinalizedReceipt(primary:ReceiptReader,secondary:ReceiptReader,hash:Hex){
  const [first,second]=await Promise.all([finalizedReceipt(primary,hash),finalizedReceipt(secondary,hash)]);
  const one=JSON.stringify({status:first.receipt.status,to:first.receipt.to,block:first.receipt.blockNumber.toString(),blockHash:first.receipt.blockHash,
    logs:first.receipt.logs.map(log=>({address:log.address,data:log.data,topics:log.topics}))});
  const two=JSON.stringify({status:second.receipt.status,to:second.receipt.to,block:second.receipt.blockNumber.toString(),blockHash:second.receipt.blockHash,
    logs:second.receipt.logs.map(log=>({address:log.address,data:log.data,topics:log.topics}))});
  if(one!==two)throw new Error('RPC_RECEIPT_MISMATCH');
  return first;
}
