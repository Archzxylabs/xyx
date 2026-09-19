import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import commerceArtifact from '../packages/contracts/out/AgenticCommerce.sol/AgenticCommerce.json' with {type:'json'};

const rpc=process.env.MONAD_RPC_URL??'https://testnet-rpc.monad.xyz';
const commerceAbi=commerceArtifact.abi as Abi;
const address=(key:string)=>{
  const value=process.env[key];
  if(!value||!/^0x[0-9a-fA-F]{40}$/.test(value))throw new Error(`MISSING_${key}`);
  return value as Address;
};
function relayer(){
  const value=process.env.MONAD_RELAYER_PRIVATE_KEY;
  if(!value||!/^0x[0-9a-fA-F]{64}$/.test(value))throw new Error('MISSING_MONAD_RELAYER_PRIVATE_KEY');
  return privateKeyToAccount(value as Hex);
}
async function recordRefund(runName:string,jobId:string,refundTx:Hex){
  if(!/^[a-z0-9_-]{1,50}$/.test(runName))throw new Error('INVALID_RUN_NAME');
  const directory=resolve('demo-runs');const file=resolve(directory,`${runName}.json`);
  const run=JSON.parse(await readFile(file,'utf8')) as {jobId?:string;refundTx?:Hex};
  if(run.jobId!==jobId)throw new Error('RUN_JOB_ID_MISMATCH');
  if(run.refundTx&&run.refundTx.toLowerCase()!==refundTx.toLowerCase())throw new Error('REFUND_RECONCILIATION_REQUIRED');
  await mkdir(directory,{recursive:true});
  const temporary=file+'.tmp';
  await writeFile(temporary,JSON.stringify({...run,refundTx},null,2)+'\n',{mode:0o600});
  await rename(temporary,file);
}
async function main(){
  const [jobId,runName]=process.argv.slice(2);
  if(!jobId||!/^[1-9][0-9]*$/.test(jobId))throw new Error('USAGE: claim-refund <job-id>');
  const commerce=address('MONAD_COMMERCE_ADDRESS');
  const client=createPublicClient({chain:monadTestnet,transport:http(rpc,{timeout:15_000})});
  if(await client.getChainId()!==10143)throw new Error('WRONG_CHAIN');
  if((await client.getCode({address:commerce}))===undefined)throw new Error('COMMERCE_CODE_MISSING');
  const job=await client.readContract({address:commerce,abi:commerceAbi,functionName:'getJob',args:[BigInt(jobId)]}) as {status:number;expiredAt:bigint};
  if(![1,2].includes(job.status)||(await client.getBlock()).timestamp<job.expiredAt)throw new Error('REFUND_NOT_READY');
  const account=relayer();
  const wallet=createWalletClient({account,chain:monadTestnet,transport:http(rpc,{timeout:15_000})});
  const data=encodeFunctionData({abi:commerceAbi,functionName:'claimRefund',args:[BigInt(jobId)]});
  const request=await wallet.prepareTransactionRequest({to:commerce,data,account,chain:monadTestnet});
  const cap=BigInt(process.env.MONAD_MAX_TX_GAS??'2000000');
  if(cap<=0n||request.gas>cap)throw new Error('GAS_LIMIT_EXCEEDS_OPERATOR_CAP');
  const serialized=await wallet.signTransaction(request);
  const hash=keccak256(serialized);
  if(runName)await recordRefund(runName,jobId,hash);
  // Keep this hash when the RPC response is ambiguous; reconcile it before another send.
  console.log(JSON.stringify({jobId,refundHash:hash,runName,broadcast:'pending'},null,2));
  await client.sendRawTransaction({serializedTransaction:serialized});
  const receipt=await client.waitForTransactionReceipt({hash,confirmations:2});
  if(receipt.status!=='success')throw new Error(`REFUND_REVERTED_${hash}`);
  console.log(JSON.stringify({jobId,refundHash:hash,broadcast:'confirmed',blockNumber:receipt.blockNumber.toString()},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'CLAIM_REFUND_FAILED');process.exitCode=1;});
