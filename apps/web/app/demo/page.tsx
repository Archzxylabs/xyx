import Link from 'next/link';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { canonicalJSON, hashJSON } from '../../../../packages/monad/src/canonical';
import { publicManifestSchema, type PublicManifest, type PublicRun } from '../../../../packages/monad/src/manifest';
import { payoutSpecSchema, parsePayoutDescription, verifyPayout, type ReceiptReader } from '../../../../packages/monad/src/payout';
import { publicEvidenceReaderFromEnvironment } from '../../../../packages/monad/src/storage';
import { matchedFinalizedReceipt, matchedPayoutSnapshot, type ChainReader } from '../../../../packages/monad/src/chain';
import { verifySettlement } from '../../../../packages/monad/src/settlement';

export const dynamic='force-dynamic';
const explorer='https://testnet.monadvision.com';
const statuses=['Open','Funded','Submitted','Completed','Rejected','Expired'];
const zeroHash=`0x${'0'.repeat(64)}` as Hex;

type Published={manifest:PublicManifest;reader:NonNullable<ReturnType<typeof publicEvidenceReaderFromEnvironment>>;uri:string;hash:Hex};
type Result={name:string;run:PublicRun;status:string;verification:'PENDING'|'LIVE VERIFIED'|'UNVERIFIED'|'CONFLICT';proof:string;observed:string[];transferChecked:boolean};

async function published():Promise<Published|undefined>{
  const uri=process.env.XYX_PUBLIC_MANIFEST_URI;
  const hash=process.env.XYX_PUBLIC_MANIFEST_HASH as Hex|undefined;
  if(!uri&&!hash)return undefined;
  if(!uri||!hash)throw new Error('Public manifest configuration is incomplete');
  const reader=publicEvidenceReaderFromEnvironment(process.env);
  if(!reader)throw new Error('Public IPFS gateway is not configured');
  return {manifest:publicManifestSchema.parse(await reader.readJSON(uri,hash)),reader,uri,hash};
}
function record(value:unknown):Record<string,unknown>{
  if(typeof value!=='object'||value===null||Array.isArray(value))throw new Error('Evidence has an invalid shape');
  return value as Record<string,unknown>;
}
function same(value:unknown,expected:string){return typeof value==='string'&&value.toLowerCase()===expected.toLowerCase();}
const hex=(value:string|undefined)=>value as Hex|undefined;
function checkStoredEvidence(value:unknown,run:PublicRun,recomputed:{specHash:Hex;transferHash:Hex;decision:'COMPLETE'|'REJECT';failures:string[]}){
  const evidence=record(value);
  if(evidence.kind!=='xyx.payout.evidence.v2'||!same(evidence.specHash,run.specHash)||!same(evidence.transferHash,recomputed.transferHash)
    ||evidence.decision!==recomputed.decision||!Array.isArray(evidence.failures)||!run.reasonHash||hashJSON(evidence.failures)!==run.reasonHash)throw new Error('Stored evidence conflicts with recomputation');
}
function Tx({hash,label}:{hash?:Hex;label:string}){
  return <div style={{display:'flex',justifyContent:'space-between',gap:16,padding:'9px 0',borderBottom:'1px solid #334337'}}><span>{label}</span>{hash?<a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="mono">{hash.slice(0,12)}…{hash.slice(-8)} ↗</a>:<span className="muted">Not applicable</span>}</div>;
}

export default async function Demo(){
  let source:Published|undefined;let sourceError:string|undefined;
  try{source=await published();}catch(error){sourceError=error instanceof Error?error.message:'Public manifest unavailable';}
  const commerce=process.env.MONAD_COMMERCE_ADDRESS as Address|undefined;
  const evaluator=process.env.MONAD_EVALUATOR_ADDRESS as Address|undefined;
  const token=process.env.MONAD_USDC_ADDRESS as Address|undefined;
  const client=createPublicClient({chain:monadTestnet,transport:http(process.env.MONAD_RPC_URL??'https://testnet-rpc.monad.xyz',{timeout:7_000})});
  const secondaryRPC=process.env.MONAD_SECONDARY_RPC_URL;
  const secondaryClient=secondaryRPC?createPublicClient({chain:monadTestnet,transport:http(secondaryRPC,{timeout:7_000})}):undefined;
  const results:Result[]=await Promise.all((source?.manifest.runs??[]).map(async run=>{
    let status='Not created';let verification:'PENDING'|'LIVE VERIFIED'|'UNVERIFIED'|'CONFLICT'='PENDING';let proof='Awaiting on-chain completion';let observed:string[]=[];let transferChecked=false;
    try{
      if(!commerce||!evaluator||!token)throw new Error('Published contract configuration is incomplete');
      if(!secondaryClient)throw new Error('Secondary RPC is required for LIVE VERIFIED');
      if(!same(source!.manifest.commerce,commerce)||!same(source!.manifest.evaluator,evaluator)||!same(source!.manifest.token,token))throw new Error('Manifest deployment conflicts with server configuration');
      if(await client.getChainId()!==10143)throw new Error('RPC is not Monad Testnet');
      const storedSpec=payoutSpecSchema.parse(await source!.reader.readJSON(run.specURI,run.specHash));
      if(canonicalJSON(storedSpec)!==canonicalJSON(run.spec)||run.specHash.toLowerCase()!==hashJSON(run.spec).toLowerCase())throw new Error('Published specification conflicts with its commitment');
      const transfer=hex(run.transactions.transfer);
      const snapshot=await matchedPayoutSnapshot(client as ChainReader,secondaryClient as ChainReader,commerce,evaluator,BigInt(run.jobId),run.spec.provider as Address,transfer??zeroHash);
      const job=snapshot.job;status=statuses[job.status]??'Unknown';
      const description=parsePayoutDescription(job.description);
      if(!same(description.specHash,run.specHash)||description.specURI!==run.specURI)throw new Error('On-chain job conflicts with published specification');
      let recomputed:Awaited<ReturnType<typeof verifyPayout>>|undefined;
      if(transfer){
        await matchedFinalizedReceipt(client as ReceiptReader,secondaryClient as ReceiptReader,transfer);
        recomputed=await verifyPayout(client as ReceiptReader,run.spec,job,transfer,snapshot.binding);
        transferChecked=true;observed=recomputed.failures;
        if(!run.evidenceURI||!run.evidenceHash||!run.decision||!run.reasonHash)throw new Error('Published verdict evidence is incomplete');
        checkStoredEvidence(await source!.reader.readJSON(run.evidenceURI,run.evidenceHash),run,recomputed);
        if(recomputed.decision!==run.decision)throw new Error('Attested decision conflicts with recomputation');
      }
      const settlement=await verifySettlement(client as ReceiptReader,{commerce,evaluator,token,jobId:BigInt(run.jobId),job,
        verdictTx:hex(run.transactions.verdict),refundTx:hex(run.transactions.refund),evidenceHash:hex(run.evidenceHash),reasonHash:hex(run.reasonHash),decision:run.decision});
      const settlementTx=job.status===5?hex(run.transactions.refund):hex(run.transactions.verdict);
      if(settlementTx)await matchedFinalizedReceipt(client as ReceiptReader,secondaryClient as ReceiptReader,settlementTx);
      verification=settlement.state;
      proof=settlement.state==='LIVE VERIFIED'?'All published evidence, final chain state, and escrow transfer match.':'Awaiting final settlement receipt';
    }catch(error){
      proof=error instanceof Error?error.message:'Verification unavailable';
      verification=/conflict|mismatch/i.test(proof)?'CONFLICT':'UNVERIFIED';
    }
    return {name:run.name,run,status,verification,proof,observed,transferChecked};
  }));
  return <main style={{maxWidth:1100,margin:'0 auto',padding:'36px 24px 100px'}}>
    <header style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:24,marginBottom:80}}><Link href="/" style={{fontWeight:900,fontSize:28,letterSpacing:'-.08em'}}>XYX</Link><span className="eyebrow">MONAD TESTNET · EVIDENCE BEFORE SETTLEMENT</span></header>
    <div className="eyebrow" style={{color:'#bcfa73'}}>LIVE DEMO / PROTECTED AGENT JOB</div>
    <h1 style={{fontSize:'clamp(42px,7vw,88px)',lineHeight:1.02,maxWidth:900,letterSpacing:'-.07em',margin:'18px 0'}}>Pay agents for what they prove.</h1>
    <p style={{maxWidth:740,fontSize:20,color:'#b8c5bb'}}>A buyer funds a job. A provider sends a USDC payout. XYX checks the transaction against committed terms, then releases or refunds the escrow.</p>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))',gap:12,margin:'48px 0'}}>{[['01','Commit','Buyer fixes recipient, amount, and reward in an IPFS specification.'],['02','Execute','Provider transfers USDC and submits the transaction hash.'],['03','Verify','XYX recomputes the result from finalized chain data and IPFS evidence.'],['04','Settle','The escrow receipt proves reward release or refund.']].map(([n,title,body])=><div key={n} style={{border:'1px solid #334337',borderRadius:14,padding:22,background:'#15251c'}}><div className="eyebrow">{n}</div><h2 style={{margin:'12px 0 8px'}}>{title}</h2><p className="muted">{body}</p></div>)}</div>
    <section aria-labelledby="runs-heading"><h2 id="runs-heading" style={{fontSize:32}}>Published runs</h2>
      {results.length===0?<div style={{border:'1px solid #334337',borderRadius:14,padding:30}}><strong>No published live run yet.</strong><p className="muted">{sourceError??'A signed public manifest will appear here after Monad testnet receipts and IPFS evidence are available.'}</p></div>:null}
      {source?<p className="muted mono">Manifest: {source.uri}<br/>Hash: {source.hash}</p>:null}
      <div style={{display:'grid',gap:20}}>{results.map(({name,run,status,verification,proof,observed,transferChecked})=><article key={name} style={{border:'1px solid #334337',borderRadius:14,padding:28,background:'#15251c'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'start',gap:20,flexWrap:'wrap'}}><div><div className="eyebrow">RUN / {name.toUpperCase()}</div><h3 style={{fontSize:30,margin:'7px 0'}}>Job {run.jobId}</h3></div><div style={{border:'1px solid #63765b',padding:'8px 14px',borderRadius:99}}>{verification} · {status}</div></div>
        <p style={{color:verification==='LIVE VERIFIED'?'#bcfa73':verification==='CONFLICT'?'#ff9e9e':'#f2d484'}}>{proof}</p>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:20,margin:'22px 0'}}><div><div className="eyebrow">EXPECTED</div><p className="mono">Token: {run.spec.token}<br/>From: {run.spec.provider}<br/>To: {run.spec.recipient}<br/>Amount: {run.spec.amountAtomic} atomic USDC</p></div><div><div className="eyebrow">OBSERVATION</div><p>{transferChecked?observed.length?observed.join(', '):'Transfer fields match committed terms':run.transactions.transfer?'Transfer verification unavailable':'No provider transfer: expiry path'}</p><p className="mono">Spec hash: {run.specHash}</p></div></div>
        <Tx label="Create job" hash={hex(run.transactions.create)}/><Tx label="Fund escrow" hash={hex(run.transactions.fund)}/><Tx label="Provider transfer" hash={hex(run.transactions.transfer)}/><Tx label="Submit proof" hash={hex(run.transactions.submit)}/><Tx label="Verdict and settlement" hash={hex(run.transactions.verdict)}/><Tx label="Expiry refund" hash={hex(run.transactions.refund)}/>
        <div style={{display:'flex',gap:20,marginTop:20,flexWrap:'wrap'}}><span className="mono">Spec: {run.specURI}</span>{run.evidenceURI?<span className="mono">Evidence: {run.evidenceURI}</span>:null}</div>
      </article>)}</div>
    </section>
  </main>;
}
