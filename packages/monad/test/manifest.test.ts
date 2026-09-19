import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import { hashJSON } from '../src/canonical.js';
import { publicManifestSchema } from '../src/manifest.js';
import type { PayoutSpec } from '../src/payout.js';

const commerce='0x0000000000000000000000000000000000000001' as Address;
const evaluator='0x0000000000000000000000000000000000000002' as Address;
const token='0x0000000000000000000000000000000000000003' as Address;
const provider='0x0000000000000000000000000000000000000004' as Address;
const buyer='0x0000000000000000000000000000000000000005' as Address;
const recipient='0x0000000000000000000000000000000000000006' as Address;
const hash=`0x${'a'.repeat(64)}` as Hex;
const spec:PayoutSpec={kind:'xyx.payout.v1',chainId:10143,commerce,buyer,provider,token,recipient,amountAtomic:'10000',rewardAtomic:'20000',expiresAt:2_000_000_000};
const run={name:'good',spec,specURI:`ipfs://b${'a'.repeat(40)}`,specHash:hashJSON(spec),jobId:'1',transactions:{create:hash,fund:hash,transfer:hash,submit:hash,verdict:hash},decision:'COMPLETE',reasonHash:hash,evidenceURI:`ipfs://b${'b'.repeat(40)}`,evidenceHash:hash} as const;
const manifest={kind:'xyx.monad.public-manifest.v1',chainId:10143,commerce,evaluator,token,generatedAt:2_000_000_000,runs:[run]} as const;

test('public manifest binds every run to its committed Monad deployment',()=>{
  assert.equal(publicManifestSchema.parse(manifest).runs[0].jobId,'1');
});

test('public manifest rejects duplicate jobs, changed specs, and incomplete verdicts',()=>{
  assert.throws(()=>publicManifestSchema.parse({...manifest,runs:[run,{...run,name:'second'}]}),/DUPLICATE_JOB_ID/);
  assert.throws(()=>publicManifestSchema.parse({...manifest,runs:[{...run,spec:{...spec,recipient:buyer}}]}),/SPEC_HASH_MISMATCH/);
  assert.throws(()=>publicManifestSchema.parse({...manifest,runs:[{...run,evidenceHash:undefined}]}),/INCOMPLETE_VERDICT_RUN/);
});

test('expiry run has no verdict but must carry a refund receipt',()=>{
  const expiry={...run,name:'expired',jobId:'2',transactions:{create:hash,fund:hash,refund:hash},decision:undefined,reasonHash:undefined,evidenceURI:undefined,evidenceHash:undefined};
  assert.equal(publicManifestSchema.parse({...manifest,runs:[expiry]}).runs[0].name,'expired');
  assert.throws(()=>publicManifestSchema.parse({...manifest,runs:[{...expiry,transactions:{create:hash,fund:hash}}]}),/INCOMPLETE_EXPIRY_RUN/);
});
