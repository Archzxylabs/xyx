/** Explicit user-exported private terms handoff. Never persisted by the app or sent to a server. */

import { isAddress, type Address, type Hex } from 'viem';
import { privateTermsSchema, privateDeliverySchema, createTermsCommitment, createDeliveryCommitment, type PrivateTermsInput, type PrivateDeliveryInput } from '../../../packages/monad/src/delivery';
import { validateSalt } from '../../../packages/monad/src/commitments';

export interface PrivateTermsBundle {
  schema: 'xyx.private-terms-bundle.v1';
  terms: PrivateTermsInput;
  salt: Hex;
  commitment: Hex;
  jobId?: string;
  fundingTx?: Hex;
}

export interface PrivateDeliveryBundle {
  schema: 'xyx.private-delivery-bundle.v1';
  jobId: string;
  delivery: PrivateDeliveryInput;
  salt: Hex;
  commitment: Hex;
  transferTx: Hex;
  submissionTx?: Hex;
}

export function taskTransferFromTerms(terms: PrivateTermsInput): { recipient: Address; amountAtomic: bigint } {
  const recipient = terms.task.recipient;
  const amount = terms.task.amountAtomic;
  if (typeof recipient !== 'string' || !isAddress(recipient) || /^0x0{40}$/i.test(recipient)) {
    throw new Error('TASK_RECIPIENT_REQUIRED');
  }
  if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount)) throw new Error('TASK_AMOUNT_REQUIRED');
  return { recipient, amountAtomic: BigInt(amount) };
}

export function makePrivateTermsBundle(terms: PrivateTermsInput, salt: Hex, observed?: { jobId: bigint; fundingTx: Hex }): PrivateTermsBundle {
  const parsed = privateTermsSchema.parse(terms);
  validateSalt(salt, 32);
  taskTransferFromTerms(parsed);
  const { commitment } = createTermsCommitment(parsed, salt);
  if (observed && (observed.jobId <= 0n || !/^0x[0-9a-fA-F]{64}$/.test(observed.fundingTx))) throw new Error('PRIVATE_TERMS_BUNDLE_OBSERVATION_INVALID');
  return { schema: 'xyx.private-terms-bundle.v1', terms: parsed, salt, commitment,
    ...(observed ? { jobId: observed.jobId.toString(), fundingTx: observed.fundingTx } : {}) };
}

export function parsePrivateTermsBundle(text: string): PrivateTermsBundle {
  if (text.length > 65_536) throw new Error('PRIVATE_TERMS_BUNDLE_TOO_LARGE');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('PRIVATE_TERMS_BUNDLE_INVALID_JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PRIVATE_TERMS_BUNDLE_INVALID');
  const value = raw as Record<string, unknown>;
  if (value.schema !== 'xyx.private-terms-bundle.v1' || typeof value.salt !== 'string' || typeof value.commitment !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.commitment) ||
      Object.keys(value).some(key => !['schema', 'terms', 'salt', 'commitment', 'jobId', 'fundingTx'].includes(key)) ||
      (value.jobId === undefined) !== (value.fundingTx === undefined)) {
    throw new Error('PRIVATE_TERMS_BUNDLE_INVALID');
  }
  const observed = value.jobId === undefined ? undefined : {
    jobId: (() => { if (typeof value.jobId !== 'string' || !/^[1-9]\d*$/.test(value.jobId)) throw new Error('PRIVATE_TERMS_BUNDLE_JOB_ID_INVALID'); return BigInt(value.jobId); })(),
    fundingTx: value.fundingTx as Hex,
  };
  const bundle = makePrivateTermsBundle(value.terms as PrivateTermsInput, value.salt as Hex, observed);
  if (bundle.commitment.toLowerCase() !== value.commitment.toLowerCase()) throw new Error('PRIVATE_TERMS_BUNDLE_COMMITMENT_MISMATCH');
  return bundle;
}

export function parsePrivateDeliveryBundle(text: string): PrivateDeliveryBundle {
  if (text.length > 65_536) throw new Error('PRIVATE_DELIVERY_BUNDLE_TOO_LARGE');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('PRIVATE_DELIVERY_BUNDLE_INVALID_JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PRIVATE_DELIVERY_BUNDLE_INVALID');
  const value = raw as Record<string, unknown>;
  if (value.schema !== 'xyx.private-delivery-bundle.v1' || typeof value.jobId !== 'string' || !/^[1-9]\d*$/.test(value.jobId) ||
      typeof value.salt !== 'string' || typeof value.commitment !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.commitment) ||
      typeof value.transferTx !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.transferTx) ||
      Object.keys(value).some(key => !['schema', 'jobId', 'delivery', 'salt', 'commitment', 'transferTx', 'submissionTx'].includes(key)) ||
      (value.submissionTx !== undefined && (typeof value.submissionTx !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.submissionTx)))) {
    throw new Error('PRIVATE_DELIVERY_BUNDLE_INVALID');
  }
  const delivery = privateDeliverySchema.parse(value.delivery);
  validateSalt(value.salt as Hex, 32);
  if (delivery.content.transferTx !== value.transferTx) throw new Error('DELIVERY_TRANSFER_HASH_MISMATCH');
  const commitment = createDeliveryCommitment(BigInt(value.jobId), delivery, value.salt as Hex).commitment;
  if (commitment.toLowerCase() !== value.commitment.toLowerCase()) throw new Error('PRIVATE_DELIVERY_BUNDLE_COMMITMENT_MISMATCH');
  return { schema: 'xyx.private-delivery-bundle.v1', jobId: value.jobId,
    delivery, salt: value.salt as Hex, commitment, transferTx: value.transferTx as Hex,
    ...(value.submissionTx ? { submissionTx: value.submissionTx as Hex } : {}) };
}

export function downloadPrivateBundle(filename: string, content: unknown): void {
  if (typeof window === 'undefined') throw new Error('BROWSER_REQUIRED');
  const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Defer revocation until the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
