import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { canonicalJSON, hashJSON } from '../packages/monad/src/canonical.js';
import { publicManifestSchema, type PublicRun } from '../packages/monad/src/manifest.js';
import { evidenceStorageFromEnvironment } from '../packages/monad/src/storage.js';
import { parsePayoutDescription, payoutSpecSchema, verifyPayout, type PayoutSpec, type ReceiptReader } from '../packages/monad/src/payout.js';
import { matchedFinalizedReceipt, matchedPayoutSnapshot, type ChainReader } from '../packages/monad/src/chain.js';
import { verifySettlement } from '../packages/monad/src/settlement.js';

type LocalRun={spec:PayoutSpec;specURI:string;specHash:Hex;jobId?:string;createTx?:Hex;fundTx?:Hex;transferTx?:Hex;submitTx?:Hex;evidenceURI?:string;evidenceHash?:Hex;decision?:'COMPLETE'|'REJECT';reasonHash?:Hex;verdictTx?:Hex;refundTx?:Hex};
const runDirectory=resolve('demo-runs');
const rpc=process.env.MONAD_RPC_URL??'https://testnet-rpc.monad.xyz';
const client=createPublicClient({chain:monadTestnet,transport:http(rpc,{timeout:15_000})});
const secondaryRpc=process.env.MONAD_SECONDARY_RPC_URL;
const secondaryClient=secondaryRpc?createPublicClient({chain:monadTestnet,transport:http(secondaryRpc,{timeout:15_000})}):undefined;
const address=(key:string)=>{
  const value=process.env[key];
  if(!value||!/^0x[0-9a-fA-F]{40}$/.test(value))throw new Error(`MISSING_${key}`);
  return value as Address;
};
const hash=(value:unknown,key:string)=>{
  if(typeof value!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(value))throw new Error(`MISSING_${key}`);
  return value as Hex;
};
function publicRun(name:string,run:LocalRun):PublicRun {
  if(!run.jobId||!run.createTx||!run.fundTx)throw new Error(`INCOMPLETE_RUN_${name}`);
  return {
    name,spec:run.spec,specURI:run.specURI,specHash:hash(run.specHash,`${name}_SPEC_HASH`),jobId:run.jobId,
    transactions:{create:hash(run.createTx,`${name}_CREATE_TX`),fund:hash(run.fundTx,`${name}_FUND_TX`),
      ...(run.transferTx?{transfer:hash(run.transferTx,`${name}_TRANSFER_TX`)}:{}),
      ...(run.submitTx?{submit:hash(run.submitTx,`${name}_SUBMIT_TX`)}:{}),
      ...(run.verdictTx?{verdict:hash(run.verdictTx,`${name}_VERDICT_TX`)}:{}),
      ...(run.refundTx?{refund:hash(run.refundTx,`${name}_REFUND_TX`)}:{})},
    ...(run.decision?{decision:run.decision,reasonHash:hash(run.reasonHash,`${name}_REASON_HASH`),evidenceURI:run.evidenceURI,evidenceHash:hash(run.evidenceHash,`${name}_EVIDENCE_HASH`)}:{}),
  };
}
function same(value:unknown,expected:string){return typeof value==='string'&&value.toLowerCase()===expected.toLowerCase();}
function evidenceMatches(value:unknown,run:PublicRun,recomputed:{specHash:Hex;transferHash:Hex;decision:'COMPLETE'|'REJECT';failures:string[]}){
  if(typeof value!=='object'||value===null||Array.isArray(value))throw new Error(`PUBLISH_EVIDENCE_SHAPE_${run.name}`);
  const evidence=value as Record<string,unknown>;
  if(evidence.kind!=='xyx.payout.evidence.v2'||!same(evidence.specHash,run.specHash)||!same(evidence.transferHash,recomputed.transferHash)
    ||evidence.decision!==recomputed.decision||!Array.isArray(evidence.failures)||!run.reasonHash||hashJSON(evidence.failures)!==hash(run.reasonHash,`${run.name}_REASON_HASH`))throw new Error(`PUBLISH_EVIDENCE_MISMATCH_${run.name}`);
}
async function verifyRun(run:PublicRun,commerce:Address,evaluator:Address,token:Address,storage:NonNullable<ReturnType<typeof evidenceStorageFromEnvironment>>){
  if(!secondaryClient)throw new Error('SECONDARY_RPC_REQUIRED_FOR_PUBLISH');
  const storedSpec=payoutSpecSchema.parse(await storage.readJSON(run.specURI,run.specHash));
  if(canonicalJSON(storedSpec)!==canonicalJSON(run.spec))throw new Error(`PUBLISH_SPEC_MISMATCH_${run.name}`);
  const transfer=run.transactions.transfer?hash(run.transactions.transfer,`${run.name}_TRANSFER_TX`):`0x${'0'.repeat(64)}` as Hex;
  const snapshot=await matchedPayoutSnapshot(client as ChainReader,secondaryClient as ChainReader,commerce,evaluator,BigInt(run.jobId),run.spec.provider as Address,transfer);
  const description=parsePayoutDescription(snapshot.job.description);
  if(!same(description.specHash,run.specHash)||description.specURI!==run.specURI)throw new Error(`PUBLISH_JOB_COMMITMENT_MISMATCH_${run.name}`);
  if(run.transactions.transfer){
    await matchedFinalizedReceipt(client as ReceiptReader,secondaryClient as ReceiptReader,transfer);
    const recomputed=await verifyPayout(client as ReceiptReader,run.spec,snapshot.job,transfer,snapshot.binding);
    if(!run.decision||recomputed.decision!==run.decision||!run.evidenceURI||!run.evidenceHash)throw new Error(`PUBLISH_VERDICT_MISMATCH_${run.name}`);
    evidenceMatches(await storage.readJSON(run.evidenceURI,run.evidenceHash),run,recomputed);
  }
  const settlement=await verifySettlement(client as ReceiptReader,{commerce,evaluator,token,jobId:BigInt(run.jobId),job:snapshot.job,
    verdictTx:run.transactions.verdict?hash(run.transactions.verdict,`${run.name}_VERDICT_TX`):undefined,
    refundTx:run.transactions.refund?hash(run.transactions.refund,`${run.name}_REFUND_TX`):undefined,
    evidenceHash:run.evidenceHash?hash(run.evidenceHash,`${run.name}_EVIDENCE_HASH`):undefined,
    reasonHash:run.reasonHash?hash(run.reasonHash,`${run.name}_REASON_HASH`):undefined,decision:run.decision});
  const settlementTx=snapshot.job.status===5?run.transactions.refund:run.transactions.verdict;
  if(settlementTx)await matchedFinalizedReceipt(client as ReceiptReader,secondaryClient as ReceiptReader,hash(settlementTx,`${run.name}_SETTLEMENT_TX`));
  if(settlement.state!=='LIVE VERIFIED')throw new Error(`PUBLISH_SETTLEMENT_NOT_FINAL_${run.name}`);
}
async function main(){
  if(await client.getChainId()!==10143)throw new Error('WRONG_CHAIN');
  const names=(await readdir(runDirectory)).filter(name=>/^[a-z0-9_-]+\.json$/.test(name)).sort();
  if(names.length===0)throw new Error('NO_RUNS_TO_PUBLISH');
  const runs=await Promise.all(names.map(async file=>publicRun(file.slice(0,-5),JSON.parse(await readFile(resolve(runDirectory,file),'utf8')) as LocalRun)));
  const block=await client.getBlock({blockTag:'finalized'});
  const commerce=address('MONAD_COMMERCE_ADDRESS');const evaluator=address('MONAD_EVALUATOR_ADDRESS');const token=address('MONAD_USDC_ADDRESS');
  const manifest=publicManifestSchema.parse({kind:'xyx.monad.public-manifest.v1',chainId:10143,commerce,evaluator,token,
    generatedAt:Number(block.timestamp),runs});
  const storage=evidenceStorageFromEnvironment(process.env);
  if(!storage)throw new Error('IPFS_UPLOAD_NOT_CONFIGURED');
  for(const run of manifest.runs)await verifyRun(run,commerce,evaluator,token,storage);
  const persisted=await storage.persist(manifest);
  console.log(JSON.stringify({manifestURI:persisted.evidenceURI,manifestHash:persisted.evidenceHash,
    environment:{XYX_PUBLIC_MANIFEST_URI:persisted.evidenceURI,XYX_PUBLIC_MANIFEST_HASH:persisted.evidenceHash},runs:manifest.runs.map(run=>run.name)},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'MANIFEST_PUBLISH_FAILED');process.exitCode=1;});
