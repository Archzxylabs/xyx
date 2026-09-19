import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { payoutDescription, verifyPayout, type PayoutSpec, type ReceiptReader, type JobSnapshot, type PayoutBinding } from '../src/payout.js';

const buyer = '0x0000000000000000000000000000000000000001' as Address;
const provider = '0x0000000000000000000000000000000000000002' as Address;
const recipient = '0x0000000000000000000000000000000000000003' as Address;
const token = '0x0000000000000000000000000000000000000004' as Address;
const commerce = '0x0000000000000000000000000000000000000005' as Address;
const evaluator = '0x0000000000000000000000000000000000000006' as Address;
const transferHash = `0x${'a'.repeat(64)}` as Hex;
const blockHash = `0x${'b'.repeat(64)}` as Hex;
const otherHash = `0x${'c'.repeat(64)}` as Hex;
const spec: PayoutSpec = {kind:'xyx.payout.v1',chainId:10143,commerce,buyer,provider,recipient,token,amountAtomic:'10000',rewardAtomic:'20000',expiresAt:2_000_000_000};
const job: JobSnapshot = {client:buyer,provider,evaluator,description:payoutDescription(spec,`ipfs://b${'a'.repeat(40)}`),budget:20000n,expiredAt:BigInt(spec.expiresAt),status:2};
const binding: PayoutBinding = {jobId:1n,commerce,evaluator,fundedBlock:10n,submittedBlock:30n,deliverable:transferHash,claimedJobId:1n,
  observedAtBlock:30n,observedAtBlockHash:blockHash,observedAtTimestamp:BigInt(spec.expiresAt)-100n};

function reader(options: {
  to?: Address; value?: bigint; sender?: Address; target?: Address; logToken?: Address;
  transferBlock?: bigint; timestamp?: bigint; finalizedBlock?: bigint; duplicateLog?: boolean;
  receiptStatus?: 'success' | 'reverted'; overrides?: Partial<ReceiptReader>;
} = {}): ReceiptReader {
  const to = options.to ?? recipient;
  const value = options.value ?? 10000n;
  const transferBlock = options.transferBlock ?? 20n;
  const topics = encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:provider,to}}) as [Hex, ...Hex[]];
  const data = encodeAbiParameters([{type:'uint256'}],[value]);
  const log = {address: options.logToken ?? token, topics, data};
  return {
    getChainId: async () => 10143,
    getTransaction: async () => ({hash:transferHash,from:options.sender ?? provider,to:options.target ?? token,
      input:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[to,value]}),blockNumber:transferBlock,blockHash}),
    getTransactionReceipt: async () => ({transactionHash:transferHash,blockNumber:transferBlock,blockHash,
      status:options.receiptStatus ?? 'success',to:options.target ?? token,
      logs:options.receiptStatus === 'reverted' ? [] : options.duplicateLog ? [log,log] : [log]}),
    getBlock: async args => ({number:'blockTag' in args ? options.finalizedBlock ?? 30n : args.blockNumber,
      hash:blockHash,timestamp:options.timestamp ?? BigInt(spec.expiresAt)-300n}),
    ...options.overrides,
  };
}

test('matching finalized transfer releases COMPLETE with its job and block binding',async()=>{
  const evidence=await verifyPayout(reader(),spec,job,transferHash,binding);
  assert.equal(evidence.decision,'COMPLETE');
  assert.equal(evidence.kind,'xyx.payout.evidence.v2');
  assert.deepEqual(evidence.failures,[]);
  assert.equal(evidence.binding.jobId,'1');
  assert.equal(evidence.observed.blockHash,blockHash);
});

test('settled jobs retain an independently verifiable transfer',async()=>{
  for (const status of [3, 4, 5]) {
    const evidence=await verifyPayout(reader(),spec,{...job,status},transferHash,binding);
    assert.equal(evidence.decision,'COMPLETE');
  }
});

test('wrong recipient or amount produces an observed REJECT',async()=>{
  for (const options of [{to:buyer},{value:9999n}]) {
    const evidence=await verifyPayout(reader(options),spec,job,transferHash,binding);
    assert.equal(evidence.decision,'REJECT');
    assert.deepEqual(evidence.failures,['TRANSFER_CALL_MISMATCH','TRANSFER_MISMATCH']);
  }
});

test('job specification cannot be replaced after creation',async()=>{
  await assert.rejects(verifyPayout(reader(),{...spec,recipient:buyer},job,transferHash,binding),/SPEC_COMMITMENT_MISMATCH/);
});

test('wrong transaction sender or token target cannot earn a reward',async()=>{
  const sender=await verifyPayout(reader({sender:buyer}),spec,job,transferHash,binding);
  assert.equal(sender.decision,'REJECT');
  assert.deepEqual(sender.failures,['WRONG_SENDER']);
  const target=await verifyPayout(reader({target:buyer,logToken:buyer}),spec,job,transferHash,binding);
  assert.equal(target.decision,'REJECT');
  assert.deepEqual(target.failures,['WRONG_TOKEN_TARGET','TRANSFER_MISMATCH']);
});

test('a forged Transfer log emitted by another contract does not count',async()=>{
  const evidence=await verifyPayout(reader({logToken:buyer}),spec,job,transferHash,binding);
  assert.equal(evidence.decision,'REJECT');
  assert.deepEqual(evidence.failures,['TRANSFER_MISMATCH']);
});

test('multiple token transfers are rejected under the single payout policy',async()=>{
  const evidence=await verifyPayout(reader({duplicateLog:true}),spec,job,transferHash,binding);
  assert.equal(evidence.decision,'REJECT');
  assert.deepEqual(evidence.failures,['TRANSFER_MISMATCH']);
});

test('reverted transfer is rejected when its finalized receipt is available',async()=>{
  const evidence=await verifyPayout(reader({receiptStatus:'reverted'}),spec,job,transferHash,binding);
  assert.equal(evidence.decision,'REJECT');
  assert.ok(evidence.failures.includes('TRANSACTION_REVERTED'));
});

test('transfer before or in the funding block is rejected',async()=>{
  for (const transferBlock of [9n,10n]) {
    const evidence=await verifyPayout(reader({transferBlock}),spec,job,transferHash,binding);
    assert.equal(evidence.decision,'REJECT');
    assert.deepEqual(evidence.failures,['TRANSFER_NOT_AFTER_FUNDING']);
  }
});

test('transfer in or after the submission block is rejected',async()=>{
  for (const transferBlock of [30n,31n]) {
    const evidence=await verifyPayout(reader({transferBlock,finalizedBlock:40n}),spec,job,transferHash,{...binding,observedAtBlock:40n});
    assert.equal(evidence.decision,'REJECT');
    assert.deepEqual(evidence.failures,['TRANSFER_NOT_BEFORE_SUBMISSION']);
  }
});

test('a receipt outside the finalized observation snapshot remains unverified',async()=>{
  await assert.rejects(verifyPayout(reader({transferBlock:31n,finalizedBlock:40n}),spec,job,transferHash,binding),/TRANSFER_AFTER_OBSERVATION_SNAPSHOT/);
});

test('transfer at or after expiry is rejected using chain time',async()=>{
  for (const timestamp of [BigInt(spec.expiresAt),BigInt(spec.expiresAt)+1n]) {
    const evidence=await verifyPayout(reader({timestamp}),spec,job,transferHash,binding);
    assert.equal(evidence.decision,'REJECT');
    assert.deepEqual(evidence.failures,['TRANSFER_AFTER_EXPIRY']);
  }
});

test('a transfer already claimed by another job cannot be verified',async()=>{
  await assert.rejects(verifyPayout(reader(),spec,job,transferHash,{...binding,claimedJobId:2n}),/DELIVERABLE_BINDING_MISMATCH/);
  await assert.rejects(verifyPayout(reader(),spec,job,transferHash,{...binding,deliverable:otherHash}),/DELIVERABLE_BINDING_MISMATCH/);
});

test('unfinalized transfer and submission remain unverified instead of rejected',async()=>{
  await assert.rejects(verifyPayout(reader({finalizedBlock:19n}),spec,job,transferHash,binding),/RECEIPT_NOT_FINALIZED/);
  await assert.rejects(verifyPayout(reader({finalizedBlock:25n}),spec,job,transferHash,binding),/SUBMISSION_NOT_FINALIZED/);
});

test('inconsistent receipt, transaction or block stops verification',async()=>{
  const base=reader();
  const wrongReceipt=reader({overrides:{getTransactionReceipt:async args=>({...await base.getTransactionReceipt(args),transactionHash:otherHash})}});
  await assert.rejects(verifyPayout(wrongReceipt,spec,job,transferHash,binding),/RECEIPT_BLOCK_MISMATCH/);
  const wrongBlock=reader({overrides:{getBlock:async args=>({...await base.getBlock(args),hash:otherHash})}});
  await assert.rejects(verifyPayout(wrongBlock,spec,job,transferHash,binding),/RECEIPT_BLOCK_MISMATCH/);
  const wrongTransaction=reader({overrides:{getTransaction:async args=>({...await base.getTransaction(args),blockHash:otherHash})}});
  await assert.rejects(verifyPayout(wrongTransaction,spec,job,transferHash,binding),/TRANSACTION_RECEIPT_MISMATCH/);
});

test('missing receipt and failed RPC calls never become a REJECT verdict',async()=>{
  for (const method of ['getTransaction','getTransactionReceipt','getBlock'] as const) {
    const unavailable=reader({overrides:{[method]:async()=>{throw new Error('RPC_UNAVAILABLE');}}});
    await assert.rejects(verifyPayout(unavailable,spec,job,transferHash,binding),/RPC_UNAVAILABLE/);
  }
});

test('wrong network, terms, deployment or job lifecycle stops verification',async()=>{
  await assert.rejects(verifyPayout(reader({overrides:{getChainId:async()=>1}}),spec,job,transferHash,binding),/WRONG_CHAIN/);
  await assert.rejects(verifyPayout(reader(),spec,{...job,budget:1n},transferHash,binding),/JOB_TERMS_MISMATCH/);
  await assert.rejects(verifyPayout(reader(),spec,{...job,provider:buyer},transferHash,binding),/JOB_PARTICIPANT_MISMATCH/);
  await assert.rejects(verifyPayout(reader(),spec,job,transferHash,{...binding,commerce:buyer}),/DEPLOYMENT_BINDING_MISMATCH/);
  await assert.rejects(verifyPayout(reader(),spec,{...job,status:1},transferHash,binding),/JOB_NOT_SUBMITTED/);
  await assert.rejects(verifyPayout(reader(),spec,job,transferHash,{...binding,submittedBlock:10n}),/INVALID_JOB_BLOCKS/);
});
