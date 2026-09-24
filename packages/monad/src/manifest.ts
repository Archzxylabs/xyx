import { z } from 'zod';
import { hashJSON } from './canonical';
import { MONAD_TESTNET_CHAIN_ID, ZERO_ADDRESS, isNonZeroAddress } from './config';
import { payoutSpecSchema } from './payout';

const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const cid=z.string().regex(/^ipfs:\/\/b[a-z2-7]{20,}$/);
const jobId=z.string().regex(/^[1-9][0-9]*$/);
const runName=z.string().regex(/^[a-z0-9_-]{1,50}$/);

// ===========================================================================
// Legacy manifest schema (AgenticCommerce / XYXEvaluator flow)
// ===========================================================================

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

// ===========================================================================
// Canonical manifest schema (XYXDeliveryProtocol flow)
// ===========================================================================

const ZERO_HASH = '0x' + '0'.repeat(64);

/**
 * Field set shared by the COMPLETE and REJECT canonical verdict runs.
 *
 * `outcome` and `decision` are bound to the same literal so a record can never
 * claim one outcome and carry the opposite decision.
 */
function canonicalVerdictFields<Outcome extends 'COMPLETE' | 'REJECT'>(outcome: Outcome) {
  return {
    name: runName,
    outcome: z.literal(outcome),
    protocol: address,
    token: address,
    jobId: jobId,
    termsCommitment: hash,
    deliveryCommitment: hash,
    evidenceCommitment: hash,
    reasonCommitment: hash,
    decision: z.literal(outcome),
    issuedAt: z.string().regex(/^[1-9][0-9]*$/),
    expiresAt: z.string().regex(/^[1-9][0-9]*$/),
    nonce: z.string().regex(/^[0-9]+$/),
    resolveTx: hash,
  };
}

/**
 * Canonical COMPLETE run — carries a full verdict with commitments,
 * decision, timestamps, nonce, and the resolve transaction.
 */
const canonicalCompleteRunSchema = z.object(canonicalVerdictFields('COMPLETE')).strict();

/**
 * Canonical REJECT run — same canonical verdict fields and resolveTx as COMPLETE,
 * with the decision bound to REJECT.
 */
const canonicalRejectRunSchema = z.object(canonicalVerdictFields('REJECT')).strict();

/**
 * Cross-field verdict checks shared by COMPLETE and REJECT runs.
 *
 * These cannot live on the variants themselves: `z.discriminatedUnion` only
 * accepts plain `ZodObject` variants, so a `.superRefine()` variant would turn
 * the union into an unusable `ZodEffects`. The manifest applies these after the
 * discriminated union has narrowed the record.
 */
function checkCanonicalVerdictRun(run: CanonicalCompleteRun | CanonicalRejectRun, context: z.RefinementCtx): void {
  if (BigInt(run.expiresAt) <= BigInt(run.issuedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CANONICAL_VERDICT_TIMESTAMP_MISMATCH' });
  }
  if (run.termsCommitment === ZERO_HASH) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CANONICAL_TERMS_COMMITMENT_ZERO' });
  }
  if (run.deliveryCommitment === ZERO_HASH) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CANONICAL_DELIVERY_COMMITMENT_ZERO' });
  }
  if (run.evidenceCommitment === ZERO_HASH) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CANONICAL_EVIDENCE_COMMITMENT_ZERO' });
  }
  if (run.reasonCommitment === ZERO_HASH) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CANONICAL_REASON_COMMITMENT_ZERO' });
  }
}

/**
 * Canonical EXPIRED run — carries only the refund transaction.
 * No verdict, decision, nonce, resolveTx, evidence, or reason commitment.
 */
const canonicalExpiryRunSchema = z.object({
  name: runName,
  outcome: z.literal('EXPIRED'),
  protocol: address,
  token: address,
  jobId: jobId,
  refundTx: hash,
}).strict();

/**
 * Canonical run discriminated union.
 *
 * The discriminator is `outcome` and every variant declares it as a literal, so
 * TypeScript narrows `CanonicalRun` to the exact variant from `run.outcome`
 * alone. COMPLETE/REJECT carry the full verdict; EXPIRED carries only refundTx
 * and is structurally barred from every verdict-only field.
 */
export const canonicalRunSchema = z.discriminatedUnion('outcome', [
  canonicalCompleteRunSchema,
  canonicalRejectRunSchema,
  canonicalExpiryRunSchema,
]);
export type CanonicalRun = z.infer<typeof canonicalRunSchema>;
export type CanonicalCompleteRun = z.infer<typeof canonicalCompleteRunSchema>;
export type CanonicalRejectRun = z.infer<typeof canonicalRejectRunSchema>;
export type CanonicalExpiryRun = z.infer<typeof canonicalExpiryRunSchema>;
export { canonicalCompleteRunSchema, canonicalRejectRunSchema, canonicalExpiryRunSchema };

/**
 * Canonical manifest schema for XYXDeliveryProtocol settlement evidence.
 *
 * Rejects the zero address for protocol and token at both manifest and run boundary.
 * Retains duplicate job/name guards.
 * Rejects runs whose protocol or token differs from the manifest.
 */
export const canonicalManifestSchema = z.object({
  kind: z.literal('xyx.monad.canonical-manifest.v1'),
  chainId: z.literal(MONAD_TESTNET_CHAIN_ID),
  protocol: address,
  token: address,
  generatedAt: z.number().int().positive(),
  runs: z.array(canonicalRunSchema).min(1).max(20),
}).strict().superRefine((manifest, context) => {
  // Reject zero protocol and zero token at manifest level.
  if (!isNonZeroAddress(manifest.protocol)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CANONICAL_PROTOCOL_ZERO' });
  }
  if (!isNonZeroAddress(manifest.token)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CANONICAL_TOKEN_ZERO' });
  }

  const names = new Set<string>();
  const jobs = new Set<string>();
  for (const run of manifest.runs) {
    if (names.has(run.name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'DUPLICATE_RUN_NAME' });
    }
    if (jobs.has(run.jobId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'DUPLICATE_JOB_ID' });
    }
    names.add(run.name);
    jobs.add(run.jobId);

    // Reject zero protocol and zero token at run level.
    if (!isNonZeroAddress(run.protocol)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'CANONICAL_PROTOCOL_ZERO' });
    }
    if (!isNonZeroAddress(run.token)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'CANONICAL_TOKEN_ZERO' });
    }

    // Reject runs whose protocol or token differs from the manifest.
    if (run.protocol.toLowerCase() !== manifest.protocol.toLowerCase()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'RUN_PROTOCOL_MISMATCH' });
    }
    if (run.token.toLowerCase() !== manifest.token.toLowerCase()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'RUN_TOKEN_MISMATCH' });
    }

    // Cross-field verdict checks (COMPLETE / REJECT only).
    if (run.outcome !== 'EXPIRED') {
      checkCanonicalVerdictRun(run, context);
    }
  }
});
export type CanonicalManifest = z.infer<typeof canonicalManifestSchema>;
