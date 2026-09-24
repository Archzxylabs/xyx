'use client';

import { useState, useCallback } from 'react';
import { decodeEventLog, formatUnits, parseUnits, type Address, type Hex } from 'viem';
import {
  privateTermsSchema,
  type PrivateTermsInput,
} from '../../../packages/monad/src/delivery';
import {
  generateSalt,
} from '../../../packages/monad/src/commitments';
import {
  prepareBuyerProposal,
  canOfferFunding,
  PREPARED_NOT_BROADCAST_LABEL,
  type PreparedProposal,
} from '../../../packages/monad/src/buyer-proposal';
import { SectionCard, FieldPreview, DisabledNotice, ErrorSummary, StatusBadge, ExplorerLink } from '../components/StatusBadge';
import { useConfig } from '../hooks/useConfig';
import { useTx } from '../hooks/useTx';
import { connectWallet, executeBrowserTransaction } from '../lib/browser-transaction';
import { createMonadClient, buildFundRequest, type ContractAddresses } from '../../../packages/monad/src/delivery-chain';
import { deliveryProtocolAbi, type JobData } from '../../../packages/monad/src/protocol';
import { matchedCanonicalJob, viemPublicClientToCanonicalChainReader } from '../../../packages/monad/src/canonical-chain';
import { downloadPrivateBundle, makePrivateTermsBundle, parsePrivateTermsBundle } from '../lib/private-terms-bundle';
import { createSecureHandoff } from '../lib/secure-handoff';

const erc20Abi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address', name: 'owner' }, { type: 'address', name: 'spender' }], outputs: [{ type: 'uint256', name: '' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address', name: 'owner' }], outputs: [{ type: 'uint256', name: '' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address', name: 'spender' }, { type: 'uint256', name: 'amount' }], outputs: [{ type: 'bool', name: '' }] },
] as const;

export default function BuyerJobForm() {
  const { config, isReady, paymentTokenConfigured } = useConfig();
  const tx = useTx();
  const [buyer, setBuyer] = useState<Address | null>(null);
  const [observedJobId, setObservedJobId] = useState<bigint | null>(null);
  const [observedJob, setObservedJob] = useState<JobData | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [fundingHash, setFundingHash] = useState<Hex | null>(null);
  const [termsHandoffLink, setTermsHandoffLink] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [exportedTermsCommitment, setExportedTermsCommitment] = useState<Hex | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumeJobId, setResumeJobId] = useState('');
  const [resumeFile, setResumeFile] = useState<File | null>(null);

  const [rawTask, setRawTask] = useState<Record<string, unknown>>({ recipient: '', amountAtomic: '', instructions: '' });
  const [rawPolicy, setRawPolicy] = useState<Record<string, unknown>>({ maxRetries: 2, timeoutSeconds: 3600 });
  const [provider, setProvider] = useState('');
  const [attestor, setAttestor] = useState('');
  const [budgetStr, setBudgetStr] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const [salt, setSalt] = useState(() => generateSalt(32));
  const [termsError, setTermsError] = useState<string | null>(null);

  /**
   * The prepared proposal, or `null` while none has been built.
   *
   * This is a built request, not a transaction: nothing here is broadcast, so the
   * object can carry a commitment and a call request and nothing else.
   */
  const [prepared, setPrepared] = useState<PreparedProposal | null>(null);

  const [step, setStep] = useState<'terms' | 'propose'>('terms');

  const fundingAvailable = canOfferFunding(observedJobId) && observedJob?.status === 1 &&
    observedJob.buyer.toLowerCase() === buyer?.toLowerCase() &&
    observedJob.termsCommitment.toLowerCase() === prepared?.termsCommitment.toLowerCase() && !busy;

  const addresses = useCallback((): ContractAddresses => {
    if (!config?.paymentTokenAddress) throw new Error('PAYMENT_TOKEN_MISSING');
    return {
      protocol: config.protocolAddress,
      registry: config.registryAddress,
      p256Verifier: config.p256VerifierAddress,
      paymentToken: config.paymentTokenAddress,
    };
  }, [config]);

  const readObservedJob = useCallback(async (id: bigint): Promise<JobData> => {
    if (!config?.secondaryRpcUrl) throw new Error('SECONDARY_RPC_URL_MISSING');
    const first = viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl));
    const second = viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl));
    const observation = await matchedCanonicalJob(first, second, config.protocolAddress, id);
    setObservedJobId(id);
    setObservedJob(observation.job);
    if (buyer && config.paymentTokenAddress) {
      const [a, b, x, y] = await Promise.all([
        first.readContract({ address: config.paymentTokenAddress, abi: erc20Abi, functionName: 'allowance', args: [buyer, config.protocolAddress], blockNumber: observation.observation.number }),
        second.readContract({ address: config.paymentTokenAddress, abi: erc20Abi, functionName: 'allowance', args: [buyer, config.protocolAddress], blockNumber: observation.observation.number }),
        first.readContract({ address: config.paymentTokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [buyer], blockNumber: observation.observation.number }),
        second.readContract({ address: config.paymentTokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [buyer], blockNumber: observation.observation.number }),
      ]);
      if (typeof a !== 'bigint' || a !== b || typeof x !== 'bigint' || x !== y) throw new Error('TOKEN_RPC_STATE_MISMATCH');
      setAllowance(a);
      setBalance(x);
    }
    return observation.job;
  }, [config, buyer]);

  const buildTerms = useCallback((): PrivateTermsInput => {
    if (!config) throw new Error('CONFIG_REQUIRED');
    if (!buyer) throw new Error('BUYER_WALLET_REQUIRED');
    if (!config.paymentTokenAddress) throw new Error('PAYMENT_TOKEN_MISSING');
    const budgetAtomic = parseUnits(budgetStr, 6).toString();
    const expiryTs = Math.floor(new Date(expiresAt).getTime() / 1000);

    return {
      schema: 'xyx.private-terms',
      chainId: 10143,
      protocol: config.protocolAddress,
      paymentToken: config.paymentTokenAddress,
      buyer,
      provider,
      attestor,
      budgetAtomic,
      expiresAt: expiryTs,
      task: rawTask as any,
      acceptancePolicy: rawPolicy as any,
    };
  }, [config, buyer, budgetStr, expiresAt, provider, attestor, rawTask, rawPolicy]);

  const handlePreview = useCallback(() => {
    setTermsError(null);
    try {
      const terms = buildTerms();
      privateTermsSchema.parse(terms);
      makePrivateTermsBundle(terms, salt);
      setStep('propose');
    } catch (e) {
      setTermsError(e instanceof Error ? e.message : 'Invalid terms');
    }
  }, [buildTerms]);

  const handlePropose = useCallback(() => {
    if (!config || !isReady()) return;
    setTermsError(null);
    try {
      const request = prepareBuyerProposal({
        terms: buildTerms(),
        salt,
        addresses: {
          protocol: config.protocolAddress,
          registry: config.registryAddress,
          p256Verifier: config.p256VerifierAddress,
          paymentToken: config.paymentTokenAddress,
        },
      });
      makePrivateTermsBundle(buildTerms(), salt);
      setPrepared(request);
    } catch (e) {
      setPrepared(null);
      setTermsError(e instanceof Error ? e.message : 'Invalid terms');
    }
  }, [config, isReady, buildTerms, salt]);

  const handleBroadcastProposal = useCallback(async () => {
    if (!config || !prepared || !buyer || !isReady() || exportedTermsCommitment !== prepared.termsCommitment) return;
    setBusy(true);
    setTermsError(null);
    tx.reset();
    try {
      // Recompute from current terms so a stale preview can never be broadcast.
      const terms = buildTerms();
      makePrivateTermsBundle(terms, salt);
      const fresh = prepareBuyerProposal({ terms, salt, addresses: addresses() });
      if (fresh.termsCommitment.toLowerCase() !== prepared.termsCommitment.toLowerCase()) throw new Error('TERMS_CHANGED_REPREPARE');
      const request = { ...fresh.request, from: buyer };
      const outcome = await executeBrowserTransaction(config, request, `propose:${fresh.termsCommitment}`, { onWalletPrompt: tx.toPrompt, onSubmitted: tx.toSubmitted });
      if (outcome.status === 'pending') return;
      if (outcome.status === 'reverted') { tx.toReverted('PROPOSAL_REVERTED'); return; }
      const proposed = outcome.receipt.logs.flatMap(log => {
        if (log.address.toLowerCase() !== config.protocolAddress.toLowerCase()) return [];
        try {
          const event = decodeEventLog({ abi: deliveryProtocolAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
          return event.eventName === 'JobProposed' ? [event.args] : [];
        } catch { return []; }
      });
      if (proposed.length !== 1 || proposed[0].buyer.toLowerCase() !== buyer.toLowerCase() ||
          proposed[0].termsCommitment.toLowerCase() !== fresh.termsCommitment.toLowerCase()) throw new Error('PROPOSAL_EVENT_MISMATCH');
      const id = proposed[0].jobId;
      const job = await readObservedJob(id);
      if (job.buyer.toLowerCase() !== buyer.toLowerCase() || (job.status !== 0 && job.status !== 1) ||
          job.termsCommitment.toLowerCase() !== fresh.termsCommitment.toLowerCase()) throw new Error('PROPOSAL_STATE_MISMATCH');
      tx.toFinalized({ blockNumber: outcome.receipt.blockNumber, status: 'success' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PROPOSAL_FAILED';
      if (code === 'USER_REJECTED') tx.toCancelled();
      else if (code.includes('MISMATCH') || code.startsWith('RPC_') || code.startsWith('OPERATION_') || code.startsWith('SUBMISSION_UNCERTAIN')) tx.toConflict(code);
      else tx.toFailed(code);
      setTermsError(code);
    } finally { setBusy(false); }
  }, [config, prepared, buyer, isReady, exportedTermsCommitment, tx, buildTerms, salt, addresses, readObservedJob]);

  const handleApproveOrFund = useCallback(async () => {
    if (!config || !buyer || !observedJobId || !fundingAvailable || !observedJob) return;
    setBusy(true);
    tx.reset();
    try {
      const job = await readObservedJob(observedJobId);
      if (job.status !== 1 || job.buyer.toLowerCase() !== buyer.toLowerCase()) throw new Error('JOB_NOT_ACCEPTED');
      if (balance === null || balance < job.budget) throw new Error('INSUFFICIENT_TOKEN_BALANCE');
      const needsApproval = allowance === null || allowance < job.budget;
      const request = needsApproval
        ? { abi: erc20Abi, address: config.paymentTokenAddress!, functionName: 'approve', args: [config.protocolAddress, job.budget], from: buyer }
        : buildFundRequest({ jobId: observedJobId, buyer }, addresses());
      const outcome = await executeBrowserTransaction(config, request, `${needsApproval ? 'approve' : 'fund'}:${observedJobId}`, { onWalletPrompt: tx.toPrompt, onSubmitted: tx.toSubmitted });
      if (outcome.status === 'pending') return;
      if (outcome.status === 'reverted') { tx.toReverted(needsApproval ? 'TOKEN_APPROVAL_REVERTED' : 'FUNDING_REVERTED'); return; }
      const updated = await readObservedJob(observedJobId);
      if (needsApproval ? (updated.status !== 1) : (updated.status !== 2)) throw new Error('FUNDING_STATE_MISMATCH');
      if (!needsApproval) {
        setFundingHash(outcome.hash);
        setTermsHandoffLink(null);
      }
      tx.toFinalized({ blockNumber: outcome.receipt.blockNumber, status: 'success' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'FUNDING_FAILED';
      if (code === 'USER_REJECTED') tx.toCancelled();
      else if (code.includes('MISMATCH') || code.startsWith('RPC_') || code.startsWith('OPERATION_') || code.startsWith('SUBMISSION_UNCERTAIN')) tx.toConflict(code);
      else tx.toFailed(code);
      setTermsError(code);
    } finally { setBusy(false); }
  }, [config, buyer, observedJobId, fundingAvailable, observedJob, readObservedJob, balance, allowance, addresses, tx]);

  const handleCancelProposal = useCallback(async () => {
    if (!config || !buyer || !observedJobId || !observedJob || observedJob.status !== 0) return;
    setBusy(true);
    setTermsError(null);
    tx.reset();
    try {
      const current = await readObservedJob(observedJobId);
      if (current.status !== 0 || current.buyer.toLowerCase() !== buyer.toLowerCase()) {
        throw new Error('JOB_NOT_CANCELLABLE');
      }
      const outcome = await executeBrowserTransaction(config, {
        abi: deliveryProtocolAbi,
        address: config.protocolAddress,
        functionName: 'cancelProposal',
        args: [observedJobId],
        from: buyer,
      }, `cancel:${observedJobId}`, { onWalletPrompt: tx.toPrompt, onSubmitted: tx.toSubmitted });
      if (outcome.status === 'pending') return;
      if (outcome.status === 'reverted') { tx.toReverted('CANCELLATION_REVERTED'); return; }
      const updated = await readObservedJob(observedJobId);
      if (updated.status !== 7 || updated.buyer.toLowerCase() !== buyer.toLowerCase()) {
        throw new Error('CANCELLATION_STATE_MISMATCH');
      }
      tx.toFinalized({ blockNumber: outcome.receipt.blockNumber, status: 'success' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CANCELLATION_FAILED';
      if (code === 'USER_REJECTED') tx.toCancelled();
      else if (code.includes('MISMATCH') || code.startsWith('RPC_') || code.startsWith('OPERATION_') || code.startsWith('SUBMISSION_UNCERTAIN')) tx.toConflict(code);
      else tx.toFailed(code);
      setTermsError(code);
    } finally { setBusy(false); }
  }, [config, buyer, observedJobId, observedJob, readObservedJob, tx]);

  const handleResume = useCallback(async () => {
    if (!config || !buyer || !resumeFile || (resumeJobId !== '' && !/^[1-9]\d*$/.test(resumeJobId))) return;
    setBusy(true); setTermsError(null);
    try {
      const bundle = parsePrivateTermsBundle(await resumeFile.text());
      const targetId = resumeJobId || bundle.jobId;
      if (bundle.terms.buyer.toLowerCase() !== buyer.toLowerCase() ||
          bundle.terms.protocol.toLowerCase() !== config.protocolAddress.toLowerCase() ||
          bundle.terms.paymentToken.toLowerCase() !== config.paymentTokenAddress?.toLowerCase() ||
          (bundle.jobId !== undefined && resumeJobId !== '' && bundle.jobId !== resumeJobId)) throw new Error('RESUME_BUNDLE_ROLE_OR_DEPLOYMENT_MISMATCH');
      const job = targetId ? await readObservedJob(BigInt(targetId)) : null;
      if (job && (job.buyer.toLowerCase() !== buyer.toLowerCase() ||
          job.termsCommitment.toLowerCase() !== bundle.commitment.toLowerCase() ||
          job.budget !== BigInt(bundle.terms.budgetAtomic) || job.expiresAt !== BigInt(bundle.terms.expiresAt))) {
        throw new Error('RESUME_BUNDLE_JOB_MISMATCH');
      }
      setSalt(bundle.salt);
      setRawTask(bundle.terms.task);
      setRawPolicy(bundle.terms.acceptancePolicy);
      setProvider(bundle.terms.provider);
      setAttestor(bundle.terms.attestor);
      setBudgetStr(formatUnits(BigInt(bundle.terms.budgetAtomic), 6));
      const date = new Date(Number(bundle.terms.expiresAt) * 1000);
      setExpiresAt(new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
      setPrepared(prepareBuyerProposal({ terms: bundle.terms, salt: bundle.salt, addresses: addresses() }));
      setExportedTermsCommitment(bundle.commitment);
      if (!job) { setObservedJobId(null); setObservedJob(null); setAllowance(null); setBalance(null); }
      setFundingHash(bundle.fundingTx ?? null);
      setStep('propose');
    } catch (error) {
      setObservedJobId(null); setObservedJob(null); setAllowance(null); setBalance(null);
      setTermsError(error instanceof Error ? error.message : 'RESUME_FAILED');
    }
    finally { setBusy(false); }
  }, [config, buyer, resumeFile, resumeJobId, readObservedJob, addresses]);

  const handleCreateTermsHandoff = useCallback(async () => {
    if (!prepared) return;
    setHandoffBusy(true);
    setTermsError(null);
    try {
      const bundle = makePrivateTermsBundle(buildTerms(), salt,
        observedJobId && fundingHash ? { jobId: observedJobId, fundingTx: fundingHash } : undefined);
      if (bundle.commitment.toLowerCase() !== prepared.termsCommitment.toLowerCase()) throw new Error('TERMS_CHANGED_REPREPARE');
      const link = await createSecureHandoff('terms', bundle);
      setTermsHandoffLink(link);
      setExportedTermsCommitment(bundle.commitment);
    } catch (error) {
      setTermsHandoffLink(null);
      setTermsError(error instanceof Error ? error.message : 'HANDOFF_WRITE_FAILED');
    } finally { setHandoffBusy(false); }
  }, [prepared, buildTerms, salt, observedJobId, fundingHash]);

  const backToTerms = useCallback(() => {
    setStep('terms');
      setPrepared(null);
      setExportedTermsCommitment(null);
      setTermsHandoffLink(null);
    setTermsError(null);
  }, []);

  return (
    <SectionCard title="Buyer: propose and fund" eyebrow="BUYER FLOW">
      <p className="muted" style={{ marginBottom: 16, fontSize: 14 }}>
        Connect the buyer wallet, prepare private terms, then explicitly approve each on-chain action.
        Only the commitment goes on-chain. Save and share private terms through a separate secure channel;
        this page does not persist or send them to the provider.
      </p>
      <button type="button" onClick={() => connectWallet().then(setBuyer).catch(error => setTermsError(error instanceof Error ? error.message : 'WALLET_CONNECT_FAILED'))}
        disabled={!isReady() || busy} style={{ padding: '10px 18px', marginBottom: 14 }}>
        {buyer ? `Buyer wallet: ${buyer.slice(0, 8)}…${buyer.slice(-4)}` : 'Connect buyer wallet'}
      </button>
      {buyer && <div style={{ border: '1px solid #334337', borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <p className="muted" style={{ marginTop: 0 }}>Restore a draft from your saved private terms bundle, or enter a known job ID to resume funding. XYX rechecks any claimed job against finalized state before enabling funding.</p>
        <label>Job ID <input value={resumeJobId} onChange={event => setResumeJobId(event.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" /></label>
        <label> Private terms bundle <input type="file" accept="application/json,.json" onChange={event => setResumeFile(event.target.files?.[0] ?? null)} /></label>
        <button type="button" onClick={handleResume} disabled={busy || !resumeFile || (resumeJobId !== '' && !/^[1-9]\d*$/.test(resumeJobId))}>Restore draft or resume job</button>
      </div>}

      {step === 'terms' && (
        <>
          <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label htmlFor="provider" style={{ display: 'block', fontSize: 13 }} className="muted">
                  Provider address
                </label>
                <input
                  id="provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  placeholder="0x..."
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #334337',
                    background: '#0b1611', color: '#ecf4e9', fontFamily: 'ui-monospace, monospace', fontSize: 14,
                  }}
                />
              </div>
              <div>
                <label htmlFor="attestor" style={{ display: 'block', fontSize: 13 }} className="muted">
                  Attestor address
                </label>
                <input
                  id="attestor"
                  value={attestor}
                  onChange={(e) => setAttestor(e.target.value)}
                  placeholder="0x..."
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #334337',
                    background: '#0b1611', color: '#ecf4e9', fontFamily: 'ui-monospace, monospace', fontSize: 14,
                  }}
                />
              </div>
              <div>
                <label htmlFor="budget" style={{ display: 'block', fontSize: 13 }} className="muted">
                  Budget (USDC)
                </label>
                <input
                  id="budget"
                  type="number"
                  min="0"
                  step="0.01"
                  value={budgetStr}
                  onChange={(e) => setBudgetStr(e.target.value)}
                  placeholder="0.00"
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #334337',
                    background: '#0b1611', color: '#ecf4e9', fontSize: 14,
                  }}
                />
              </div>
              <div>
                <label htmlFor="expiry" style={{ display: 'block', fontSize: 13 }} className="muted">
                  Expiry (ISO datetime)
                </label>
                <input
                  id="expiry"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #334337',
                    background: '#0b1611', color: '#ecf4e9', fontSize: 14,
                  }}
                />
              </div>
            </div>
            <fieldset style={{ border: '1px solid #334337', borderRadius: 8, padding: 12 }}>
              <legend className="muted">Private task</legend>
              <label htmlFor="task-recipient" style={{ display: 'block', fontSize: 13 }} className="muted">USDC recipient</label>
              <input id="task-recipient" value={String(rawTask.recipient ?? '')}
                onChange={event => setRawTask(current => ({ ...current, recipient: event.target.value }))}
                placeholder="0x..." style={{ width: '100%', marginBottom: 8 }} />
              <label htmlFor="task-amount" style={{ display: 'block', fontSize: 13 }} className="muted">Task payment (atomic USDC, 6 decimals)</label>
              <input id="task-amount" value={String(rawTask.amountAtomic ?? '')} inputMode="numeric"
                onChange={event => setRawTask(current => ({ ...current, amountAtomic: event.target.value.replace(/[^0-9]/g, '') }))}
                placeholder="20000" style={{ width: '100%', marginBottom: 8 }} />
              <label htmlFor="task-instructions" style={{ display: 'block', fontSize: 13 }} className="muted">Instructions</label>
              <textarea id="task-instructions" value={String(rawTask.instructions ?? '')}
                onChange={event => setRawTask(current => ({ ...current, instructions: event.target.value }))}
                rows={4} style={{ width: '100%' }} />
            </fieldset>
            <fieldset style={{ border: '1px solid #334337', borderRadius: 8, padding: 12 }}>
              <legend className="muted">Private acceptance policy</legend>
              <label htmlFor="max-retries" style={{ display: 'block', fontSize: 13 }} className="muted">Maximum retries</label>
              <input id="max-retries" type="number" min="0" step="1" value={String(rawPolicy.maxRetries ?? 0)}
                onChange={event => setRawPolicy(current => ({ ...current, maxRetries: Number(event.target.value) }))}
                style={{ width: '100%', marginBottom: 8 }} />
              <label htmlFor="task-timeout" style={{ display: 'block', fontSize: 13 }} className="muted">Task timeout (seconds)</label>
              <input id="task-timeout" type="number" min="1" step="1" value={String(rawPolicy.timeoutSeconds ?? '')}
                onChange={event => setRawPolicy(current => ({ ...current, timeoutSeconds: Number(event.target.value) }))}
                style={{ width: '100%' }} />
            </fieldset>
          </div>

          <button
            type="button"
            onClick={handlePreview}
            disabled={!isReady() || !buyer}
            style={{
              padding: '10px 22px', borderRadius: 8, border: 'none',
              background: isReady() && buyer ? '#bcfa73' : '#334337', color: isReady() && buyer ? '#0b1611' : '#5a6e5e',
              fontWeight: 600, cursor: isReady() && buyer ? 'pointer' : 'not-allowed', fontSize: 14,
            }}
          >
            Preview commitment
          </button>
          {!isReady() && <DisabledNotice reason="Protocol configuration not verified" />}
          {!buyer && <DisabledNotice reason="Connect the actual buyer wallet before hashing private terms" />}
          {isReady() && !paymentTokenConfigured && (
            <DisabledNotice reason="NEXT_PUBLIC_XYX_PAYMENT_TOKEN_ADDRESS is not configured, so private terms cannot bind a payment token" />
          )}
        </>
      )}

      {step === 'propose' && (
        <>
          <div style={{ border: '1px solid #334337', borderRadius: 12, padding: 18, background: '#0b1611', marginBottom: 16 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>COMMITMENT PREVIEW</div>
            <FieldPreview label="Provider" value={provider} />
            <FieldPreview label="Attestor" value={attestor} />
            <FieldPreview label="Budget" value={`${budgetStr} USDC`} />
            <FieldPreview label="Expiry" value={expiresAt} />
            <FieldPreview label="Salt" value={salt} />
            <FieldPreview label="Terms commitment" value={prepared?.termsCommitment ?? 'not computed yet'} />
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={backToTerms}
              style={{
                padding: '10px 18px', borderRadius: 8, border: '1px solid #334337',
                background: '#15251c', color: '#a8bdab', cursor: 'pointer', fontSize: 14,
              }}
            >
              Back to terms
            </button>
            <button
              type="button"
              onClick={handlePropose}
              style={{
                padding: '10px 22px', borderRadius: 8, border: 'none',
                background: '#bcfa73', color: '#0b1611',
                fontWeight: 600, cursor: 'pointer', fontSize: 14,
              }}
            >
              Build proposal request
            </button>
          </div>

          {prepared ? (
            <div
              data-testid="prepared-proposal"
              style={{ border: '1px solid #5c4a2e', borderRadius: 12, padding: 18, background: '#0b1611', marginTop: 16 }}
            >
              <div className="eyebrow" style={{ marginBottom: 10, color: '#f2d484' }}>
                {observedJobId === null ? PREPARED_NOT_BROADCAST_LABEL : 'FINALIZED JOB OBSERVED ON TWO RPCs'}
              </div>
              {observedJobId === null && <p style={{ fontSize: 14, marginBottom: 12 }}>
                This request was built in this browser but has not been broadcast. It is not an on-chain fact.
              </p>}
              <FieldPreview label="Contract" value={prepared.request.address} />
              <FieldPreview label="Function" value={prepared.request.functionName} />
              <FieldPreview label="termsCommitment" value={prepared.request.args[2] as string} />
              <FieldPreview label="provider" value={prepared.request.args[0] as string} />
              <FieldPreview label="attestor" value={prepared.request.args[1] as string} />
              <FieldPreview label="budgetAtomic" value={String(prepared.request.args[3])} />
              <FieldPreview label="expiresAt" value={String(prepared.request.args[4])} />

              <div style={{ border: '1px solid #8b6914', borderRadius: 8, padding: 12, marginTop: 12 }}>
                <p style={{ fontSize: 13, marginTop: 0 }}>Create an encrypted seven-day handoff link. The server stores only AES-GCM ciphertext; the decryption key stays in the URL fragment and must be shared only with the selected provider and attestor. A plaintext download remains available solely as an offline recovery backup.</p>
                <button type="button" onClick={handleCreateTermsHandoff} disabled={handoffBusy}>
                  {handoffBusy ? 'Encrypting and storing…' : fundingHash ? 'Create funded terms handoff link' : 'Create terms handoff link'}
                </button>
                {termsHandoffLink && <div style={{ marginTop: 10 }}>
                  <label htmlFor="terms-handoff-link" className="muted">Private capability link (contains the decryption key)</label>
                  <textarea id="terms-handoff-link" readOnly value={termsHandoffLink} rows={3} style={{ width: '100%' }} />
                </div>}
                {fundingHash && !termsHandoffLink && <DisabledNotice reason="Funding is finalized. Create a new funded handoff link before the provider continues." />}
                <button type="button" onClick={() => {
                  try {
                    const bundle = makePrivateTermsBundle(buildTerms(), salt,
                      observedJobId && fundingHash ? { jobId: observedJobId, fundingTx: fundingHash } : undefined);
                    if (bundle.commitment.toLowerCase() !== prepared.termsCommitment.toLowerCase()) throw new Error('TERMS_CHANGED_REPREPARE');
                    downloadPrivateBundle(`xyx-private-terms-${bundle.commitment.slice(2, 10)}.json`, bundle);
                    setExportedTermsCommitment(bundle.commitment);
                  } catch (error) { setTermsError(error instanceof Error ? error.message : 'BUNDLE_EXPORT_FAILED'); }
                }} style={{ marginLeft: 8 }}>{fundingHash ? 'Download funded recovery backup' : 'Download recovery backup'}</button>
              </div>

              {observedJobId === null && <button type="button" onClick={handleBroadcastProposal} disabled={busy || !isReady() || !buyer || exportedTermsCommitment !== prepared.termsCommitment}
                style={{ padding: '10px 22px', marginTop: 14 }}>
                {busy ? 'Waiting for wallet / finality…' : 'Propose job with connected buyer wallet'}
              </button>}
              {observedJobId === null && exportedTermsCommitment !== prepared.termsCommitment &&
                <DisabledNotice reason="Create the encrypted handoff link or save the exact recovery backup before proposing the job" />}

              {observedJobId !== null && (
                <div style={{ marginTop: 14 }}>
                  <FieldPreview label="Observed finalized job ID" value={observedJobId.toString()} />
                  <FieldPreview label="Observed status" value={['Proposed', 'Accepted', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired', 'Cancelled'][observedJob?.status ?? 0]} />
                  <button type="button" onClick={() => readObservedJob(observedJobId).catch(error => setTermsError(error instanceof Error ? error.message : 'JOB_READ_FAILED'))} disabled={busy}>Refresh finalized job</button>
                  {observedJob?.status === 0 && observedJob.buyer.toLowerCase() === buyer?.toLowerCase() && (
                    <button type="button" onClick={handleCancelProposal} disabled={busy} style={{ marginLeft: 8 }}>
                      Cancel proposed job with buyer wallet
                    </button>
                  )}
                </div>
              )}

              <div style={{ borderTop: '1px solid #334337', marginTop: 14, paddingTop: 14 }}>
                <div className="eyebrow" style={{ marginBottom: 8 }}>FUNDING</div>
                <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                  Preparing a request never funds anything. A job ID exists only after a real
                  broadcast and a finalized receipt, and the protocol assigns it in{' '}
                  <span className="mono">proposeJob</span>.
                </p>
                {observedJob && <FieldPreview label="Token allowance (atomic)" value={allowance?.toString() ?? 'not observed'} />}
                {observedJob && <FieldPreview label="Token balance (atomic)" value={balance?.toString() ?? 'not observed'} />}
                <button
                  type="button"
                  onClick={handleApproveOrFund}
                  disabled={!fundingAvailable}
                  aria-disabled={!fundingAvailable}
                  style={{
                    padding: '10px 22px', borderRadius: 8, border: 'none',
                    background: fundingAvailable ? '#bcfa73' : '#334337',
                    color: fundingAvailable ? '#0b1611' : '#5a6e5e',
                    fontWeight: 600, cursor: fundingAvailable ? 'pointer' : 'not-allowed', fontSize: 14,
                  }}
                >
                  {allowance !== null && observedJob && allowance >= observedJob.budget ? 'Fund escrow' : 'Approve exact budget'}
                </button>
                {!fundingAvailable && <DisabledNotice reason="Funding is available only after a real finalized proposal and provider acceptance, with the buyer wallet connected." />}
              </div>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
              Build the request to inspect the exact call these terms commit to. No request has been
              built yet.
            </p>
          )}
        </>
      )}

      {termsError && step === 'terms' && (
        <ErrorSummary errors={[termsError]} />
      )}
      {tx.state !== 'idle' && (
        <div style={{ marginTop: 16 }}>
          <StatusBadge state={tx.state === 'finalized' ? 'FINALIZED' : tx.state === 'failed' || tx.state === 'reverted' ? 'FAILED' : tx.state === 'conflict' ? 'CONFLICT' : 'PENDING_FINALITY'} details={tx.state} />
          {tx.hash && <p className="mono">Transaction hash: {tx.hash}</p>}
          {tx.state === 'finalized' && <ExplorerLink hash={tx.hash} label="Verified transaction" />}
          {tx.error && <p style={{ color: '#ff9e9e' }}>{tx.error}</p>}
        </div>
      )}
    </SectionCard>
  );
}
