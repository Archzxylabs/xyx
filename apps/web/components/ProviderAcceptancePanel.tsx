/**
 * ProviderAcceptancePanel
 *
 * Reads job by ID, shows buyer, selected attestor, public terms commitment,
 * budget, expiry, status. Provider must explicitly accept before buyer can fund.
 * Only confirmed Funded state enables delivery commitment submission.
 *
 * Raw delivery and salt stay in memory; only commitment is displayed/sent.
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import {
  createDeliveryCommitment,
  privateDeliverySchema,
  type PrivateDeliveryInput,
} from '../../../packages/monad/src/delivery';
import {
  buildAcceptRequest,
  buildSubmitRequest,
  type ContractAddresses,
} from '../../../packages/monad/src/delivery-chain';
import {
  generateSalt,
  validateSalt,
} from '../../../packages/monad/src/commitments';
import { StatusBadge, SectionCard, FieldPreview, DisabledNotice, ErrorSummary, ExplorerLink } from '../components/StatusBadge';
import type { StatusState } from '../components/StatusBadge';
import { useConfig } from '../hooks/useConfig';
import { useTx } from '../hooks/useTx';
import { createMonadClient } from '../../../packages/monad/src/delivery-chain';
import { matchedCanonicalJob, matchedFinalizedReceipt, viemPublicClientToCanonicalChainReader } from '../../../packages/monad/src/canonical-chain';
import type { JobData } from '../../../packages/monad/src/protocol';
import { deliveryProtocolAbi } from '../../../packages/monad/src/protocol';
import { tokenTransfers } from '../../../packages/monad/src/chain-primitives';
import { executeBrowserTransaction } from '../lib/browser-transaction';
import { decodeEventLog, type Address, type Hex } from 'viem';
import { downloadPrivateBundle, parsePrivateTermsBundle, taskTransferFromTerms, type PrivateTermsBundle, type PrivateDeliveryBundle } from '../lib/private-terms-bundle';
import { createSecureHandoff, readSecureHandoff } from '../lib/secure-handoff';

const transferAbi = [{ type: 'event', name: 'Transfer', inputs: [
  { name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true },
  { name: 'value', type: 'uint256', indexed: false },
] }, { type: 'function', name: 'transfer', inputs: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' }] as const;

export default function ProviderAcceptancePanel() {
  const { config, isReady } = useConfig();
  const tx = useTx();

  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<JobData | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  // Delivery commitment
  const [deliveryKind, setDeliveryKind] = useState('response');
  const [deliveryContent, setDeliveryContent] = useState('');
  const [deliveryCommitment, setDeliveryCommitment] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [termsBundle, setTermsBundle] = useState<PrivateTermsBundle | null>(null);
  const [transferHash, setTransferHash] = useState<Hex | null>(null);
  const [deliveryBundle, setDeliveryBundle] = useState<PrivateDeliveryBundle | null>(null);
  const [exportedDeliveryCommitment, setExportedDeliveryCommitment] = useState<string | null>(null);
  const [termsHandoffLink, setTermsHandoffLink] = useState('');
  const [deliveryHandoffLink, setDeliveryHandoffLink] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);

  const canAccept = useMemo(() => {
    if (!isReady() || !config) return false;
    if (!job) return false;
    return job.status === 0; // Proposed
  }, [isReady, config, job]);

  const canSubmit = useMemo(() => {
    if (!isReady() || !config) return false;
    if (!job) return false;
    // Must be Funded and have delivery commitment ready
    return job.status === 2 && deliveryCommitment !== null && transferHash !== null && termsBundle !== null &&
      exportedDeliveryCommitment === deliveryCommitment;
  }, [isReady, config, job, deliveryCommitment, transferHash, termsBundle, exportedDeliveryCommitment]);

  const loadJob = useCallback(async () => {
    if (!config || !isReady()) return;
    setLoading(true);
    setReadError(null);
    try {
      if (!config.secondaryRpcUrl || !/^[1-9]\d*$/.test(jobId)) throw new Error('JOB_ID_INVALID');
      const primary = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
      const secondary = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
      const { job: data } = await matchedCanonicalJob(primary, secondary, config.protocolAddress, BigInt(jobId));
      setJob(data);
      setDeliveryCommitment(null);
      setDeliveryBundle(null);
      setExportedDeliveryCommitment(null);
      setTransferHash(null);
      setTermsBundle(null);
    } catch (e) {
      setReadError(e instanceof Error ? e.message : 'Failed to read job');
      setJob(null);
    } finally {
      setLoading(false);
    }
  }, [config, isReady, jobId]);

  const importTermsBundle = useCallback(async (source: File | string | undefined) => {
    if (!source || !job || !config || !/^[1-9]\d*$/.test(jobId)) return;
    setDeliveryError(null);
    try {
      const raw = typeof source === 'string' ? await readSecureHandoff(source, 'terms') : JSON.parse(await source.text());
      const bundle = parsePrivateTermsBundle(JSON.stringify(raw));
      if (bundle.commitment.toLowerCase() !== job.termsCommitment.toLowerCase() ||
          bundle.terms.provider.toLowerCase() !== job.provider.toLowerCase() ||
          bundle.terms.buyer.toLowerCase() !== job.buyer.toLowerCase() ||
          bundle.terms.attestor.toLowerCase() !== job.attestor.toLowerCase() ||
          bundle.terms.protocol.toLowerCase() !== config.protocolAddress.toLowerCase() ||
          bundle.terms.paymentToken.toLowerCase() !== config.paymentTokenAddress?.toLowerCase() ||
          BigInt(bundle.terms.budgetAtomic) !== job.budget || BigInt(bundle.terms.expiresAt) !== job.expiresAt) {
        throw new Error('PRIVATE_TERMS_DO_NOT_MATCH_FINALIZED_JOB');
      }
      taskTransferFromTerms(bundle.terms);
      if (!bundle.fundingTx || bundle.jobId !== jobId || !config.secondaryRpcUrl || !config.paymentTokenAddress) {
        throw new Error('FINALIZED_FUNDING_BUNDLE_REQUIRED');
      }
      const primary = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
      const secondary = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
      const [funding, observed] = await Promise.all([
        matchedFinalizedReceipt(primary, secondary, bundle.fundingTx),
        matchedCanonicalJob(primary, secondary, config.protocolAddress, BigInt(jobId)),
      ]);
      if (funding.receipt.status !== 'success' || funding.receipt.to?.toLowerCase() !== config.protocolAddress.toLowerCase() ||
          observed.observation.number < funding.receipt.blockNumber || observed.job.status !== 2) {
        throw new Error('FUNDING_RECEIPT_MISMATCH');
      }
      const fundedEvents = funding.receipt.logs.flatMap(log => {
        if (log.address.toLowerCase() !== config.protocolAddress.toLowerCase()) return [];
        try {
          const event = decodeEventLog({ abi: deliveryProtocolAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
          return event.eventName === 'JobFunded' ? [event.args] : [];
        } catch { return []; }
      });
      const transfers = tokenTransfers(funding.receipt.logs, config.paymentTokenAddress);
      if (fundedEvents.length !== 1 || fundedEvents[0].jobId !== BigInt(jobId) ||
          fundedEvents[0].buyer.toLowerCase() !== job.buyer.toLowerCase() || fundedEvents[0].budget !== job.budget ||
          transfers.length !== 1 || transfers[0].from.toLowerCase() !== job.buyer.toLowerCase() ||
          transfers[0].to.toLowerCase() !== config.protocolAddress.toLowerCase() || BigInt(transfers[0].value) !== job.budget) {
        throw new Error('FUNDING_EVENT_OR_TRANSFER_MISMATCH');
      }
      setTermsBundle(bundle);
    } catch (error) {
      setTermsBundle(null);
      setDeliveryError(error instanceof Error ? error.message : 'PRIVATE_TERMS_IMPORT_FAILED');
    }
  }, [job, config, jobId]);

  const createDeliveryHandoff = useCallback(async () => {
    if (!deliveryBundle) return;
    setHandoffBusy(true); setDeliveryError(null);
    try {
      const link = await createSecureHandoff('delivery', deliveryBundle);
      setDeliveryHandoffLink(link);
      setExportedDeliveryCommitment(deliveryBundle.commitment);
    } catch (error) {
      setDeliveryHandoffLink(null);
      setDeliveryError(error instanceof Error ? error.message : 'HANDOFF_WRITE_FAILED');
    } finally { setHandoffBusy(false); }
  }, [deliveryBundle]);

  const handleTaskTransfer = useCallback(async () => {
    if (!config?.paymentTokenAddress || !job || !termsBundle || job.status !== 2 || !config.secondaryRpcUrl) return;
    tx.reset(); setDeliveryError(null);
    try {
      const { recipient, amountAtomic } = taskTransferFromTerms(termsBundle.terms);
      const primary = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
      const secondary = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
      const observed = await matchedCanonicalJob(primary, secondary, config.protocolAddress, BigInt(jobId));
      if (observed.job.status !== 2 || observed.job.termsCommitment.toLowerCase() !== termsBundle.commitment.toLowerCase()) {
        throw new Error('FUNDED_JOB_STATE_MISMATCH');
      }
      const request = { abi: transferAbi, address: config.paymentTokenAddress,
        functionName: 'transfer', args: [recipient, amountAtomic], from: job.provider as Address };
      const outcome = await executeBrowserTransaction(config, request, `task-transfer:${jobId}`, { onWalletPrompt: tx.toPrompt, onSubmitted: tx.toSubmitted });
      if (outcome.status === 'pending') return;
      if (outcome.status === 'reverted') { tx.toReverted('TASK_TRANSFER_REVERTED'); return; }
      if (outcome.receipt.blockNumber <= observed.observation.number) throw new Error('TASK_TRANSFER_NOT_AFTER_FUNDING_OBSERVATION');
      const transfers = outcome.receipt.logs.flatMap(log => {
        if (log.address.toLowerCase() !== config.paymentTokenAddress!.toLowerCase()) return [];
        try {
          const event = decodeEventLog({ abi: transferAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
          return event.eventName === 'Transfer' ? [event.args] : [];
        } catch { return []; }
      });
      if (transfers.length !== 1 || transfers[0].from.toLowerCase() !== job.provider.toLowerCase() ||
          transfers[0].to.toLowerCase() !== recipient.toLowerCase() || transfers[0].value !== amountAtomic) {
        throw new Error('TASK_TRANSFER_RECEIPT_MISMATCH');
      }
      setTransferHash(outcome.hash);
      tx.toFinalized({ blockNumber: outcome.receipt.blockNumber, status: 'success' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'TASK_TRANSFER_FAILED';
      if (code === 'USER_REJECTED') tx.toCancelled();
      else if (code.includes('MISMATCH') || code.startsWith('RPC_') || code.startsWith('OPERATION_') || code.startsWith('SUBMISSION_UNCERTAIN')) tx.toConflict(code);
      else tx.toFailed(code);
      setDeliveryError(code);
    }
  }, [config, job, termsBundle, jobId, tx]);

  const handleAccept = useCallback(async () => {
    if (!config || !isReady() || !job) return;
    try {
      const addresses: ContractAddresses = {
        protocol: config.protocolAddress,
        registry: config.registryAddress,
        p256Verifier: config.p256VerifierAddress,
        paymentToken: config.paymentTokenAddress,
      };
      const request = buildAcceptRequest({ jobId: BigInt(jobId), provider: job.provider }, addresses);
      tx.reset();
      const outcome = await executeBrowserTransaction(config, request, `accept:${jobId}`, {
        onWalletPrompt: tx.toPrompt,
        onSubmitted: tx.toSubmitted,
      });
      if (outcome.status === 'pending') return;
      if (outcome.status === 'reverted') { tx.toReverted('ACCEPT_REVERTED'); return; }
      if (!config.secondaryRpcUrl) throw new Error('SECONDARY_RPC_URL_MISSING');
      const primary = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
      const secondary = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
      const observed = await matchedCanonicalJob(primary, secondary, config.protocolAddress, BigInt(jobId));
      if (observed.observation.number < outcome.receipt.blockNumber || observed.job.status !== 1) {
        tx.toConflict('ACCEPT_STATE_NOT_FINALIZED'); return;
      }
      setJob(observed.job);
      tx.toFinalized({ blockNumber: outcome.receipt.blockNumber, status: 'success' });
    } catch (e) {
      const code = e instanceof Error ? e.message : 'ACCEPT_FAILED';
      if (code === 'USER_REJECTED') tx.toCancelled();
      else if (code.startsWith('RPC_') || code.startsWith('OPERATION_') || code.startsWith('SUBMISSION_UNCERTAIN')) tx.toConflict(code);
      else tx.toFailed(code);
    }
  }, [config, isReady, job, jobId, tx]);

  const computeDeliveryCommitment = useCallback(() => {
    setDeliveryError(null);
    try {
      if (!deliveryContent.trim()) throw new Error('DELIVERY_CONTENT_REQUIRED');
      if (!transferHash || !termsBundle) throw new Error('VERIFIED_TASK_TRANSFER_REQUIRED');
      const { recipient, amountAtomic } = taskTransferFromTerms(termsBundle.terms);
      const delivery: PrivateDeliveryInput = {
        schema: 'xyx.private-delivery',
        kind: deliveryKind,
        content: { response: deliveryContent.trim(), transferTx: transferHash, recipient, amountAtomic: amountAtomic.toString() },
      };
      const schemaValid = privateDeliverySchema.parse(delivery);
      const salt = generateSalt(32);
      validateSalt(salt, 32);
      const result = createDeliveryCommitment(BigInt(jobId), schemaValid, salt);
      setDeliveryCommitment(result.commitment);
      setExportedDeliveryCommitment(null);
      setDeliveryBundle({ schema: 'xyx.private-delivery-bundle.v1', jobId,
        delivery: schemaValid, salt, commitment: result.commitment, transferTx: transferHash });
    } catch (e) {
      setDeliveryError(e instanceof Error ? e.message : 'Invalid delivery payload');
      setDeliveryCommitment(null);
      setDeliveryBundle(null);
      setExportedDeliveryCommitment(null);
    }
  }, [jobId, deliveryKind, deliveryContent, transferHash, termsBundle]);

  const handleSubmit = useCallback(async () => {
    if (!config || !isReady() || !job || !deliveryCommitment || !deliveryBundle || !transferHash || !termsBundle) return;
    try {
      const addresses: ContractAddresses = {
        protocol: config.protocolAddress,
        registry: config.registryAddress,
        p256Verifier: config.p256VerifierAddress,
        paymentToken: config.paymentTokenAddress!,
      };
      // Build submit request with evidence/reason commitments
      const request = buildSubmitRequest(
        {
          jobId: BigInt(jobId),
          deliveryCommitment: deliveryCommitment as `0x${string}`,
          provider: job.provider,
        },
        addresses
      );
      tx.reset();
      const outcome = await executeBrowserTransaction(config, request, `submit:${jobId}`, {
        onWalletPrompt: tx.toPrompt,
        onSubmitted: tx.toSubmitted,
      });
      if (outcome.status === 'pending') return;
      if (outcome.status === 'reverted') { tx.toReverted('DELIVERY_SUBMISSION_REVERTED'); return; }
      if (!config.secondaryRpcUrl) throw new Error('SECONDARY_RPC_URL_MISSING');
      const primary = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
      const secondary = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
      const observed = await matchedCanonicalJob(primary, secondary, config.protocolAddress, BigInt(jobId));
      if (observed.observation.number < outcome.receipt.blockNumber || observed.job.status !== 3 ||
          observed.job.deliveryCommitment.toLowerCase() !== deliveryCommitment.toLowerCase()) {
        tx.toConflict('DELIVERY_STATE_NOT_FINALIZED'); return;
      }
      setJob(observed.job);
      setDeliveryBundle(previous => previous ? { ...previous, submissionTx: outcome.hash } : previous);
      setDeliveryHandoffLink(null);
      tx.toFinalized({ blockNumber: outcome.receipt.blockNumber, status: 'success' });
    } catch (e) {
      const code = e instanceof Error ? e.message : 'SUBMISSION_FAILED';
      if (code === 'USER_REJECTED') tx.toCancelled();
      else if (code.startsWith('RPC_') || code.startsWith('OPERATION_') || code.startsWith('SUBMISSION_UNCERTAIN')) tx.toConflict(code);
      else tx.toFailed(code);
    }
  }, [config, isReady, job, jobId, deliveryCommitment, deliveryBundle, transferHash, termsBundle, tx]);

  const isSubmitting = ['submitted', 'pending_finality', 'browser_prompt'].includes(tx.state);
  const statusState: StatusState = !isReady()
    ? 'CONFIGURATION_REQUIRED'
    : !job
      ? 'UNVERIFIED'
      : job.status === 7
        ? 'FAILED'
        : job.status === 4 || job.status === 5 || job.status === 6
          ? 'FINALIZED'
          : 'READY';

  return (
    <SectionCard title="Provider: accept and submit" eyebrow="PROVIDER FLOW">
      <p className="muted" style={{ marginBottom: 16, fontSize: 14 }}>
        Read the job terms. Accepting selects the attestor for this job and is required
        before funding. After funding, submit a delivery commitment.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <label htmlFor="provider-job-id" className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>
          Job ID:
        </label>
        <input
          id="provider-job-id"
          type="text"
          inputMode="numeric"
          value={jobId}
          onChange={(e) => setJobId(e.target.value.replace(/[^0-9]/g, ''))}
          style={{
            padding: '6px 12px', borderRadius: 6, border: '1px solid #334337',
            background: '#0b1611', color: '#ecf4e9', fontFamily: 'ui-monospace, monospace', fontSize: 14, width: 120,
          }}
        />
        <button
          type="button"
          onClick={loadJob}
          disabled={!isReady()}
          style={{
            padding: '6px 14px', borderRadius: 6, border: '1px solid #334337',
            background: isReady() ? '#1a2e22' : '#15251c',
            color: isReady() ? '#a8bdab' : '#5a6e5e',
            cursor: isReady() ? 'pointer' : 'not-allowed', fontSize: 14,
          }}
        >
          Read job
        </button>
      </div>

      {!isReady() && <DisabledNotice reason="Protocol configuration not verified" />}

      {loading && <p className="muted">Reading on-chain state...</p>}
      {readError && <p style={{ color: '#ff9e9e' }}>{readError}</p>}

      {job && (
        <>
          <div style={{ marginBottom: 16 }}>
            <StatusBadge state={statusState} details={`Status: ${['Proposed', 'Accepted', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired', 'Cancelled'][job.status]}`} />
          </div>

          <div style={{ border: '1px solid #334337', borderRadius: 12, padding: 18, background: '#0b1611', marginBottom: 16 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>PUBLIC JOB DATA</div>
            <FieldPreview label="Buyer" value={job.buyer} />
            <FieldPreview label="Provider" value={job.provider} />
            <FieldPreview label="Attestor" value={job.attestor} />
            <FieldPreview label="Budget" value={`${job.budget.toString()} atomic`} />
            <FieldPreview label="Expiry" value={new Date(Number(job.expiresAt) * 1000).toISOString()} />
            <FieldPreview label="Terms commitment" value={job.termsCommitment} />
            {job.deliveryCommitment && job.deliveryCommitment !== '0x' && (
              <FieldPreview label="Delivery commitment" value={job.deliveryCommitment} />
            )}
          </div>

          {job.status === 0 && (
            <div style={{ border: '1px solid #2d5a3d', borderRadius: 12, padding: 18, background: '#0a1f14', marginBottom: 16 }}>
              <p style={{ color: '#a8bdab', margin: '0 0 12px', fontSize: 14 }}>
                <strong>Accept the selected attestor:</strong> This chooses the attestor for this job.
                It is irrevocable once the job is funded. The attestor will privately review
                your delivery — never paste private material into this page.
              </p>
              <button
                type="button"
                onClick={handleAccept}
                disabled={isSubmitting || !canAccept}
                style={{
                  padding: '10px 22px', borderRadius: 8, border: 'none',
                  background: canAccept && !isSubmitting ? '#bcfa73' : '#334337',
                  color: canAccept && !isSubmitting ? '#0b1611' : '#5a6e5e',
                  fontWeight: 600, cursor: canAccept && !isSubmitting ? 'pointer' : 'not-allowed', fontSize: 14,
                }}
              >
                {isSubmitting ? 'Submitting...' : 'Accept attestor and job'}
              </button>
              {tx.state !== 'idle' && (
                <div style={{ marginTop: 12 }}>
                  <StatusBadge state={tx.state === 'finalized' ? 'FINALIZED' : tx.state === 'failed' || tx.state === 'reverted' ? 'FAILED' : 'PENDING_FINALITY'} details={tx.state} />
                  {tx.hash && <p className="mono">Transaction hash: {tx.hash}</p>}
                  {tx.state === 'finalized' && <ExplorerLink hash={tx.hash} label="Verified acceptance" />}
                  {tx.error && <p style={{ color: '#ff9e9e', marginTop: 8 }}>{tx.error}</p>}
                </div>
              )}
            </div>
          )}

          {job.status === 1 && (
            <div role="status" aria-live="polite" style={{
              padding: 12, borderRadius: 8, background: '#15251c', border: '1px solid #2d5a3d',
              color: '#bcfa73', marginBottom: 16,
            }}>
              Attestor accepted. Waiting for buyer to fund...
            </div>
          )}

          {job.status === 2 && (
            <>
              <div style={{ border: '1px solid #8b6914', borderRadius: 12, padding: 16, marginTop: 16, marginBottom: 16 }}>
                <p className="muted">Open the buyer&apos;s encrypted handoff link. XYX decrypts it only in this browser, then checks its commitment and all public job bindings before offering the task-token transfer. A recovery file is also accepted.</p>
                <label htmlFor="provider-terms-handoff" className="muted">Encrypted terms handoff link</label>
                <textarea id="provider-terms-handoff" value={termsHandoffLink} onChange={event => setTermsHandoffLink(event.target.value)} rows={3} style={{ width: '100%' }} />
                <button type="button" onClick={() => importTermsBundle(termsHandoffLink)} disabled={!termsHandoffLink}>Decrypt and verify terms link</button>
                <input type="file" accept="application/json,.json" aria-label="Private terms bundle" onChange={event => importTermsBundle(event.target.files?.[0])} />
                {termsBundle && <>
                  <FieldPreview label="Terms match finalized job" value="Yes" />
                  <FieldPreview label="Task recipient" value={taskTransferFromTerms(termsBundle.terms).recipient} />
                  <FieldPreview label="Task amount (atomic)" value={taskTransferFromTerms(termsBundle.terms).amountAtomic.toString()} />
                  {!transferHash && <button type="button" onClick={handleTaskTransfer} disabled={isSubmitting} style={{ marginTop: 12 }}>
                    Transfer exact task amount from provider wallet
                  </button>}
                  {transferHash && <FieldPreview label="Finalized task transfer hash" value={transferHash} />}
                </>}
              </div>
              <div className="eyebrow" style={{ marginBottom: 10, marginTop: 16 }}>DELIVERY COMMITMENT</div>
              <p className="muted" style={{ marginBottom: 12, fontSize: 13 }}>
                Enter the private delivery response after the task transfer. The transfer hash and agreed amount are bound into the commitment. Create an encrypted handoff link for the selected attestor before submitting.
              </p>
              <div style={{ marginBottom: 12 }}>
                <label htmlFor="delivery-kind" style={{ display: 'block', fontSize: 13 }} className="muted">
                  Kind
                </label>
                <input
                  id="delivery-kind"
                  value={deliveryKind}
                  onChange={(e) => setDeliveryKind(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #334337',
                    background: '#0b1611', color: '#ecf4e9', fontSize: 14,
                  }}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label htmlFor="delivery-content" style={{ display: 'block', fontSize: 13 }} className="muted">
                  Delivery response (private)
                </label>
                <textarea
                  id="delivery-content"
                  value={deliveryContent}
                  onChange={(e) => setDeliveryContent(e.target.value)}
                  rows={4}
                  style={{
                    width: '100%', padding: 10, borderRadius: 6, border: '1px solid #334337',
                    background: '#0b1611', color: '#ecf4e9', fontFamily: 'ui-monospace, monospace',
                    fontSize: 13, resize: 'vertical',
                  }}
                />
              </div>
              <button
                type="button"
                onClick={computeDeliveryCommitment}
                disabled={!transferHash || !termsBundle}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: '1px solid #334337',
                  background: '#1a2e22', color: '#a8bdab', cursor: 'pointer', fontSize: 13, marginBottom: 12,
                }}
              >
                Compute commitment
              </button>

              {deliveryError && <ErrorSummary errors={[deliveryError]} />}

              {deliveryCommitment && (
                <div style={{ border: '1px solid #2d5a3d', borderRadius: 12, padding: 18, background: '#0a1f14', marginBottom: 16 }}>
                  <div className="eyebrow" style={{ marginBottom: 10 }}>COMMITMENT READY</div>
                  <FieldPreview label="Delivery commitment" value={deliveryCommitment} />
                  {deliveryBundle && <button type="button" onClick={createDeliveryHandoff} disabled={handoffBusy}>
                    {handoffBusy ? 'Encrypting and storing…' : deliveryBundle.submissionTx ? 'Create finalized delivery handoff link' : 'Create delivery handoff link'}
                  </button>}
                  {deliveryHandoffLink && <textarea readOnly value={deliveryHandoffLink} rows={3} aria-label="Private delivery handoff link" style={{ width: '100%', marginTop: 8 }} />}
                  {deliveryBundle && <button type="button" onClick={() => {
                    downloadPrivateBundle(`xyx-private-delivery-${jobId}.json`, deliveryBundle);
                    setExportedDeliveryCommitment(deliveryBundle.commitment);
                  }} style={{ marginLeft: 8 }}>
                    {deliveryBundle.submissionTx ? 'Download finalized recovery backup' : 'Download recovery backup'}
                  </button>}
                  {exportedDeliveryCommitment !== deliveryCommitment &&
                    <DisabledNotice reason="Initiate export of the exact delivery bundle and verify it is saved before submitting" />}
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSubmit || isSubmitting}
                    style={{
                      padding: '10px 22px', borderRadius: 8, border: 'none', marginTop: 16,
                      background: canSubmit && !isSubmitting ? '#bcfa73' : '#334337',
                      color: canSubmit && !isSubmitting ? '#0b1611' : '#5a6e5e',
                      fontWeight: 600, cursor: canSubmit && !isSubmitting ? 'pointer' : 'not-allowed', fontSize: 14,
                    }}
                  >
                    {isSubmitting ? 'Submitting...' : 'Submit delivery commitment'}
                  </button>
                  {tx.state !== 'idle' && (
                    <div style={{ marginTop: 12 }}>
                      <StatusBadge state={tx.state === 'finalized' ? 'FINALIZED' : tx.state === 'failed' || tx.state === 'reverted' ? 'FAILED' : 'PENDING_FINALITY'} details={tx.state} />
                      {tx.hash && <p className="mono">Transaction hash: {tx.hash}</p>}
                      {tx.state === 'finalized' && <ExplorerLink hash={tx.hash} label="Verified submission" />}
                      {tx.error && <p style={{ color: '#ff9e9e', marginTop: 8 }}>{tx.error}</p>}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {job.status === 3 && deliveryBundle?.submissionTx && (
            <div style={{ border: '1px solid #2d5a3d', borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <p className="muted">Delivery submission was observed final. Give the updated private bundle to the selected attestor through your secure channel.</p>
              <FieldPreview label="Submission transaction" value={deliveryBundle.submissionTx} />
              <button type="button" onClick={createDeliveryHandoff} disabled={handoffBusy}>
                {handoffBusy ? 'Encrypting and storing…' : 'Create finalized delivery handoff link'}
              </button>
              {deliveryHandoffLink && <textarea readOnly value={deliveryHandoffLink} rows={3} aria-label="Finalized delivery handoff link" style={{ width: '100%', marginTop: 8 }} />}
              <button type="button" onClick={() => downloadPrivateBundle(`xyx-private-delivery-${jobId}.json`, deliveryBundle)}>
                Download finalized delivery bundle
              </button>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}
