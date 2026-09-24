'use client';

/**
 * JobStatePanel
 *
 * Reads canonical job state from the protocol contract and displays lifecycle,
 * events, and the next valid action. Uses contract reads, not mutable local status.
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { StatusBadge, SectionCard, FieldPreview, DisabledNotice } from '../components/StatusBadge';
import type { StatusState } from '../components/StatusBadge';
import { useConfig } from '../hooks/useConfig';
import { createMonadClient } from '../../../packages/monad/src/delivery-chain';
import { matchedCanonicalJob, viemPublicClientToCanonicalChainReader } from '../../../packages/monad/src/canonical-chain';
import { JOB_STATUS_LABELS, type JobStatus } from '../../../packages/monad/src/protocol';
import type { JobData } from '../../../packages/monad/src/protocol';

export default function JobStatePanel({ jobId: initialJobId }: { jobId?: number }) {
  const { config, isReady } = useConfig();
  const [jobIdInput, setJobIdInput] = useState(String(initialJobId ?? ''));
  const [jobId, setJobId] = useState<number>(initialJobId ?? 0);
  const [job, setJob] = useState<JobData | null>(null);
  const [observedBlock, setObservedBlock] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRead = useMemo(() => isReady() && !!config && jobId != null && jobId > 0, [isReady, config, jobId]);

  const loadJob = useCallback(async () => {
    if (!canRead || !config) return;
    setLoading(true);
    setError(null);
    try {
      if (!config.secondaryRpcUrl) throw new Error('SECONDARY_RPC_URL_MISSING');
      const primary = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
      const secondary = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
      const { job: data, observation } = await matchedCanonicalJob(primary, secondary, config.protocolAddress, BigInt(jobId));
      setJob(data);
      setObservedBlock(observation.number);
    } catch {
      setError('FINALIZED_JOB_READ_FAILED');
      setJob(null);
      setObservedBlock(null);
    } finally {
      setLoading(false);
    }
  }, [canRead, config, jobId]);

  useEffect(() => {
    if (canRead) loadJob();
  }, [canRead]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLookup = () => {
    const parsed = Number(jobIdInput);
    if (Number.isInteger(parsed) && parsed > 0) {
      setJobId(parsed);
    }
  };

  const getStatusState = (): StatusState => {
    if (!isReady()) return 'CONFIGURATION_REQUIRED';
    if (error) return 'UNVERIFIED';
    if (!job) return 'UNVERIFIED';
    const s = job.status;
    if (s === 4 || s === 5 || s === 6 || s === 7) return 'FINALIZED';
    return 'READY';
  };

  const nextAction = useMemo(() => {
    if (!job) return null;
    const s = job.status;
    if (s === 0) return 'Provider must accept; buyer may cancel before funding';
    if (s === 1) return 'Buyer must fund (fundJob)';
    if (s === 2) return 'Provider must submit delivery, or anyone may claim after expiry';
    if (s === 3) return 'Attestor must resolve, or anyone may claim after expiry';
    if (s === 4) return 'Settled: Completed';
    if (s === 5) return 'Settled: Rejected';
    if (s === 6) return 'Settled: Expired';
    if (s === 7) return 'Cancelled before funding';
    return null;
  }, [job]);

  return (
    <SectionCard title="Job state" eyebrow="ON-CHAIN READ">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <label htmlFor="job-id-input" className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>
          Job ID:
        </label>
        <input
          id="job-id-input"
          type="text"
          inputMode="numeric"
          value={jobIdInput}
          onChange={(e) => setJobIdInput(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
          style={{
            padding: '6px 12px', borderRadius: 6, border: '1px solid #334337',
            background: '#0b1611', color: '#ecf4e9', fontFamily: 'ui-monospace, monospace',
            fontSize: 14, width: 120,
          }}
          aria-label="Job ID to read"
        />
        <button
          type="button"
          onClick={handleLookup}
          disabled={!canRead}
          style={{
            padding: '6px 14px', borderRadius: 6, border: '1px solid #334337',
            background: canRead ? '#1a2e22' : '#15251c', color: canRead ? '#a8bdab' : '#5a6e5e',
            cursor: canRead ? 'pointer' : 'not-allowed', fontSize: 14,
          }}
        >
          Read job
        </button>
      </div>

      {!isReady() && <DisabledNotice reason="Protocol configuration is not verified" />}

      {loading && <p className="muted">Reading on-chain state...</p>}
      {error && <p style={{ color: '#ff9e9e' }}>{error}</p>}

      {job && (
        <>
          <div style={{ marginBottom: 16 }}>
            <StatusBadge
              state={getStatusState()}
              details={JOB_STATUS_LABELS[job.status as JobStatus] ?? `Status ${job.status}`}
            />
          </div>

          <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            <FieldPreview label="Job ID" value={`#${jobId}`} />
            {observedBlock !== null && <FieldPreview label="Finalized observation block" value={observedBlock.toString()} />}
            <FieldPreview label="Buyer" value={job.buyer} />
            <FieldPreview label="Provider" value={job.provider} />
            <FieldPreview label="Attestor" value={job.attestor} />
            <FieldPreview label="Budget" value={`${job.budget.toString()} atomic`} />
            <FieldPreview label="Expires At" value={new Date(Number(job.expiresAt) * 1000).toISOString()} />
            <FieldPreview label="Terms Commitment" value={job.termsCommitment} />
            {job.deliveryCommitment && job.deliveryCommitment !== '0x' && (
              <FieldPreview label="Delivery Commitment" value={job.deliveryCommitment} />
            )}
          </div>

          {nextAction && (
            <div role="status" aria-live="polite" style={{
              padding: 12, borderRadius: 8, background: '#1a2e22', border: '1px solid #2d5a3d',
              color: '#a8bdab', fontSize: 14, marginBottom: 12,
            }}>
              Next valid action: <strong>{nextAction}</strong>
            </div>
          )}

          {(job.status === 4 || job.status === 5) && (
            <div style={{ marginTop: 12 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>TERMINAL OUTCOME (ON-CHAIN STATUS)</div>
              <FieldPreview label="Decision" value={job.status === 4 ? 'COMPLETE (1)' : 'REJECT (2)'} />
              <FieldPreview
                label="Verdict digest"
                value="Not stored on-chain. Read the JobResolved event of the resolution transaction."
              />
            </div>
          )}

        </>
      )}

      {!loading && !job && !error && canRead && (
        <p className="muted">Enter a job ID above to read on-chain state.</p>
      )}
    </SectionCard>
  );
}
