'use client';

/** Real browser passkey + wallet flow. No placeholder key, assertion, hash, or receipt. */

import { useCallback, useState } from 'react';
import { type Address, type Hex } from 'viem';
import { SectionCard, FieldPreview, DisabledNotice, ErrorSummary, StatusBadge, ExplorerLink } from './StatusBadge';
import { useConfig } from '../hooks/useConfig';
import { useTx } from '../hooks/useTx';
import { connectWallet, executeBrowserTransaction } from '../lib/browser-transaction';
import { createNativePasskey, assertNativePasskey } from '../../../packages/monad/src/native-passkey';
import { createMonadClient, buildResolveRequest } from '../../../packages/monad/src/delivery-chain';
import { buildVerdict, hashVerdict, toSolidityVerdict, createEvidenceCommitment, createReasonCommitment,
  type PrivateEvidenceInput, type PrivateReasonInput } from '../../../packages/monad/src/delivery';
import { passkeyRegistryAbi, deliveryProtocolAbi, type PasskeyCredential } from '../../../packages/monad/src/protocol';
import { finalizedBlock, matchedCanonicalJob, viemPublicClientToCanonicalChainReader } from '../../../packages/monad/src/canonical-chain';
import { verifySettlement } from '../../../packages/monad/src/settlement';
import { generateSalt } from '../../../packages/monad/src/commitments';
import { downloadPrivateBundle, parsePrivateTermsBundle, parsePrivateDeliveryBundle, taskTransferFromTerms,
  type PrivateTermsBundle, type PrivateDeliveryBundle } from '../lib/private-terms-bundle';
import { reviewTaskEvidence, type TaskEvidence } from '../lib/task-evidence';
import { readSecureHandoff } from '../lib/secure-handoff';

const WORD = /^0x[0-9a-fA-F]{64}$/;
const ZERO_WORD = `0x${'0'.repeat(64)}`;

interface ReviewedVerdict {
  facts: TaskEvidence;
  decision: 1 | 2;
  evidence: PrivateEvidenceInput;
  reason: PrivateReasonInput;
  evidenceSalt: Hex;
  reasonSalt: Hex;
  evidenceCommitment: Hex;
  reasonCommitment: Hex;
}

export default function AttestorPasskeyPanel() {
  const { config, isReady } = useConfig();
  const tx = useTx();
  const [wallet, setWallet] = useState<Address | null>(null);
  const [credential, setCredential] = useState<PasskeyCredential | null>(null);
  const [jobId, setJobId] = useState('');
  const [decision, setDecision] = useState<1 | 2>(1);
  const [termsBundle, setTermsBundle] = useState<PrivateTermsBundle | null>(null);
  const [deliveryBundle, setDeliveryBundle] = useState<PrivateDeliveryBundle | null>(null);
  const [termsHandoffLink, setTermsHandoffLink] = useState('');
  const [deliveryHandoffLink, setDeliveryHandoffLink] = useState('');
  const [rationale, setRationale] = useState('');
  const [review, setReview] = useState<ReviewedVerdict | null>(null);
  const [exportedReviewDigest, setExportedReviewDigest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secure = typeof window !== 'undefined' && window.isSecureContext;

  const readers = useCallback(() => {
    if (!config?.secondaryRpcUrl) throw new Error('SECONDARY_RPC_URL_MISSING');
    return {
      primary: viemPublicClientToCanonicalChainReader(createMonadClient(config.rpcUrl)),
      secondary: viemPublicClientToCanonicalChainReader(createMonadClient(config.secondaryRpcUrl)),
    };
  }, [config]);

  const sameFinalizedBlock = useCallback(async () => {
    const { primary, secondary } = readers();
    if (await primary.getChainId() !== 10143 || await secondary.getChainId() !== 10143) throw new Error('RPC_WRONG_CHAIN');
    const [first, second] = await Promise.all([finalizedBlock(primary), finalizedBlock(secondary)]);
    const number = first.number < second.number ? first.number : second.number;
    const [a, b] = await Promise.all([primary.getBlock({ blockNumber: number }), secondary.getBlock({ blockNumber: number })]);
    if (!a.hash || a.hash !== b.hash || a.timestamp !== b.timestamp) throw new Error('RPC_FINALITY_MISMATCH');
    return { primary, secondary, number, timestamp: a.timestamp };
  }, [readers]);

  const readCredential = useCallback(async (owner: Address): Promise<PasskeyCredential> => {
    if (!config) throw new Error('CONFIG_REQUIRED');
    const { primary, secondary, number } = await sameFinalizedBlock();
    const args = { address: config.registryAddress, abi: passkeyRegistryAbi, functionName: 'credentialOf', args: [owner], blockNumber: number };
    const [first, second] = await Promise.all([primary.readContract(args), secondary.readContract(args)]);
    const a = first as PasskeyCredential;
    const b = second as PasskeyCredential;
    if (a.exists !== b.exists || a.credentialIdCommitment?.toLowerCase() !== b.credentialIdCommitment?.toLowerCase() ||
        a.qx?.toLowerCase() !== b.qx?.toLowerCase() || a.qy?.toLowerCase() !== b.qy?.toLowerCase() || a.signCount !== b.signCount) {
      throw new Error('RPC_CREDENTIAL_MISMATCH');
    }
    setCredential(a);
    return a;
  }, [config, sameFinalizedBlock]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      const address = await connectWallet();
      setWallet(address);
      await readCredential(address);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'WALLET_CONNECT_FAILED'); }
  }, [readCredential]);

  const handleRegister = useCallback(async () => {
    if (!config || !wallet || !isReady() || !secure || credential?.exists || busy) return;
    setBusy(true); setError(null); tx.reset();
    try {
      const created = await createNativePasskey(config.rpId, `XYX attestor ${wallet.slice(0, 8)}`);
      const { primary, secondary, number } = await sameFinalizedBlock();
      const args = [wallet, created.credentialIdCommitment, created.qx, created.qy] as const;
      const read = { address: config.registryAddress, abi: passkeyRegistryAbi, functionName: 'registrationChallenge', args, blockNumber: number };
      const [a, b] = await Promise.all([primary.readContract(read), secondary.readContract(read)]);
      if (typeof a !== 'string' || !WORD.test(a) || a !== b) throw new Error('RPC_REGISTRATION_CHALLENGE_MISMATCH');
      const assertion = await assertNativePasskey(config.rpId, a as Hex, created.credentialIdCommitment, created.credentialId);
      const request = {
        abi: passkeyRegistryAbi,
        address: config.registryAddress,
        functionName: 'registerCredential',
        args: [created.credentialIdCommitment, created.qx, created.qy, assertion],
        from: wallet,
      };
      const outcome = await executeBrowserTransaction(config, request, `register:${wallet}`, { onWalletPrompt: tx.toPrompt, onSubmitted: tx.toSubmitted });
      if (outcome.status === 'pending') return;
      if (outcome.status === 'reverted') { tx.toReverted('PASSKEY_REGISTRATION_REVERTED'); return; }
      const onChain = await readCredential(wallet);
      if (!onChain.exists || onChain.credentialIdCommitment.toLowerCase() !== created.credentialIdCommitment.toLowerCase() ||
          onChain.qx.toLowerCase() !== created.qx.toLowerCase() || onChain.qy.toLowerCase() !== created.qy.toLowerCase()) {
        tx.toConflict('PASSKEY_REGISTRATION_STATE_MISMATCH'); return;
      }
      tx.toFinalized({ blockNumber: outcome.receipt.blockNumber, status: 'success' });
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : 'PASSKEY_REGISTRATION_FAILED';
      if (code === 'USER_REJECTED') tx.toCancelled();
      else if (code.includes('MISMATCH') || code.startsWith('RPC_') || code.startsWith('OPERATION_') || code.startsWith('SUBMISSION_UNCERTAIN')) tx.toConflict(code);
      else tx.toFailed(code);
      setError(code);
    } finally { setBusy(false); }
  }, [config, wallet, isReady, secure, credential, busy, tx, sameFinalizedBlock, readCredential]);

  const handleReview = useCallback(async () => {
    if (!config || !termsBundle || !deliveryBundle || !/^[1-9]\d*$/.test(jobId) || !rationale.trim()) return;
    setBusy(true); setReview(null); setExportedReviewDigest(null); setError(null);
    try {
      const id = BigInt(jobId);
      const facts = await reviewTaskEvidence(config, id, termsBundle, deliveryBundle);
      if (decision === 1 && !facts.matchesTerms) throw new Error('COMPLETE_BLOCKED_BY_TASK_TRANSFER_MISMATCH');
      const expected = taskTransferFromTerms(termsBundle.terms);
      const evidence: PrivateEvidenceInput = { schema: 'xyx.private-evidence', artifacts: {
        fundingTx: facts.fundingTx, transferTx: facts.transferTx, submissionTx: facts.submissionTx,
        fundingBlock: facts.fundingBlock.toString(), transferBlock: facts.transferBlock.toString(),
        submissionBlock: facts.submissionBlock.toString(), expectedToken: config.paymentTokenAddress!,
        expectedRecipient: expected.recipient, expectedAmountAtomic: expected.amountAtomic.toString(),
        observedRecipient: facts.observedTransferTo, observedAmountAtomic: facts.observedTransferAmount,
        transferMatchesTerms: facts.matchesTerms, failureCode: facts.failureCode,
      } };
      const reason: PrivateReasonInput = { schema: 'xyx.private-reason',
        decision: decision === 1 ? 'complete' : 'reject',
        notes: { rationale: rationale.trim(), transferFailureCode: facts.failureCode } };
      const evidenceSalt = generateSalt(32);
      const reasonSalt = generateSalt(32);
      const evidenceCommitment = createEvidenceCommitment(id, evidence, evidenceSalt).commitment;
      const reasonCommitment = createReasonCommitment(id, reason, reasonSalt).commitment;
      setReview({ facts, decision, evidence, reason, evidenceSalt, reasonSalt, evidenceCommitment, reasonCommitment });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'EVIDENCE_REVIEW_FAILED'); }
    finally { setBusy(false); }
  }, [config, termsBundle, deliveryBundle, jobId, rationale, decision]);

  const importHandoff = useCallback(async (kind: 'terms' | 'delivery') => {
    setReview(null); setError(null);
    try {
      const value = await readSecureHandoff(kind === 'terms' ? termsHandoffLink : deliveryHandoffLink, kind);
      if (kind === 'terms') setTermsBundle(parsePrivateTermsBundle(JSON.stringify(value)));
      else setDeliveryBundle(parsePrivateDeliveryBundle(JSON.stringify(value)));
    } catch (cause) {
      if (kind === 'terms') setTermsBundle(null); else setDeliveryBundle(null);
      setError(cause instanceof Error ? cause.message : 'HANDOFF_IMPORT_FAILED');
    }
  }, [termsHandoffLink, deliveryHandoffLink]);

  const handleResolve = useCallback(async () => {
    if (!config?.paymentTokenAddress || !wallet || !credential?.exists || !isReady() || !review ||
        exportedReviewDigest !== `${review.evidenceCommitment}:${review.reasonCommitment}` ||
        !termsBundle || !deliveryBundle || !/^[1-9]\d*$/.test(jobId) || busy) return;
    setBusy(true); setError(null); tx.reset();
    try {
      const { primary, secondary, number, timestamp: finalizedTimestamp } = await sameFinalizedBlock();
      const id = BigInt(jobId);
      const freshFacts = await reviewTaskEvidence(config, id, termsBundle, deliveryBundle);
      if (freshFacts.fundingTx !== review.facts.fundingTx || freshFacts.transferTx !== review.facts.transferTx ||
          freshFacts.submissionTx !== review.facts.submissionTx || freshFacts.matchesTerms !== review.facts.matchesTerms ||
          review.decision !== decision || (decision === 1 && !freshFacts.matchesTerms) ||
          createEvidenceCommitment(id, review.evidence, review.evidenceSalt).commitment !== review.evidenceCommitment ||
          createReasonCommitment(id, review.reason, review.reasonSalt).commitment !== review.reasonCommitment) {
        throw new Error('EVIDENCE_REVIEW_CHANGED');
      }
      const observed = await matchedCanonicalJob(primary, secondary, config.protocolAddress, id);
      if (observed.job.status !== 3 || observed.job.attestor.toLowerCase() !== wallet.toLowerCase()) throw new Error('JOB_NOT_SUBMITTED_FOR_CONNECTED_ATTESTOR');
      if (observed.job.deliveryCommitment.toLowerCase() === ZERO_WORD) throw new Error('DELIVERY_COMMITMENT_MISSING');
      const registered = await readCredential(wallet);
      if (!registered.exists) throw new Error('ATTESTOR_CREDENTIAL_NOT_REGISTERED');
      const lifetimeArgs = { address: config.protocolAddress, abi: deliveryProtocolAbi, functionName: 'maxVerdictLifetime', blockNumber: number };
      const [firstLifetime, secondLifetime] = await Promise.all([primary.readContract(lifetimeArgs), secondary.readContract(lifetimeArgs)]);
      if (typeof firstLifetime !== 'bigint' || firstLifetime !== secondLifetime) throw new Error('RPC_VERDICT_LIFETIME_MISMATCH');
      if (firstLifetime <= 30n) throw new Error('VERDICT_LIFETIME_TOO_SHORT');
      const issuedAt = finalizedTimestamp;
      const expiresAt = [issuedAt + firstLifetime, observed.job.expiresAt - 1n].reduce((a, b) => a < b ? a : b);
      if (expiresAt <= issuedAt + 30n) throw new Error('VERDICT_WINDOW_TOO_SHORT');
      const random = crypto.getRandomValues(new Uint8Array(8));
      const nonce = BigInt(`0x${Array.from(random, value => value.toString(16).padStart(2, '0')).join('')}`);
      const usedArgs = { address: config.protocolAddress, abi: deliveryProtocolAbi, functionName: 'usedNonces', args: [wallet, nonce], blockNumber: number };
      const [usedA, usedB] = await Promise.all([primary.readContract(usedArgs), secondary.readContract(usedArgs)]);
      if (usedA !== false || usedB !== false) throw new Error('VERDICT_NONCE_ALREADY_USED');
      const verdict = buildVerdict({ jobId: id, termsCommitment: observed.job.termsCommitment,
        deliveryCommitment: observed.job.deliveryCommitment, evidenceCommitment: review.evidenceCommitment,
        reasonCommitment: review.reasonCommitment, decision, issuedAt, expiresAt, nonce,
        maxVerdictLifetime: firstLifetime, jobExpiresAt: observed.job.expiresAt, now: issuedAt });
      const solidityVerdict = { ...toSolidityVerdict(verdict), decision };
      const localDigest = hashVerdict(verdict, config.protocolAddress, 10143);
      const onChainHash = { address: config.protocolAddress, abi: deliveryProtocolAbi, functionName: 'hashVerdict', args: [solidityVerdict], blockNumber: number };
      const [digestA, digestB] = await Promise.all([primary.readContract(onChainHash), secondary.readContract(onChainHash)]);
      if (digestA !== localDigest || digestB !== localDigest) throw new Error('VERDICT_DIGEST_MISMATCH');
      const challengeArgs = { address: config.registryAddress, abi: passkeyRegistryAbi, functionName: 'assertionChallenge', args: [config.protocolAddress, wallet, localDigest], blockNumber: number };
      const [challengeA, challengeB] = await Promise.all([primary.readContract(challengeArgs), secondary.readContract(challengeArgs)]);
      if (typeof challengeA !== 'string' || !WORD.test(challengeA) || challengeA !== challengeB) throw new Error('RPC_ACTION_CHALLENGE_MISMATCH');
      const assertion = await assertNativePasskey(config.rpId, challengeA as Hex, registered.credentialIdCommitment);
      const request = buildResolveRequest({ jobId: id, verdict: solidityVerdict, attestor: wallet, assertion }, {
        protocol: config.protocolAddress, registry: config.registryAddress,
        p256Verifier: config.p256VerifierAddress, paymentToken: config.paymentTokenAddress,
      });
      const outcome = await executeBrowserTransaction(config, request, `resolve:${jobId}`, { onWalletPrompt: tx.toPrompt, onSubmitted: tx.toSubmitted });
      if (outcome.status === 'pending') return;
      if (outcome.status === 'reverted') { tx.toReverted('VERDICT_REVERTED'); return; }
      const result = await verifySettlement(primary, secondary, {
        protocol: config.protocolAddress, token: config.paymentTokenAddress, jobId: id,
        verdict: solidityVerdict, resolveTx: outcome.hash,
      });
      if (result.state !== 'LIVE_VERIFIED' || result.outcome !== (decision === 1 ? 'COMPLETE' : 'REJECT')) {
        tx.toConflict('VERDICT_SETTLEMENT_NOT_VERIFIED'); return;
      }
      tx.toFinalized({ blockNumber: outcome.receipt.blockNumber, status: 'success' });
      await readCredential(wallet);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : 'VERDICT_FAILED';
      if (code === 'USER_REJECTED') tx.toCancelled();
      else if (code.includes('MISMATCH') || code.startsWith('RPC_') || code.startsWith('OPERATION_') || code.startsWith('SUBMISSION_UNCERTAIN')) tx.toConflict(code);
      else tx.toFailed(code);
      setError(code);
    } finally { setBusy(false); }
  }, [config, wallet, credential, isReady, jobId, busy, review, exportedReviewDigest, termsBundle, deliveryBundle, decision, tx, sameFinalizedBlock, readCredential]);

  return <SectionCard title="Attestor: register and resolve" eyebrow="ATTESTOR FLOW">
    <p className="muted">A real ES256 passkey and the connected attestor wallet are required. Open the encrypted buyer and provider handoff links; plaintext is decrypted only in this browser. XYX verifies commitments against the finalized job and checks three real receipts. The contract proves authorization and settlement, not objective quality.</p>
    {!secure && <DisabledNotice reason="WebAuthn requires HTTPS or localhost with a secure browser context" />}
    {!isReady() && <DisabledNotice reason="Two-RPC protocol configuration is not verified" />}
    <button type="button" onClick={handleConnect} disabled={!secure || !isReady() || busy}>
      {wallet ? `Attestor wallet: ${wallet.slice(0, 8)}…${wallet.slice(-4)}` : 'Connect attestor wallet'}
    </button>
    {wallet && <div style={{ marginTop: 12 }}>
      <FieldPreview label="On-chain credential" value={credential?.exists ? credential.credentialIdCommitment : 'not registered'} />
      {!credential?.exists && <button type="button" onClick={handleRegister} disabled={busy || !secure || !isReady()} style={{ marginTop: 12 }}>
        Register real passkey on-chain
      </button>}
    </div>}
    <div style={{ marginTop: 22, display: 'grid', gap: 10 }}>
      <label>Submitted job ID <input value={jobId} onChange={event => { setJobId(event.target.value.replace(/[^0-9]/g, '')); setReview(null); }} inputMode="numeric" /></label>
      <label>Buyer encrypted terms link <textarea value={termsHandoffLink} onChange={event => setTermsHandoffLink(event.target.value)} rows={3} /></label>
      <button type="button" onClick={() => importHandoff('terms')} disabled={!termsHandoffLink}>Decrypt buyer terms</button>
      <label>Provider encrypted delivery link <textarea value={deliveryHandoffLink} onChange={event => setDeliveryHandoffLink(event.target.value)} rows={3} /></label>
      <button type="button" onClick={() => importHandoff('delivery')} disabled={!deliveryHandoffLink}>Decrypt provider delivery</button>
      <label>Buyer private terms bundle (including finalized funding receipt) <input type="file" accept="application/json,.json" onChange={async event => {
        setReview(null);
        try { const file = event.target.files?.[0]; if (file) setTermsBundle(parsePrivateTermsBundle(await file.text())); }
        catch (cause) { setTermsBundle(null); setError(cause instanceof Error ? cause.message : 'TERMS_IMPORT_FAILED'); }
      }} /></label>
      <label>Provider private delivery bundle (including finalized submission receipt) <input type="file" accept="application/json,.json" onChange={async event => {
        setReview(null);
        try { const file = event.target.files?.[0]; if (file) setDeliveryBundle(parsePrivateDeliveryBundle(await file.text())); }
        catch (cause) { setDeliveryBundle(null); setError(cause instanceof Error ? cause.message : 'DELIVERY_IMPORT_FAILED'); }
      }} /></label>
      {termsBundle && <FieldPreview label="Imported terms commitment" value={termsBundle.commitment} />}
      {deliveryBundle && <FieldPreview label="Imported delivery commitment" value={deliveryBundle.commitment} />}
      {termsBundle && deliveryBundle && <details><summary>Review private task and delivery content locally</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ task: termsBundle.terms.task, acceptancePolicy: termsBundle.terms.acceptancePolicy, delivery: deliveryBundle.delivery }, null, 2)}</pre>
      </details>}
      <label>Verdict <select value={decision} onChange={event => { setDecision(Number(event.target.value) as 1 | 2); setReview(null); }}><option value={1}>COMPLETE</option><option value={2}>REJECT</option></select></label>
      <label>Attestor rationale <textarea value={rationale} onChange={event => { setRationale(event.target.value); setReview(null); }} rows={3} /></label>
      <button type="button" onClick={handleReview} disabled={!termsBundle || !deliveryBundle || !rationale.trim() || busy || !/^[1-9]\d*$/.test(jobId) || !isReady()}>
        {busy ? 'Verifying finalized receipts…' : 'Verify task evidence on two RPCs'}
      </button>
      {review && <div style={{ border: '1px solid #334337', padding: 14, borderRadius: 8 }}>
        <FieldPreview label="Transfer matches private terms" value={review.facts.matchesTerms ? 'Yes' : `No — ${review.facts.failureCode}`} />
        <FieldPreview label="Funding block" value={review.facts.fundingBlock.toString()} />
        <FieldPreview label="Task transfer block" value={review.facts.transferBlock.toString()} />
        <FieldPreview label="Submission block" value={review.facts.submissionBlock.toString()} />
        <FieldPreview label="Evidence commitment" value={review.evidenceCommitment} />
        <FieldPreview label="Reason commitment" value={review.reasonCommitment} />
        <button type="button" onClick={() => {
          downloadPrivateBundle(`xyx-attestor-evidence-${jobId}.json`, {
            schema: 'xyx.private-attestor-evidence-bundle.v1', jobId, evidence: review.evidence,
            reason: review.reason, evidenceSalt: review.evidenceSalt, reasonSalt: review.reasonSalt,
            evidenceCommitment: review.evidenceCommitment, reasonCommitment: review.reasonCommitment,
          });
          setExportedReviewDigest(`${review.evidenceCommitment}:${review.reasonCommitment}`);
        }}>Download review evidence bundle for audit</button>
      </div>}
      {review && exportedReviewDigest !== `${review.evidenceCommitment}:${review.reasonCommitment}` &&
        <DisabledNotice reason="Initiate export of the exact evidence/reason bundle and verify it is saved before resolving" />}
      <button type="button" onClick={handleResolve} disabled={!credential?.exists || !review || exportedReviewDigest !== `${review?.evidenceCommitment}:${review?.reasonCommitment}` || busy || !/^[1-9]\d*$/.test(jobId) || !isReady()}>
        {busy ? 'Waiting for passkey, wallet, and finality…' : 'Resolve with real passkey and wallet'}
      </button>
    </div>
    {tx.state !== 'idle' && <div style={{ marginTop: 16 }}>
      <StatusBadge state={tx.state === 'finalized' ? 'FINALIZED' : tx.state === 'conflict' ? 'CONFLICT' : tx.state === 'failed' || tx.state === 'reverted' ? 'FAILED' : 'PENDING_FINALITY'} details={tx.state} />
      {tx.hash && <p className="mono">Transaction hash: {tx.hash}</p>}
      {tx.state === 'finalized' && <ExplorerLink hash={tx.hash} label="Verified attestor transaction" />}
      {tx.error && <p style={{ color: '#ff9e9e' }}>{tx.error}</p>}
    </div>}
    {error && <ErrorSummary errors={[error]} />}
  </SectionCard>;
}
