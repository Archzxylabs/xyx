import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile, rename, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, keccak256, parseEventLogs, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import commerceArtifact from '../packages/contracts/out/AgenticCommerce.sol/AgenticCommerce.json' with {type:'json'};
import evaluatorArtifact from '../packages/contracts/out/XYXEvaluator.sol/XYXEvaluator.json' with {type:'json'};
import { atomicAmount, hashJSON } from '../packages/monad/src/canonical.js';
import { evidenceStorageFromEnvironment } from '../packages/monad/src/storage.js';
import { payoutDescription, payoutSpecSchema, verifyPayout, type JobSnapshot, type PayoutSpec, type ReceiptReader } from '../packages/monad/src/payout.js';
import { matchedFinalizedReceipt, matchedPayoutSnapshot, readPayoutSnapshot, type ChainReader } from '../packages/monad/src/chain.js';

const commerceAbi = commerceArtifact.abi as Abi;
const evaluatorAbi = evaluatorArtifact.abi as Abi;
const rpc = process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const publicClient = createPublicClient({chain:monadTestnet,transport:http(rpc,{timeout:15_000})});
const secondaryRpc=process.env.MONAD_SECONDARY_RPC_URL;
const secondaryClient=secondaryRpc?createPublicClient({chain:monadTestnet,transport:http(secondaryRpc,{timeout:15_000})}):undefined;
const runDir = resolve('demo-runs');
const address = (name:string) => {
  const value=process.env[name];
  if(!value || !/^0x[0-9a-fA-F]{40}$/.test(value))throw new Error(`MISSING_${name}`);
  return value as Address;
};
const signer = (name:string) => {
  const value=process.env[name];
  if(!value || !/^0x[0-9a-fA-F]{64}$/.test(value))throw new Error(`MISSING_${name}`);
  return privateKeyToAccount(value as Hex);
};
const storage=()=>{
  const value=evidenceStorageFromEnvironment(process.env);
  if(!value)throw new Error('IPFS_NOT_CONFIGURED');
  return value;
};
type Run = {spec:PayoutSpec;specURI:string;specHash:Hex;jobId?:string;createTx?:Hex;budgetTx?:Hex;approveTx?:Hex;fundTx?:Hex;transferTx?:Hex;submitTx?:Hex;evidenceURI?:string;evidenceHash?:Hex;decision?:string;reasonHash?:Hex;verdictTx?:Hex;refundTx?:Hex};
const runFile=(name:string)=>resolve(runDir,`${name}.json`);
function demoExpirySeconds(){
  const value=Number(process.env.MONAD_DEMO_EXPIRY_SECONDS??900);
  if(!Number.isSafeInteger(value) || value<300 || value>86400)throw new Error('INVALID_DEMO_EXPIRY_SECONDS');
  return value;
}
async function load(name:string):Promise<Run>{return JSON.parse(await readFile(runFile(name),'utf8')) as Run;}
async function save(name:string,run:Run){
  await mkdir(runDir,{recursive:true});
  const temp=runFile(name)+'.tmp';
  await writeFile(temp,JSON.stringify(run,null,2)+'\n',{mode:0o600});
  await rename(temp,runFile(name));
}
async function send(role:string,to:Address,abi:Abi,functionName:string,args:unknown[]=[],onBroadcast?:(hash:Hex)=>Promise<void>){
  await assertNetwork();
  const account=signer(role);
  const wallet=createWalletClient({account,chain:monadTestnet,transport:http(rpc,{timeout:15_000})});
  const data=encodeFunctionData({abi,functionName,args});
  const request=await wallet.prepareTransactionRequest({to,data,account,chain:monadTestnet});
  const maxGas=BigInt(process.env.MONAD_MAX_TX_GAS??'2000000');
  if(maxGas<=0n || request.gas>maxGas)throw new Error('GAS_LIMIT_EXCEEDS_OPERATOR_CAP');
  const serialized=await wallet.signTransaction(request);
  const hash=keccak256(serialized);
  // Persist the exact signed hash BEFORE broadcast, including ambiguous RPC failures.
  if(onBroadcast)await onBroadcast(hash);
  await publicClient.sendRawTransaction({serializedTransaction:serialized});
  const receipt=await publicClient.waitForTransactionReceipt({hash,confirmations:2});
  if(receipt.status!=='success')throw new Error(`REVERTED_${functionName}_${hash}`);
  return {hash,receipt};
}
async function job(id:string):Promise<JobSnapshot>{
  return await publicClient.readContract({address:address('MONAD_COMMERCE_ADDRESS'),abi:commerceAbi,functionName:'getJob',args:[BigInt(id)]}) as JobSnapshot;
}
async function assertNetwork(){if(await publicClient.getChainId()!==10143)throw new Error('WRONG_CHAIN');}

async function main(){
  const [command,name,argument]=process.argv.slice(2);
  if(!command || !name || !/^[a-z0-9_-]{1,50}$/.test(name))throw new Error('USAGE: monad-demo <prepare|create|budget|fund|execute|evaluate|refund|inspect> <run-name> [recipient|wrong]');
  if(!['prepare','create','budget','fund','execute','evaluate','refund','inspect'].includes(command))throw new Error('UNKNOWN_COMMAND');
  await mkdir(runDir,{recursive:true});
  const lock=resolve(runDir,`${name}.lock`);
  try {await mkdir(lock);}catch {throw new Error('RUN_LOCKED: another command is running; reconcile a stale lock before removing it');}
  try {await runCommand(command,name,argument);}finally {await rmdir(lock);}
}

async function runCommand(command:string,name:string,argument?:string){
  await assertNetwork();
  const commerce=address('MONAD_COMMERCE_ADDRESS');
  const evaluator=address('MONAD_EVALUATOR_ADDRESS');
  const token=address('MONAD_USDC_ADDRESS');
  if((await publicClient.getCode({address:commerce}))===undefined || (await publicClient.getCode({address:evaluator}))===undefined
    || (await publicClient.getCode({address:token}))===undefined)throw new Error('CONTRACT_CODE_MISSING');
  const decimals=await publicClient.readContract({address:token,abi:erc20Abi,functionName:'decimals'});
  if(decimals!==6)throw new Error('UNEXPECTED_USDC_DECIMALS');
  const commerceToken=await publicClient.readContract({address:commerce,abi:commerceAbi,functionName:'paymentToken'}) as Address;
  const evaluatorCommerce=await publicClient.readContract({address:evaluator,abi:evaluatorAbi,functionName:'agenticCommerce'}) as Address;
  if(commerceToken.toLowerCase()!==token.toLowerCase() || evaluatorCommerce.toLowerCase()!==commerce.toLowerCase())throw new Error('DEPLOYMENT_BINDING_MISMATCH');

  if(command==='prepare'){
    try {await access(runFile(name));throw new Error('RUN_ALREADY_EXISTS');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!argument || !/^0x[0-9a-fA-F]{40}$/.test(argument))throw new Error('RECIPIENT_REQUIRED');
    const buyer=signer('MONAD_BUYER_PRIVATE_KEY').address;
    const provider=signer('MONAD_PROVIDER_PRIVATE_KEY').address;
    const attestor=signer('MONAD_EVALUATOR_PRIVATE_KEY').address;
    const relayer=signer('MONAD_RELAYER_PRIVATE_KEY').address;
    if(new Set([buyer,provider,attestor,relayer].map(value=>value.toLowerCase())).size!==4)throw new Error('ROLE_WALLETS_NOT_SEPARATE');
    const gasBalances=await Promise.all([buyer,provider,attestor,relayer].map(value=>publicClient.getBalance({address:value})));
    if(gasBalances.some(value=>value===0n))throw new Error('MON_GAS_BALANCE_MISSING');
    const [buyerUSDC,providerUSDC]=await Promise.all([buyer,provider].map(value=>publicClient.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[value]})));
    if(buyerUSDC<atomicAmount('0.02',6) || providerUSDC<atomicAmount('0.01',6))throw new Error('DEMO_USDC_BALANCE_MISSING');
    const role=await publicClient.readContract({address:evaluator,abi:evaluatorAbi,functionName:'ATTESTOR_ROLE'}) as Hex;
    const authorized=await publicClient.readContract({address:evaluator,abi:evaluatorAbi,functionName:'hasRole',args:[role,attestor]});
    if(!authorized)throw new Error('EVALUATOR_ATTESTOR_NOT_AUTHORIZED');
    const now=(await publicClient.getBlock()).timestamp;
    const spec=payoutSpecSchema.parse({
      kind:'xyx.payout.v1',chainId:10143,commerce,buyer,
      provider,token,recipient:argument,
      amountAtomic:atomicAmount('0.01',6).toString(),rewardAtomic:atomicAmount('0.02',6).toString(),
      expiresAt:Number(now)+demoExpirySeconds(),
    });
    const persisted=await storage().persist(spec);
    const run:Run={spec,specURI:persisted.evidenceURI,specHash:hashJSON(spec)};
    await save(name,run);
    console.log(JSON.stringify({name,specURI:run.specURI,specHash:run.specHash,description:payoutDescription(spec,run.specURI)},null,2));
    return;
  }
  const run=await load(name);
  payoutSpecSchema.parse(run.spec);
  if(run.spec.commerce.toLowerCase()!==commerce.toLowerCase() || run.spec.token.toLowerCase()!==token.toLowerCase())throw new Error('RUN_DEPLOYMENT_MISMATCH');
  if(command!=='inspect'){
    const roles=['MONAD_BUYER_PRIVATE_KEY','MONAD_PROVIDER_PRIVATE_KEY','MONAD_EVALUATOR_PRIVATE_KEY','MONAD_RELAYER_PRIVATE_KEY'].map(key=>signer(key).address.toLowerCase());
    if(new Set(roles).size!==4 || roles[0]!==run.spec.buyer.toLowerCase() || roles[1]!==run.spec.provider.toLowerCase())throw new Error('RUN_WALLET_MISMATCH');
  }
  if(run.specHash.toLowerCase()!==hashJSON(run.spec).toLowerCase())throw new Error('LOCAL_SPEC_HASH_MISMATCH');
  await storage().readJSON(run.specURI,run.specHash);
  if(command==='create'){
    if(run.jobId || run.createTx)throw new Error('JOB_ALREADY_CREATED_OR_RECONCILIATION_REQUIRED');
    const result=await send('MONAD_BUYER_PRIVATE_KEY',commerce,commerceAbi,'createJob',[
      run.spec.provider,evaluator,BigInt(run.spec.expiresAt),payoutDescription(run.spec,run.specURI),'0x0000000000000000000000000000000000000000',
    ],async hash=>{run.createTx=hash;await save(name,run);});
    const events=parseEventLogs({abi:commerceAbi,logs:result.receipt.logs,eventName:'JobCreated'});
    if(events.length!==1)throw new Error('JOB_CREATE_EVENT_AMBIGUOUS');
    run.jobId=String((events[0].args as {jobId:bigint}).jobId);run.createTx=result.hash;
  } else {
    if(!run.jobId)throw new Error('JOB_NOT_CREATED');
    const current=await job(run.jobId);
    if(current.description!==payoutDescription(run.spec,run.specURI))throw new Error('ONCHAIN_SPEC_MISMATCH');
    if(current.client.toLowerCase()!==run.spec.buyer.toLowerCase() || current.provider.toLowerCase()!==run.spec.provider.toLowerCase()
      || current.evaluator.toLowerCase()!==evaluator.toLowerCase() || current.expiredAt!==BigInt(run.spec.expiresAt))throw new Error('ONCHAIN_JOB_MISMATCH');
    if(command==='budget'){
      if(run.budgetTx || current.status!==0)throw new Error('BUDGET_ALREADY_SET_OR_JOB_NOT_OPEN');
      run.budgetTx=(await send('MONAD_PROVIDER_PRIVATE_KEY',commerce,commerceAbi,'setBudget',[BigInt(run.jobId),BigInt(run.spec.rewardAtomic),'0x'],async hash=>{run.budgetTx=hash;await save(name,run);})).hash;
    } else if(command==='fund'){
      if(run.fundTx || current.status!==0 || current.budget!==BigInt(run.spec.rewardAtomic))throw new Error('FUNDING_NOT_READY');
      const allowance=await publicClient.readContract({address:token,abi:erc20Abi,functionName:'allowance',args:[run.spec.buyer as Address,commerce]});
      if(allowance<BigInt(run.spec.rewardAtomic)){
        if(run.approveTx)throw new Error('APPROVAL_RECONCILIATION_REQUIRED');
        run.approveTx=(await send('MONAD_BUYER_PRIVATE_KEY',token,erc20Abi,'approve',[commerce,BigInt(run.spec.rewardAtomic)],async hash=>{run.approveTx=hash;await save(name,run);})).hash;
      }
      run.fundTx=(await send('MONAD_BUYER_PRIVATE_KEY',commerce,commerceAbi,'fund',[BigInt(run.jobId),BigInt(run.spec.rewardAtomic),'0x'],async hash=>{run.fundTx=hash;await save(name,run);})).hash;
    } else if(command==='execute'){
      if(current.status!==1 || run.submitTx)throw new Error('EXECUTION_NOT_READY');
      if(current.budget!==BigInt(run.spec.rewardAtomic))throw new Error('JOB_BUDGET_MISMATCH');
      if(argument && argument!=='wrong')throw new Error('INVALID_EXECUTE_MODE');
      if(argument==='wrong' && run.spec.recipient.toLowerCase()===run.spec.buyer.toLowerCase())throw new Error('WRONG_RECIPIENT_MUST_DIFFER');
      if(!run.transferTx){
        const recipient=argument==='wrong'?run.spec.buyer:run.spec.recipient;
        run.transferTx=(await send('MONAD_PROVIDER_PRIVATE_KEY',token,erc20Abi,'transfer',[recipient,BigInt(run.spec.amountAtomic)],async hash=>{run.transferTx=hash;await save(name,run);})).hash;
      }
      const transferReceipt=await publicClient.getTransactionReceipt({hash:run.transferTx});
      if(transferReceipt.status!=='success')throw new Error('TRANSFER_RECONCILIATION_REQUIRED');
      run.submitTx=(await send('MONAD_PROVIDER_PRIVATE_KEY',commerce,commerceAbi,'submit',[BigInt(run.jobId),run.transferTx,'0x'],async hash=>{run.submitTx=hash;await save(name,run);})).hash;
    } else if(command==='evaluate'){
      if(run.verdictTx || !run.transferTx || current.status!==2)throw new Error('EVALUATION_NOT_READY');
      if(!secondaryClient)throw new Error('SECONDARY_RPC_REQUIRED_FOR_VERDICT');
      const snapshot=await matchedPayoutSnapshot(publicClient as ChainReader,secondaryClient as ChainReader,commerce,evaluator,BigInt(run.jobId),run.spec.provider as Address,run.transferTx);
      const observedJob=snapshot.job;
      if(observedJob.status!==2 || observedJob.evaluator.toLowerCase()!==evaluator.toLowerCase())throw new Error('WRONG_JOB_EVALUATOR');
      const role=await publicClient.readContract({address:evaluator,abi:evaluatorAbi,functionName:'ATTESTOR_ROLE'}) as Hex;
      const attestor=signer('MONAD_EVALUATOR_PRIVATE_KEY').address;
      if(!await publicClient.readContract({address:evaluator,abi:evaluatorAbi,functionName:'hasRole',args:[role,attestor]}))throw new Error('EVALUATOR_ATTESTOR_NOT_AUTHORIZED');
      await matchedFinalizedReceipt(publicClient as ReceiptReader,secondaryClient as ReceiptReader,run.transferTx);
      const evidence=await verifyPayout(publicClient as ReceiptReader,run.spec,observedJob,run.transferTx,snapshot.binding);
      const persisted=await storage().persist({...evidence,jobId:run.jobId,commerce,evaluator,specURI:run.specURI});
      const account=signer('MONAD_EVALUATOR_PRIVATE_KEY');
      const issuedAt=(await publicClient.getBlock()).timestamp;
      const lifetime=await publicClient.readContract({address:evaluator,abi:evaluatorAbi,functionName:'maxVerdictLifetime'}) as bigint;
      const expiresAt=[issuedAt+120n,issuedAt+lifetime,observedJob.expiredAt].reduce((a,b)=>a<b?a:b);
      if(expiresAt<=issuedAt)throw new Error('JOB_EXPIRED');
      const reasonHash=hashJSON(evidence.failures);
      const verdict={jobId:BigInt(run.jobId),evidenceHash:persisted.evidenceHash,reasonHash,
        decision:evidence.decision==='COMPLETE'?1:2,issuedAt,expiresAt,nonce:BigInt('0x'+randomBytes(8).toString('hex'))};
      const signature=await account.signTypedData({domain:{name:'XYX Evaluator',version:'1',chainId:10143,verifyingContract:evaluator},
        types:{JobVerdict:[{name:'jobId',type:'uint256'},{name:'evidenceHash',type:'bytes32'},{name:'reasonHash',type:'bytes32'},
          {name:'decision',type:'uint8'},{name:'issuedAt',type:'uint64'},{name:'expiresAt',type:'uint64'},{name:'nonce',type:'uint64'}]},
        primaryType:'JobVerdict',message:verdict});
      run.evidenceHash=persisted.evidenceHash;run.evidenceURI=persisted.evidenceURI;run.decision=evidence.decision;run.reasonHash=reasonHash;
      await save(name,run);
      run.verdictTx=(await send('MONAD_RELAYER_PRIVATE_KEY',evaluator,evaluatorAbi,'resolveJob',[verdict,signature],async hash=>{run.verdictTx=hash;await save(name,run);})).hash;
    } else if(command==='refund'){
      if(run.refundTx || ![1,2].includes(current.status) || (await publicClient.getBlock()).timestamp<current.expiredAt)throw new Error('REFUND_NOT_READY');
      run.refundTx=(await send('MONAD_RELAYER_PRIVATE_KEY',commerce,commerceAbi,'claimRefund',[BigInt(run.jobId)],async hash=>{run.refundTx=hash;await save(name,run);})).hash;
    } else if(command!=='inspect')throw new Error('UNKNOWN_COMMAND');
  }
  await save(name,run);
  console.log(JSON.stringify({run:name,jobId:run.jobId,status:run.jobId?(await job(run.jobId)).status:null,
    createTx:run.createTx,budgetTx:run.budgetTx,approveTx:run.approveTx,fundTx:run.fundTx,
    transferTx:run.transferTx,submitTx:run.submitTx,evidenceURI:run.evidenceURI,decision:run.decision,
    verdictTx:run.verdictTx,refundTx:run.refundTx},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'MONAD_DEMO_FAILED');process.exitCode=1;});
