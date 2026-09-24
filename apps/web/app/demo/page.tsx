import Link from 'next/link';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { viemPublicClientToCanonicalChainReader } from '../../../../packages/monad/src/canonical-chain';
import {
  resolveDemoConfiguration,
  observedStatusFor,
  unverifiedRunRow,
  canShowVerifiedExplorerTransaction,
  UNAVAILABLE,
  type DemoRunRow,
  type ObservedStatus,
} from '../../../../packages/monad/src/demo-state';
import { canonicalManifestSchema, type CanonicalManifest, type CanonicalRun } from '../../../../packages/monad/src/manifest';
import { verifySettlement, type CanonicalSettlementInput } from '../../../../packages/monad/src/settlement';
import { publicEvidenceReaderFromEnvironment } from '../../../../packages/monad/src/storage';
import { categorizeError, type VerificationCategory } from '../../../../packages/monad/src/verification';

export const dynamic='force-dynamic';
const explorer='https://testnet.monadvision.com';

const HEX_RE = /^0x[0-9a-fA-F]{64}$/;

function validateHex(value: string): Hex {
  if (!HEX_RE.test(value)) throw new Error(`Invalid hex: ${value}`);
  return value as Hex;
}

type Published={manifest:CanonicalManifest;reader:NonNullable<ReturnType<typeof publicEvidenceReaderFromEnvironment>>;uri:string;hash:string};

function protocolTokenMismatch(manifest: CanonicalManifest, configuredProtocol: Address, configuredToken: Address): boolean {
  return manifest.protocol.toLowerCase() !== configuredProtocol.toLowerCase()
    || manifest.token.toLowerCase() !== configuredToken.toLowerCase();
}

/**
 * Build the settlement verification input from a canonical run.
 *
 * `CanonicalRun` is a discriminated union on `outcome`, so TypeScript narrows
 * to the EXPIRED variant (refundTx only) or the verdict variants (full
 * commitments + resolveTx) with no casts.
 */
function buildSettlementInput(
  run: CanonicalRun,
  protocol: Address,
  token: Address,
): CanonicalSettlementInput {
  const jobId = BigInt(run.jobId);
  if (run.outcome === 'EXPIRED') {
    return {
      protocol,
      token,
      jobId,
      refundTx: validateHex(run.refundTx),
    };
  }
  const decision = run.decision === 'COMPLETE' ? 1 : 2;
  return {
    protocol,
    token,
    jobId,
    verdict: {
      jobId,
      termsCommitment: validateHex(run.termsCommitment),
      deliveryCommitment: validateHex(run.deliveryCommitment),
      evidenceCommitment: validateHex(run.evidenceCommitment),
      reasonCommitment: validateHex(run.reasonCommitment),
      decision,
      issuedAt: BigInt(run.issuedAt),
      expiresAt: BigInt(run.expiresAt),
      nonce: BigInt(run.nonce),
    },
    resolveTx: validateHex(run.resolveTx),
  };
}

async function published():Promise<{source:Published} | {error:string}>{
  const uri=process.env.XYX_CANONICAL_MANIFEST_URI;
  const hash=process.env.XYX_CANONICAL_MANIFEST_HASH;
  if(!uri&&!hash)return {error:'A canonical manifest with complete commitments and settlement transactions will appear here after Monad testnet receipts are observed.'};
  if(!uri||!hash)return {error:'Canonical manifest configuration is incomplete'};
  const reader=publicEvidenceReaderFromEnvironment(process.env);
  if(!reader)return {error:'Public IPFS gateway is not configured'};
  try {
    const manifest=canonicalManifestSchema.parse(await reader.readJSON(uri,hash));
    return {source:{manifest,reader,uri,hash}};
  } catch (error) {
    return {error:error instanceof Error ? error.message : 'Canonical manifest unavailable'};
  }
}

/**
 * Render a run's settlement transaction.
 *
 * `verified` comes from `canShowVerifiedExplorerTransaction` — the single place
 * explorer-link policy lives — so a MonadVision link is produced only for a
 * transaction that dual-RPC settlement verification actually verified. A hash
 * that exists but was not verified is shown as text only, never as a link.
 */
function Tx({hash,label,verified}:{hash?:string;label:string;verified:boolean}){
  return <div style={{display:'flex',justifyContent:'space-between',gap:16,padding:'9px 0',borderBottom:'1px solid #334337'}}><span>{label}</span>
  {hash&&verified?<a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="mono">{hash.slice(0,12)}…{hash.slice(-8)} ↗</a>
  :<span className="muted">{hash?'Not verified — no explorer link':'Not applicable'}</span>}</div>;
}

export default async function Demo(){
  const configuration = resolveDemoConfiguration(process.env);
  const secondaryRpcRaw=process.env.XYX_SECONDARY_RPC_URL;

  // Missing, malformed, or zero address configuration renders the
  // configuration-required state. No RPC client is ever created for it.
  if (!configuration) {
    return <main style={{maxWidth:1100,margin:'0 auto',padding:'36px 24px 100px'}}>
      <header style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:24,marginBottom:80}}><Link href="/" style={{fontWeight:900,fontSize:28,letterSpacing:'-.08em'}}>XYX</Link><span className="eyebrow">MONAD TESTNET · EVIDENCE BEFORE SETTLEMENT</span></header>
      <div className="eyebrow" style={{color:'#bcfa73'}}>CANONICAL DEMO / XYX DELIVERY PROTOCOL</div>
      <h1 style={{fontSize:'clamp(42px,7vw,88px)',lineHeight:1.02,maxWidth:900,letterSpacing:'-.07em',margin:'18px 0'}}>Settlement without secrets.</h1>
      <p style={{maxWidth:740,fontSize:20,color:'#b8c5bb'}}>Every run carries on-chain commitments and dual-RPC verification. The demo shows an empty state until real receipts and contract state are observed.</p>
      <section aria-labelledby="runs-heading" style={{marginTop:40}}>
        <div style={{border:'1px solid #334337',borderRadius:14,padding:30}}>
          <strong>Configuration required.</strong>
          <p className="muted">Set XYX_PROTOCOL_ADDRESS, XYX_PAYMENT_TOKEN_ADDRESS, XYX_RPC_URL, XYX_CANONICAL_MANIFEST_URI, and XYX_CANONICAL_MANIFEST_HASH to display canonical runs. Addresses must be non-zero.</p>
        </div>
      </section>
    </main>;
  }

  const client=createPublicClient({chain:monadTestnet,transport:http(configuration.rpcUrl,{timeout:7_000})});
  const secondaryClient=secondaryRpcRaw?createPublicClient({chain:monadTestnet,transport:http(secondaryRpcRaw,{timeout:7_000})}):undefined;
  const primaryReader = viemPublicClientToCanonicalChainReader(client);
  const secondaryReader = secondaryClient ? viemPublicClientToCanonicalChainReader(secondaryClient) : undefined;
  const configuredProtocol = configuration.protocol;
  const configuredToken = configuration.token;

  let source:Published|undefined;
  let sourceError:string|undefined;
  let conflict=false;

  try {
    const publishedResult = await published();
    if ('error' in publishedResult) {
      sourceError = publishedResult.error;
    } else {
      if (protocolTokenMismatch(publishedResult.source.manifest, configuredProtocol, configuredToken)) {
        conflict = true;
        sourceError = 'Manifest points to a different deployment than this demo.';
      } else {
        source = publishedResult.source;
      }
    }
  } catch (error) {
    sourceError = error instanceof Error ? error.message : 'Canonical manifest unavailable';
  }

  const rows = await Promise.all((source?.manifest.runs??[]).map(async run=>{
    const claimedOutcome=run.outcome;
    // Default observed status is Unavailable: nothing is claimed to be on-chain
    // until a valid finalized observation is actually read.
    let verification:VerificationCategory='PENDING';
    let observedStatus:ObservedStatus=UNAVAILABLE;
    let proof='Awaiting on-chain completion';

    try {
      const input = buildSettlementInput(run, configuredProtocol, configuredToken);
      const settlement = await verifySettlement(primaryReader, secondaryReader, input);
      verification = settlement.state;
      observedStatus = observedStatusFor(settlement.state, settlement.outcome);
      if (verification === 'PENDING') {
        proof = 'Awaiting final settlement receipt';
      } else if (verification === 'LIVE_VERIFIED') {
        proof = 'All published commitments, final chain state, and escrow transfer match.';
      } else if (verification === 'REJECT') {
        proof = 'Canonical protocol rejection confirmed on-chain.';
      }
    } catch (error) {
      // Verification failed: the manifest outcome stays a claim, and the
      // observed status is never promoted to a terminal chain status.
      const categorized = categorizeError(error);
      return { run, row: unverifiedRunRow(run.name, claimedOutcome, categorized.category, categorized.message) };
    }
    return { run, row: {name:run.name,claimedOutcome,observedStatus,verification,proof} };
  }));

  return <main style={{maxWidth:1100,margin:'0 auto',padding:'36px 24px 100px'}}>
    <header style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:24,marginBottom:80}}><Link href="/" style={{fontWeight:900,fontSize:28,letterSpacing:'-.08em'}}>XYX</Link><span className="eyebrow">MONAD TESTNET · EVIDENCE BEFORE SETTLEMENT</span></header>
    <div className="eyebrow" style={{color:'#bcfa73'}}>CANONICAL DEMO / XYX DELIVERY PROTOCOL</div>
    <h1 style={{fontSize:'clamp(42px,7vw,88px)',lineHeight:1.02,maxWidth:900,letterSpacing:'-.07em',margin:'18px 0'}}>Settlement without secrets.</h1>
    <p style={{maxWidth:740,fontSize:20,color:'#b8c5bb'}}>Every run carries on-chain commitments and dual-RPC verification. The demo shows an empty state until real receipts and contract state are observed.</p>
    <section aria-labelledby="runs-heading"><h2 id="runs-heading" style={{fontSize:32}}>Canonical runs</h2>
      {conflict?<div style={{border:'1px solid #334337',borderRadius:14,padding:30,marginBottom:20}}><strong>CONFLICT: {sourceError}</strong><p className="muted">The configured protocol/token does not match the canonical manifest. Verify configuration before relying on any run data.</p></div>:null}
      {rows.length===0?<div style={{border:'1px solid #334337',borderRadius:14,padding:30}}><strong>No canonical run published yet.</strong><p className="muted">{sourceError??'A canonical manifest with complete commitments and settlement transactions will appear here after Monad testnet receipts are observed.'}</p></div>:null}
      {source?<p className="muted mono">Manifest: {source.uri}<br/>Hash: {source.hash}</p>:null}
      <div style={{display:'grid',gap:20}}>{rows.map(({run,row})=>{const explorerTx=canShowVerifiedExplorerTransaction(row.verification,row.claimedOutcome);return <article key={row.name} style={{border:'1px solid #334337',borderRadius:14,padding:28,background:'#15251c'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'start',gap:20,flexWrap:'wrap'}}><div><div className="eyebrow">RUN / {row.name.toUpperCase()}</div><h3 style={{fontSize:30,margin:'7px 0'}}>Job {run.jobId}</h3></div><div style={{border:'1px solid #63765b',padding:'8px 14px',borderRadius:99}}>{row.verification} · {row.observedStatus}</div></div>
        <p style={{color:row.verification==='LIVE_VERIFIED'?'#bcfa73':row.verification==='REJECT'?'#ff9e9e':row.verification==='CONFLICT'?'#ff9e9e':'#f2d484'}}>{row.proof}</p>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:20,margin:'22px 0'}}>
          <div><div className="eyebrow">COMMITMENTS</div><p className="mono">Protocol: {run.protocol}<br/>Token: {run.token}<br/>Claimed outcome: {row.claimedOutcome}</p></div>
          <div><div className="eyebrow">OBSERVED CHAIN STATUS</div><p className="mono">{row.observedStatus}</p></div>
          {run.outcome!=='EXPIRED'?<div><div className="eyebrow">VERDICT</div><p className="mono">Decision: {run.decision}<br/>Issued: {run.issuedAt}<br/>Expires: {run.expiresAt}<br/>Nonce: {run.nonce}</p></div>:null}
        </div>
        <div style={{display:'grid',gap:10,marginTop:16}}>
          {run.outcome!=='EXPIRED'?<Tx label="Resolution transaction" hash={run.resolveTx} verified={explorerTx}/>:null}
          {run.outcome==='EXPIRED'?<Tx label="Refund transaction" hash={run.refundTx} verified={explorerTx}/>:null}
        </div>
      </article>})}</div>
    </section>
  </main>;
}
