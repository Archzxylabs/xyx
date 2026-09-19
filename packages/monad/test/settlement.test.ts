import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from 'viem';
import { commerceAbi, evaluatorAbi } from '../src/chain.js';
import { verifySettlement } from '../src/settlement.js';
import type { JobSnapshot, ReceiptReader, TransferLog } from '../src/payout.js';

const buyer='0x0000000000000000000000000000000000000001' as Address;
const provider='0x0000000000000000000000000000000000000002' as Address;
const commerce='0x0000000000000000000000000000000000000003' as Address;
const evaluator='0x0000000000000000000000000000000000000004' as Address;
const token='0x0000000000000000000000000000000000000005' as Address;
const attestor='0x0000000000000000000000000000000000000006' as Address;
const verdictHash=`0x${'a'.repeat(64)}` as Hex;
const refundHash=`0x${'b'.repeat(64)}` as Hex;
const evidenceHash=`0x${'c'.repeat(64)}` as Hex;
const reasonHash=`0x${'d'.repeat(64)}` as Hex;
const blockHash=`0x${'e'.repeat(64)}` as Hex;
const jobBase:JobSnapshot={client:buyer,provider,evaluator,description:'{}',budget:20_000n,expiredAt:2_000_000_000n,status:3};

function event(address:Address,abi:unknown,eventName:string,args:Record<string,unknown>,data:Hex):TransferLog {
  return {address,data,topics:encodeEventTopics({abi,eventName,args} as never) as [Hex,...Hex[]]};
}
function transfer(from:Address,to:Address,value:bigint):TransferLog {
  return event(token,erc20Abi,'Transfer',{from,to},encodeAbiParameters([{type:'uint256'}],[value]));
}
function reader(receipts:Record<Hex,{to:Address;logs:TransferLog[];timestamp?:bigint}>):ReceiptReader {
  return {
    getChainId:async()=>10143,
    getTransaction:async({hash})=>({hash,from:buyer,to:receipts[hash].to,input:'0x',blockNumber:100n,blockHash}),
    getTransactionReceipt:async({hash})=>({transactionHash:hash,blockNumber:100n,blockHash,status:'success',to:receipts[hash].to,logs:receipts[hash].logs}),
    getBlock:async args=>({number:'blockTag' in args?100n:args.blockNumber,hash:blockHash,timestamp:'blockTag' in args?2_000_000_100n:receipts[verdictHash]?.timestamp??2_000_000_100n}),
  };
}
function verdictLogs(decision:1|2) {
  return [
    event(evaluator,evaluatorAbi,'JobVerdictExecuted',{verdictHash,jobId:1n,attestor},encodeAbiParameters([{type:'uint8'},{type:'bytes32'},{type:'bytes32'}],[decision,evidenceHash,reasonHash])),
    event(commerce,commerceAbi,decision===1?'JobCompleted':'JobRejected',decision===1?{jobId:1n,evaluator}:{jobId:1n,rejector:evaluator},encodeAbiParameters([{type:'bytes32'}],[reasonHash])),
    transfer(commerce,decision===1?provider:buyer,20_000n),
  ];
}

test('complete is live verified only with evaluator, escrow, and token receipts',async()=>{
  const result=await verifySettlement(reader({[verdictHash]:{to:evaluator,logs:verdictLogs(1)}}),{commerce,evaluator,token,jobId:1n,job:jobBase,
    verdictTx:verdictHash,evidenceHash,reasonHash,decision:'COMPLETE'});
  assert.equal(result.state,'LIVE VERIFIED');
  assert.equal(result.recipient,provider);
  assert.equal(result.amount,20_000n);
});

test('reject is live verified only when escrow refunds the buyer',async()=>{
  const result=await verifySettlement(reader({[verdictHash]:{to:evaluator,logs:verdictLogs(2)}}),{commerce,evaluator,token,jobId:1n,job:{...jobBase,status:4},
    verdictTx:verdictHash,evidenceHash,reasonHash,decision:'REJECT'});
  assert.equal(result.state,'LIVE VERIFIED');
  assert.equal(result.recipient,buyer);
});

test('a verdict event from a different contract or a bad reward transfer is rejected',async()=>{
  const badEmitter=verdictLogs(1);badEmitter[0]={...badEmitter[0],address:buyer};
  await assert.rejects(verifySettlement(reader({[verdictHash]:{to:evaluator,logs:badEmitter}}),{commerce,evaluator,token,jobId:1n,job:jobBase,
    verdictTx:verdictHash,evidenceHash,reasonHash,decision:'COMPLETE'}),/SETTLEMENT_JobVerdictExecuted_MISMATCH/);
  const badTransfer=verdictLogs(1);badTransfer[2]=transfer(commerce,buyer,20_000n);
  await assert.rejects(verifySettlement(reader({[verdictHash]:{to:evaluator,logs:badTransfer}}),{commerce,evaluator,token,jobId:1n,job:jobBase,
    verdictTx:verdictHash,evidenceHash,reasonHash,decision:'COMPLETE'}),/SETTLEMENT_TOKEN_TRANSFER_MISMATCH/);
});

test('expiry is live verified without an evaluator verdict',async()=>{
  const expiryLogs=[event(commerce,commerceAbi,'JobExpired',{jobId:1n},'0x'),transfer(commerce,buyer,20_000n)];
  const result=await verifySettlement(reader({[refundHash]:{to:commerce,logs:expiryLogs,timestamp:2_000_000_000n}}),{commerce,evaluator,token,jobId:1n,job:{...jobBase,status:5},refundTx:refundHash});
  assert.equal(result.state,'LIVE VERIFIED');
  assert.equal(result.recipient,buyer);
});

test('unsettled jobs remain pending',async()=>{
  const result=await verifySettlement(reader({}),{commerce,evaluator,token,jobId:1n,job:{...jobBase,status:2}});
  assert.equal(result.state,'PENDING');
});
