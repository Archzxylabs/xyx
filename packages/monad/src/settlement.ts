import { decodeEventLog, type Abi, type Address, type Hex } from 'viem';
import { commerceAbi, evaluatorAbi } from './chain';
import { finalizedReceipt, sameAddress, tokenTransfers, type JobSnapshot, type ReceiptReader, type TransferLog } from './payout';

export type SettlementInput={
  commerce:Address; evaluator:Address; token:Address; jobId:bigint; job:JobSnapshot;
  verdictTx?:Hex; refundTx?:Hex; evidenceHash?:Hex; reasonHash?:Hex; decision?:'COMPLETE'|'REJECT';
};
export type SettlementResult={
  state:'PENDING'|'LIVE VERIFIED'; transactionHash?:Hex; blockNumber?:bigint; recipient?:Address; amount?:bigint;
};

function events(logs:readonly TransferLog[],emitter:Address,abi:Abi,eventName:string) {
  return logs.flatMap(log=>{
    if(!sameAddress(log.address,emitter))return [];
    try{return [decodeEventLog({abi,eventName,data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true})];}
    catch{return [];}
  });
}
function singleEvent(logs:readonly TransferLog[],emitter:Address,abi:Abi,eventName:string) {
  const matched=events(logs,emitter,abi,eventName);
  if(matched.length!==1)throw new Error(`SETTLEMENT_${eventName}_MISMATCH`);
  return matched[0].args as unknown as Record<string,unknown>;
}
function matchesTransfer(logs:readonly TransferLog[],token:Address,from:Address,to:Address,amount:bigint) {
  const transfers=tokenTransfers(logs,token);
  return transfers.length===1 && sameAddress(transfers[0].from,from) && sameAddress(transfers[0].to,to)
    && transfers[0].value===amount.toString();
}
function sameHex(value:unknown,expected:Hex) {
  return typeof value==='string'&&value.toLowerCase()===expected.toLowerCase();
}

export async function verifySettlement(reader:ReceiptReader,input:SettlementInput):Promise<SettlementResult> {
  const {commerce,evaluator,token,jobId,job}=input;
  if(job.status===3||job.status===4){
    if(!input.verdictTx||!input.evidenceHash||!input.reasonHash||!input.decision)throw new Error('SETTLEMENT_VERDICT_DATA_MISSING');
    const {receipt}=await finalizedReceipt(reader,input.verdictTx);
    if(!sameAddress(receipt.to,evaluator))throw new Error('SETTLEMENT_WRONG_VERDICT_TARGET');
    const verdict=singleEvent(receipt.logs,evaluator,evaluatorAbi,'JobVerdictExecuted');
    const expectedDecision=job.status===3?1:2;
    if((verdict.jobId as bigint)!==jobId||Number(verdict.decision)!==expectedDecision||!sameHex(verdict.evidenceHash,input.evidenceHash)
      ||!sameHex(verdict.reasonHash,input.reasonHash)||input.decision!==(expectedDecision===1?'COMPLETE':'REJECT'))throw new Error('SETTLEMENT_VERDICT_MISMATCH');
    const event=singleEvent(receipt.logs,commerce,commerceAbi,job.status===3?'JobCompleted':'JobRejected');
    if((event.jobId as bigint)!==jobId||!sameHex(event.reason,input.reasonHash))throw new Error('SETTLEMENT_TERMINAL_EVENT_MISMATCH');
    const expectedRecipient=job.status===3?job.provider:job.client;
    if(!matchesTransfer(receipt.logs,token,commerce,expectedRecipient,job.budget))throw new Error('SETTLEMENT_TOKEN_TRANSFER_MISMATCH');
    return {state:'LIVE VERIFIED',transactionHash:input.verdictTx,blockNumber:receipt.blockNumber,recipient:expectedRecipient,amount:job.budget};
  }
  if(job.status===5){
    if(!input.refundTx)throw new Error('SETTLEMENT_REFUND_DATA_MISSING');
    const {receipt,block}=await finalizedReceipt(reader,input.refundTx);
    if(!sameAddress(receipt.to,commerce)||block.timestamp<job.expiredAt)throw new Error('SETTLEMENT_INVALID_EXPIRY_REFUND');
    const event=singleEvent(receipt.logs,commerce,commerceAbi,'JobExpired');
    if((event.jobId as bigint)!==jobId)throw new Error('SETTLEMENT_TERMINAL_EVENT_MISMATCH');
    if(!matchesTransfer(receipt.logs,token,commerce,job.client,job.budget))throw new Error('SETTLEMENT_TOKEN_TRANSFER_MISMATCH');
    return {state:'LIVE VERIFIED',transactionHash:input.refundTx,blockNumber:receipt.blockNumber,recipient:job.client,amount:job.budget};
  }
  return {state:'PENDING'};
}
