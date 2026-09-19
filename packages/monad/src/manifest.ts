import { z } from 'zod';
import { hashJSON } from './canonical';
import { MONAD_TESTNET_CHAIN_ID, payoutSpecSchema } from './payout';

const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const cid=z.string().regex(/^ipfs:\/\/b[a-z2-7]{20,}$/);
const jobId=z.string().regex(/^[1-9][0-9]*$/);
const runName=z.string().regex(/^[a-z0-9_-]{1,50}$/);

export const publicRunSchema=z.object({
  name:runName,
  spec:payoutSpecSchema,
  specURI:cid,
  specHash:hash,
  jobId,
  transactions:z.object({create:hash,fund:hash,transfer:hash.optional(),submit:hash.optional(),verdict:hash.optional(),refund:hash.optional()}).strict(),
  decision:z.enum(['COMPLETE','REJECT']).optional(),
  reasonHash:hash.optional(),
  evidenceURI:cid.optional(),
  evidenceHash:hash.optional(),
}).strict().superRefine((run,context)=>{
  if(run.specHash.toLowerCase()!==hashJSON(run.spec).toLowerCase())context.addIssue({code:z.ZodIssueCode.custom,message:'SPEC_HASH_MISMATCH'});
  if(run.decision && (!run.reasonHash || !run.evidenceURI || !run.evidenceHash || !run.transactions.transfer || !run.transactions.submit || !run.transactions.verdict))context.addIssue({code:z.ZodIssueCode.custom,message:'INCOMPLETE_VERDICT_RUN'});
  if(!run.decision && !run.transactions.refund)context.addIssue({code:z.ZodIssueCode.custom,message:'INCOMPLETE_EXPIRY_RUN'});
});
export type PublicRun=z.infer<typeof publicRunSchema>;

export const publicManifestSchema=z.object({
  kind:z.literal('xyx.monad.public-manifest.v1'),
  chainId:z.literal(MONAD_TESTNET_CHAIN_ID),
  commerce:address,
  evaluator:address,
  token:address,
  generatedAt:z.number().int().positive(),
  runs:z.array(publicRunSchema).min(1).max(20),
}).strict().superRefine((manifest,context)=>{
  const names=new Set<string>();const jobs=new Set<string>();
  for(const run of manifest.runs){
    if(names.has(run.name))context.addIssue({code:z.ZodIssueCode.custom,message:'DUPLICATE_RUN_NAME'});
    if(jobs.has(run.jobId))context.addIssue({code:z.ZodIssueCode.custom,message:'DUPLICATE_JOB_ID'});
    names.add(run.name);jobs.add(run.jobId);
    if(run.spec.commerce.toLowerCase()!==manifest.commerce.toLowerCase() || run.spec.token.toLowerCase()!==manifest.token.toLowerCase())context.addIssue({code:z.ZodIssueCode.custom,message:'RUN_DEPLOYMENT_MISMATCH'});
  }
});
export type PublicManifest=z.infer<typeof publicManifestSchema>;
