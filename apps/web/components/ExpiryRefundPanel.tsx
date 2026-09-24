'use client';

/**
 * ExpiryRefundPanel
 *
 * Shows expiry refund only after chain read confirms eligible state/time.
 * No dependency on attestor/private evidence.
 * Anyone can call claimExpiryRefund after expiry time is reached.
 */

'use client';

import { useState, useCallback } from 'react';
import { StatusBadge, SectionCard, FieldPreview, DisabledNotice, ExplorerLink } from '../components/StatusBadge';
import type { StatusState } from '../components/StatusBadge';
import { useConfig } from '../hooks/useConfig';
import { useTx } from '../hooks/useTx';
import {
  buildClaimExpiryRefundRequest,
  type ContractAddresses,
} from '../../../packages/monad/src/delivery-chain';
import { JOB_STATUS_LABELS, type JobStatus } from '../../../packages/monad/src/protocol';
import type { JobData } from '../../../packages/monad/src/protocol';
import { matchedCanonicalJob, viemPublicClientToCanonicalChainReader } from '../../../packages/monad/src/canonical-chain';
import { verifySettlement } from '../../../packages/monad/src/settlement';
import { executeBrowserTransaction } from '../lib/browser-transaction';

export default function ExpiryRefundPanel() {
  const { config, isReady } = useConfig();
  const tx = useTx();

  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<JobData | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [chainTime, setChainTime] = useState<bigint | null>(null);
  const [eligible, setEligible] = useState(false);

  const loadJob = useCallback(async () => {
    if (!config || !isReady()) return;
    setLoading(true);
    setReadError(null);
    setEligible(false);
    try {
      if (!config.secondaryRpcUrl) throw new Error('SECONDARY_RPC_URL_MISSING');
      const { createMonadClient } = await import('../../../packages/monad/src/delivery-chain');
      const primary = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
      const secondary = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
      const { job: data, observation } = await matchedCanonicalJob(primary, secondary, config.protocolAddress, BigInt(jobId));
      setJob(data);
      setChainTime(observation.timestamp);
      setEligible((data.status === 2 || data.status === 3) && observation.timestamp >= data.expiresAt);
    } catch {
      setReadError('FINALIZED_JOB_READ_FAILED');
      setJob(null);
    } finally {
      setLoading(false);
    }
  }, [config, isReady, jobId]);

  const handleRefund = useCallback(async () => {
    if (!config || !isReady() || !eligible) return;
    try {
      const addresses: ContractAddresses = {
        protocol: config.protocolAddress,
        registry: config.registryAddress,
        p256Verifier: config.p256VerifierAddress,
        paymentToken: config.paymentTokenAddress!,
      };
      const id = BigInt(jobId);
      const request = buildClaimExpiryRefundRequest({ jobId: id }, addresses);
      tx.reset();
      const outcome = await executeBrowserTransaction(config, request, `expiry:${jobId}`, {
        onWalletPrompt: tx.toPrompt,
        onSubmitted: tx.toSubmitted,
      });
      if (outcome.status === 'pending') return;
      if (outcome.status === 'reverted') {
        tx.toReverted('REFUND_TRANSACTION_REVERTED');
        return;
      }
      if (!config.paymentTokenAddress || !config.secondaryRpcUrl) throw new Error('CONFIG_REQUIRED');
      const { createMonadClient } = await import('../../../packages/monad/src/delivery-chain');
      const primary = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
      const secondary = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
      const verified = await verifySettlement(primary, secondary, {
        protocol: config.protocolAddress,
        token: config.paymentTokenAddress,
        jobId: id,
        refundTx: outcome.hash,
      });
      if (verified.state !== 'LIVE_VERIFIED' || verified.outcome !== 'EXPIRED') throw new Error('REFUND_VERIFICATION_FAILED');
      tx.toFinalized({ blockNumber: outcome.receipt.blockNumber, status: 'success' });
      setEligible(false);
      const matched = await matchedCanonicalJob(primary, secondary, config.protocolAddress, id);
      setJob(matched.job);
    } catch (e) {
      const code = e instanceof Error ? e.message : 'REFUND_FAILED';
      if (code === 'USER_REJECTED') tx.toCancelled();
      else if (code === 'RPC_FINALITY_CONFLICT' || code === 'REFUND_VERIFICATION_FAILED' || code.startsWith('OPERATION_') || code.startsWith('SUBMISSION_UNCERTAIN')) tx.toConflict(code);
      else tx.toFailed(code.startsWith('SUBMISSION_UNCERTAIN') ? code : 'REFUND_FAILED');
    }
  }, [config, isReady, eligible, jobId, tx]);

  const isRefunding = ['submitted', 'pending_finality', 'browser_prompt'].includes(tx.state);
  const statusState: StatusState = !isReady()
    ? 'CONFIGURATION_REQUIRED'
    : !job
      ? 'UNVERIFIED'
      : eligible
        ? 'READY'
        : 'UNVERIFIED';

  return (
    <SectionCard title="Expiry refund" eyebrow="EXPIRY FLOW">
      <p className="muted" style={{ marginBottom: 16, fontSize: 14 }}>
        Expiry refund returns the escrowed reward to the buyer after the deadline.
        It does not require an attestor verdict and does not reverse any delivery already submitted.
      </p>

      {!isReady() && <DisabledNotice reason="Protocol configuration not verified" />}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <label htmlFor="expiry-job-id" className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>
          Job ID:
        </label>
        <input
          id="expiry-job-id"
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
          Check eligibility
        </button>
      </div>

      {loading && <p className="muted">Reading on-chain state and chain time...</p>}
      {readError && <p style={{ color: '#ff9e9e' }}>{readError}</p>}

      {job && (
        <>
          <div style={{ marginBottom: 16 }}>
            <StatusBadge
              state={statusState}
              details={eligible ? 'Eligible for expiry refund' : `${JOB_STATUS_LABELS[(job.status as JobStatus) ?? 0] ?? `Status ${job.status}`} — not yet eligible`}
            />
          </div>

          <div style={{ border: '1px solid #334337', borderRadius: 12, padding: 18, background: '#0b1611', marginBottom: 16 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>ELIGIBILITY CHECK</div>
            <FieldPreview label="Job ID" value={`#${jobId}`} />
            <FieldPreview label="Status" value={JOB_STATUS_LABELS[(job.status as JobStatus) ?? 0] ?? String(job.status)} />
            <FieldPreview label="Budget" value={`${job.budget.toString()} atomic`} />
            <FieldPreview label="Expiry" value={new Date(Number(job.expiresAt) * 1000).toISOString()} />
            {chainTime !== null && (
              <FieldPreview label="Current chain time" value={new Date(Number(chainTime) * 1000).toISOString()} />
            )}
            <FieldPreview label="Eligible" value={eligible ? 'Yes — expiry reached' : 'No — before expiry or wrong state'} />
          </div>

          {eligible && (
            <div style={{ border: '1px solid #2d5a3d', borderRadius: 12, padding: 18, background: '#0a1f14', marginBottom: 16 }}>
              <p style={{ color: '#a8bdab', margin: '0 0 12px', fontSize: 14 }}>
                <strong>Expiry refund is available.</strong> This returns the escrowed reward to the buyer.
                It does not reverse any delivery already submitted by the provider and does not
                require an attestor verdict.
              </p>
              <button
                type="button"
                onClick={handleRefund}
                disabled={!eligible || isRefunding}
                style={{
                  padding: '10px 22px', borderRadius: 8, border: 'none',
                  background: eligible && !isRefunding ? '#bcfa73' : '#334337',
                  color: eligible && !isRefunding ? '#0b1611' : '#5a6e5e',
                  fontWeight: 600, cursor: eligible && !isRefunding ? 'pointer' : 'not-allowed', fontSize: 14,
                }}
              >
                {isRefunding ? 'Submitting...' : 'Claim expiry refund'}
              </button>
            </div>
          )}

          {tx.state !== 'idle' && (
            <div style={{ marginTop: 16 }}>
              <StatusBadge state={tx.state === 'finalized' ? 'FINALIZED' : tx.state === 'conflict' ? 'CONFLICT' : tx.state === 'reverted' || tx.state === 'failed' ? 'FAILED' : 'PENDING_FINALITY'} details={tx.state} />
              {tx.hash && <p className="mono" style={{ fontSize: 12 }}>Transaction hash: {tx.hash}</p>}
              {tx.state === 'finalized' && <ExplorerLink hash={tx.hash} label="Verified refund" />}
              {tx.error && <p style={{ color: '#ff9e9e', marginTop: 8 }}>{tx.error}</p>}
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}
