import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import { matchedFinalizedReceipt, matchedPayoutSnapshot, type ChainReader } from '../src/chain.js';
import type { JobSnapshot } from '../src/payout.js';

const commerce='0x0000000000000000000000000000000000000001' as Address;
const evaluator='0x0000000000000000000000000000000000000002' as Address;
const provider='0x0000000000000000000000000000000000000003' as Address;
const buyer='0x0000000000000000000000000000000000000004' as Address;
const transfer=`0x${'a'.repeat(64)}` as Hex;
const blockHash=`0x${'b'.repeat(64)}` as Hex;
const otherHash=`0x${'c'.repeat(64)}` as Hex;
const job:JobSnapshot={client:buyer,provider,evaluator,description:'{}',budget:20_000n,expiredAt:2_000_000_000n,status:2};

function reader(head:bigint=30n,hash:Hex=blockHash,receiptHash:Hex=transfer):ChainReader{
  return {
    getChainId:async()=>10143,
    getTransaction:async({hash})=>({hash,from:provider,to:commerce,input:'0x',blockNumber:20n,blockHash}),
    getTransactionReceipt:async({hash})=>({transactionHash:hash,blockNumber:20n,blockHash,status:'success',to:commerce,logs:[]}),
    getBlock:async args=>({number:'blockTag' in args?head:args.blockNumber,hash:receiptHash===transfer?hash:otherHash,timestamp:1_999_999_900n}),
    readContract:async args=>{
      if(args.functionName==='getJob')return job;
      if(args.functionName==='fundedAtBlock')return 10n;
      if(args.functionName==='submittedAtBlock')return 30n;
      if(args.functionName==='deliverables')return transfer;
      if(args.functionName==='deliverableJob')return 1n;
      throw new Error('UNEXPECTED_READ');
    },
  };
}

test('two RPCs read job terms at the same finalized block',async()=>{
  const snapshot=await matchedPayoutSnapshot(reader(30n),reader(32n),commerce,evaluator,1n,provider,transfer);
  assert.equal(snapshot.blockNumber,30n);
  assert.equal(snapshot.binding.observedAtBlock,30n);
});

test('RPC block/state disagreement blocks payout verification',async()=>{
  await assert.rejects(matchedPayoutSnapshot(reader(),reader(30n,otherHash),commerce,evaluator,1n,provider,transfer),/RPC_FINALITY_MISMATCH/);
  const altered=reader();altered.readContract=async args=>args.functionName==='getJob'?{...job,budget:1n}:args.functionName==='fundedAtBlock'?10n:args.functionName==='submittedAtBlock'?30n:args.functionName==='deliverables'?transfer:1n;
  await assert.rejects(matchedPayoutSnapshot(reader(),altered,commerce,evaluator,1n,provider,transfer),/RPC_STATE_MISMATCH/);
});

test('receipt bytes must match across both RPCs',async()=>{
  await matchedFinalizedReceipt(reader(),reader(),transfer);
  const altered=reader();altered.getTransactionReceipt=async({hash})=>({transactionHash:hash,blockNumber:20n,blockHash,status:'reverted',to:commerce,logs:[]});
  await assert.rejects(matchedFinalizedReceipt(reader(),altered,transfer),/RPC_RECEIPT_MISMATCH/);
});
