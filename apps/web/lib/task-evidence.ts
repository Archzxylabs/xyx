/** Evidence-grade review of buyer funding, provider task transfer, and delivery submission. */

import { decodeEventLog, type Hex } from 'viem';
import { createMonadClient } from '../../../packages/monad/src/delivery-chain';
import { matchedCanonicalJob, matchedFinalizedReceipt, viemPublicClientToCanonicalChainReader } from '../../../packages/monad/src/canonical-chain';
import { encodeErc20Transfer, tokenTransfers } from '../../../packages/monad/src/chain-primitives';
import { deliveryProtocolAbi, type JobData } from '../../../packages/monad/src/protocol';
import type { XYXConfig } from '../../../packages/monad/src/config';
import { taskTransferFromTerms, type PrivateDeliveryBundle, type PrivateTermsBundle } from './private-terms-bundle';

export interface TaskEvidence {
  job: JobData;
  jobId: bigint;
  matchesTerms: boolean;
  failureCode: string | null;
  fundingTx: Hex;
  transferTx: Hex;
  submissionTx: Hex;
  fundingBlock: bigint;
  transferBlock: bigint;
  submissionBlock: bigint;
  observedTransferTo: string | null;
  observedTransferAmount: string | null;
}

export async function reviewTaskEvidence(
  config: XYXConfig,
  id: bigint,
  terms: PrivateTermsBundle,
  delivery: PrivateDeliveryBundle,
): Promise<TaskEvidence> {
  if (!config.secondaryRpcUrl || !config.paymentTokenAddress) throw new Error('CONFIG_REQUIRED');
  if (terms.jobId !== id.toString() || delivery.jobId !== id.toString() || !terms.fundingTx || !delivery.submissionTx) {
    throw new Error('COMPLETE_RECEIPT_BUNDLES_REQUIRED');
  }
  const primary = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
  const secondary = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
  const [observed, funding, transfer, submission] = await Promise.all([
    matchedCanonicalJob(primary, secondary, config.protocolAddress, id),
    matchedFinalizedReceipt(primary, secondary, terms.fundingTx),
    matchedFinalizedReceipt(primary, secondary, delivery.transferTx),
    matchedFinalizedReceipt(primary, secondary, delivery.submissionTx),
  ]);
  const job = observed.job;
  if (job.status !== 3 || observed.observation.number < submission.receipt.blockNumber ||
      job.buyer.toLowerCase() !== terms.terms.buyer.toLowerCase() ||
      job.provider.toLowerCase() !== terms.terms.provider.toLowerCase() ||
      job.attestor.toLowerCase() !== terms.terms.attestor.toLowerCase() ||
      job.termsCommitment.toLowerCase() !== terms.commitment.toLowerCase() ||
      job.deliveryCommitment.toLowerCase() !== delivery.commitment.toLowerCase() ||
      job.budget !== BigInt(terms.terms.budgetAtomic) || job.expiresAt !== BigInt(terms.terms.expiresAt) ||
      config.protocolAddress.toLowerCase() !== terms.terms.protocol.toLowerCase() ||
      config.paymentTokenAddress.toLowerCase() !== terms.terms.paymentToken.toLowerCase()) {
    throw new Error('PRIVATE_BUNDLES_DO_NOT_MATCH_FINALIZED_JOB');
  }
  if (funding.receipt.status !== 'success' || submission.receipt.status !== 'success' ||
      funding.receipt.to?.toLowerCase() !== config.protocolAddress.toLowerCase() ||
      submission.receipt.to?.toLowerCase() !== config.protocolAddress.toLowerCase()) throw new Error('PROTOCOL_RECEIPT_INVALID');
  const protocolEvent = (receipt: typeof funding.receipt, eventName: 'JobFunded' | 'DeliverySubmitted') =>
    receipt.logs.flatMap(log => {
      if (log.address.toLowerCase() !== config.protocolAddress.toLowerCase()) return [];
      try {
        const decoded = decodeEventLog({ abi: deliveryProtocolAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
        return decoded.eventName === eventName ? [decoded.args] : [];
      } catch { return []; }
    });
  const funded = protocolEvent(funding.receipt, 'JobFunded');
  const submitted = protocolEvent(submission.receipt, 'DeliverySubmitted');
  const escrowTransfers = tokenTransfers(funding.receipt.logs, config.paymentTokenAddress);
  if (funded.length !== 1 || !('buyer' in funded[0]) || funded[0].jobId !== id || funded[0].buyer.toLowerCase() !== job.buyer.toLowerCase() ||
      funded[0].budget !== job.budget || submitted.length !== 1 || !('provider' in submitted[0]) || submitted[0].jobId !== id ||
      submitted[0].provider.toLowerCase() !== job.provider.toLowerCase() ||
      submitted[0].deliveryCommitment.toLowerCase() !== job.deliveryCommitment.toLowerCase() ||
      escrowTransfers.length !== 1 || escrowTransfers[0].from.toLowerCase() !== job.buyer.toLowerCase() ||
      escrowTransfers[0].to.toLowerCase() !== config.protocolAddress.toLowerCase() ||
      BigInt(escrowTransfers[0].value) !== job.budget) throw new Error('PROTOCOL_EVENT_OR_FUNDING_TRANSFER_INVALID');
  const [txA, txB] = await Promise.all([
    primary.getTransaction({ hash: delivery.transferTx }), secondary.getTransaction({ hash: delivery.transferTx }),
  ]);
  if (txA.hash !== txB.hash || txA.from.toLowerCase() !== txB.from.toLowerCase() ||
      txA.to?.toLowerCase() !== txB.to?.toLowerCase() || txA.input !== txB.input ||
      txA.blockNumber !== txB.blockNumber || txA.blockHash !== txB.blockHash ||
      txA.blockNumber !== transfer.receipt.blockNumber || txA.blockHash !== transfer.receipt.blockHash) {
    throw new Error('RPC_TASK_TRANSACTION_MISMATCH');
  }
  const { recipient, amountAtomic } = taskTransferFromTerms(terms.terms);
  const logs = tokenTransfers(transfer.receipt.logs, config.paymentTokenAddress);
  const log = logs.length === 1 ? logs[0] : null;
  const [fundBlockA, fundBlockB, transferBlockA, transferBlockB, submitBlockA, submitBlockB] = await Promise.all([
    primary.getBlock({ blockNumber: funding.receipt.blockNumber }), secondary.getBlock({ blockNumber: funding.receipt.blockNumber }),
    primary.getBlock({ blockNumber: transfer.receipt.blockNumber }), secondary.getBlock({ blockNumber: transfer.receipt.blockNumber }),
    primary.getBlock({ blockNumber: submission.receipt.blockNumber }), secondary.getBlock({ blockNumber: submission.receipt.blockNumber }),
  ]);
  if (!fundBlockA.hash || fundBlockA.hash !== fundBlockB.hash || fundBlockA.timestamp !== fundBlockB.timestamp ||
      !transferBlockA.hash || transferBlockA.hash !== transferBlockB.hash || transferBlockA.timestamp !== transferBlockB.timestamp ||
      !submitBlockA.hash || submitBlockA.hash !== submitBlockB.hash || submitBlockA.timestamp !== submitBlockB.timestamp) {
    throw new Error('RPC_EVIDENCE_BLOCK_MISMATCH');
  }
  const ordered = funding.receipt.blockNumber < transfer.receipt.blockNumber &&
    transfer.receipt.blockNumber < submission.receipt.blockNumber &&
    transferBlockA.timestamp < job.expiresAt && submitBlockA.timestamp < job.expiresAt;
  const exactTransfer = transfer.receipt.status === 'success' &&
    txA.from.toLowerCase() === job.provider.toLowerCase() &&
    txA.to?.toLowerCase() === config.paymentTokenAddress.toLowerCase() &&
    txA.input.toLowerCase() === encodeErc20Transfer(recipient, amountAtomic).toLowerCase() &&
    log?.from.toLowerCase() === job.provider.toLowerCase() &&
    log.to.toLowerCase() === recipient.toLowerCase() && BigInt(log.value) === amountAtomic;
  const matchesTerms = ordered && exactTransfer;
  return {
    job, jobId: id, matchesTerms,
    failureCode: matchesTerms ? null : !ordered ? 'TASK_TRANSFER_ORDER_OR_EXPIRY_MISMATCH' : 'TASK_TRANSFER_DETAILS_MISMATCH',
    fundingTx: terms.fundingTx, transferTx: delivery.transferTx, submissionTx: delivery.submissionTx,
    fundingBlock: funding.receipt.blockNumber, transferBlock: transfer.receipt.blockNumber,
    submissionBlock: submission.receipt.blockNumber,
    observedTransferTo: log?.to ?? txA.to, observedTransferAmount: log?.value ?? null,
  };
}
