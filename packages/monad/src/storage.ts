import { canonicalJSON, hashText } from './canonical';

export type KuboStorageOptions={provider:'kubo';api:string;authorization?:string};
export type PinataStorageOptions={provider:'pinata';jwt:string;gateway:string};
export type EvidenceStorageOptions=KuboStorageOptions|PinataStorageOptions;
export type StorageEnvironment=Record<string,unknown>;

const cid=/^b[a-z2-7]{20,}$/;

export function evidenceStorageFromEnvironment(env:StorageEnvironment):EvidenceStorage|undefined {
  const value=(key:string)=>typeof env[key]==='string'&&env[key]?env[key] as string:undefined;
  const provider=value('IPFS_PROVIDER')??'kubo';const api=value('IPFS_API_URL');const authorization=value('IPFS_AUTHORIZATION');const jwt=value('PINATA_JWT');const gateway=value('IPFS_GATEWAY_URL');
  if(provider==='pinata')return jwt&&gateway?new EvidenceStorage({provider:'pinata',jwt,gateway}):undefined;
  if(provider==='kubo')return api?new EvidenceStorage({provider:'kubo',api,authorization}):undefined;
  return undefined;
}

export function publicEvidenceReaderFromEnvironment(env:StorageEnvironment):PublicEvidenceReader|undefined {
  const value=(key:string)=>typeof env[key]==='string'&&env[key]?env[key] as string:undefined;
  const gateway=value('IPFS_PUBLIC_GATEWAY_URL')??value('IPFS_GATEWAY_URL');
  return gateway?new PublicEvidenceReader(gateway):undefined;
}

function gatewayURL(gateway:string,value:string) {
  const base=new URL(gateway);const path=base.pathname.replace(/\/$/,'');
  return new URL(`${path.endsWith('/ipfs')?path:`${path}/ipfs`}/${value}`,base.origin);
}

function validateJSON(text:string,expectedHash:string) {
  if(hashText(text).toLowerCase()!==expectedHash.toLowerCase())throw new Error('EVIDENCE_HASH_MISMATCH');
  let parsed:unknown;try {parsed=JSON.parse(text);}catch {throw new Error('EVIDENCE_INVALID_JSON');}
  if(canonicalJSON(parsed)!==text)throw new Error('EVIDENCE_NOT_CANONICAL');
  return parsed;
}

export class PublicEvidenceReader {
  constructor(private readonly gateway:string) {}
  async readJSON(uri:string,expectedHash:string) {
    if(!/^ipfs:\/\/b[a-z2-7]{20,}$/.test(uri))throw new Error('INVALID_IPFS_CID');
    const response=await fetch(gatewayURL(this.gateway,uri.slice(7)),{signal:AbortSignal.timeout(15_000)});
    if(!response.ok)throw new Error('EVIDENCE_STORAGE_UNAVAILABLE');
    const text=await response.text();
    if(Buffer.byteLength(text,'utf8')>65536)throw new Error('EVIDENCE_TOO_LARGE');
    return validateJSON(text,expectedHash);
  }
}

export class EvidenceStorage {
  readonly options:EvidenceStorageOptions;
  constructor(api:string,authorization?:string);
  constructor(options:EvidenceStorageOptions);
  constructor(apiOrOptions:string|EvidenceStorageOptions,authorization?:string) {
    this.options=typeof apiOrOptions==='string'?{provider:'kubo',api:apiOrOptions,authorization}:apiOrOptions;
  }
  private gatewayURL(value:string) {
    return gatewayURL(this.options.provider==='pinata'?this.options.gateway:'http://invalid.local',value);
  }
  private async text(uri:string) {
    if(!/^ipfs:\/\/b[a-z2-7]{20,}$/.test(uri))throw new Error('INVALID_IPFS_CID');
    const value=uri.slice(7);
    const request:{url:URL;init:RequestInit}=this.options.provider==='kubo'?(()=>{const url=new URL('/api/v0/cat',this.options.api);url.searchParams.set('arg',value);return {url,init:{method:'POST',headers:this.options.authorization?{authorization:this.options.authorization}:undefined,signal:AbortSignal.timeout(15000)}};})():{url:this.gatewayURL(value),init:{method:'GET',signal:AbortSignal.timeout(15000)}};
    const response=await fetch(request.url,request.init);
    if(!response.ok||!response.body)throw new Error('EVIDENCE_STORAGE_UNAVAILABLE');
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;
    try {while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>65536)throw new Error('EVIDENCE_TOO_LARGE');chunks.push(part.value);}}
    finally {await reader.cancel();reader.releaseLock();}
    return Buffer.concat(chunks).toString('utf8');
  }
  private validate(text:string,expectedHash:string) {
    return validateJSON(text,expectedHash);
  }
  async readJSON(uri:string,expectedHash:string) { return this.validate(await this.text(uri),expectedHash); }
  async health() {
    if(this.options.provider==='kubo') {
      const response=await fetch(new URL('/api/v0/version',this.options.api),{method:'POST',headers:this.options.authorization?{authorization:this.options.authorization}:{},signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('EVIDENCE_STORAGE_UNAVAILABLE');return;
    }
    const response=await fetch('https://api.pinata.cloud/data/testAuthentication',{headers:{authorization:`Bearer ${this.options.jwt}`},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('EVIDENCE_STORAGE_UNAVAILABLE');
  }
  async persist(bundle:unknown) {
    const text=canonicalJSON(bundle);const evidenceHash=hashText(text);let value:string;
    if(this.options.provider==='kubo') {
      const form=new FormData();form.append('file',new Blob([text],{type:'application/json'}),'evidence.json');
      const url=new URL('/api/v0/add',this.options.api);url.search='pin=true&cid-version=1&raw-leaves=true';
      const response=await fetch(url,{method:'POST',body:form,headers:this.options.authorization?{authorization:this.options.authorization}:{},signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error('EVIDENCE_STORAGE_UNAVAILABLE');value=(await response.json() as {Hash?:string}).Hash??'';
    } else {
      const form=new FormData();form.append('network','public');form.append('file',new Blob([text],{type:'application/json'}),'xyx-evidence.json');
      const response=await fetch('https://uploads.pinata.cloud/v3/files',{method:'POST',body:form,headers:{authorization:`Bearer ${this.options.jwt}`},signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error('EVIDENCE_STORAGE_UNAVAILABLE');value=(await response.json() as {data?:{cid?:string}}).data?.cid??'';
    }
    if(!cid.test(value))throw new Error('INVALID_IPFS_CID');
    const evidenceURI='ipfs://'+value;const readback=await this.text(evidenceURI);const parsed=this.validate(readback,evidenceHash);
    if(readback!==text)throw new Error('EVIDENCE_PERSISTENCE_MISMATCH');
    return {evidenceHash,evidenceURI,evidenceURIHash:hashText(evidenceURI),readback:{parsed:true,byteMatch:true,hashMatches:true,semanticContentMatches:canonicalJSON(parsed)===text}};
  }
}
