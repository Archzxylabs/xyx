'use client';

/**
 * Reference page — product explanation, configuration gate, role entry points.
 *
 * This is the canonical developer reference surface for XYX on Monad Testnet.
 * All sensitive controls require verified protocol configuration.
 */

import ProtocolConfigurationGate from '../../components/ProtocolConfigurationGate';
import BuyerJobForm from '../../components/BuyerJobForm';
import ProviderAcceptancePanel from '../../components/ProviderAcceptancePanel';
import AttestorPasskeyPanel from '../../components/AttestorPasskeyPanel';
import JobStatePanel from '../../components/JobStatePanel';
import ExpiryRefundPanel from '../../components/ExpiryRefundPanel';

export default function ReferencePage() {
  return (
    <ProtocolConfigurationGate>
      {(ready) => (
        <>
          {!ready && (
            <section aria-labelledby="boundary-heading" style={{ marginTop: 40 }}>
              <h2 id="boundary-heading" style={{ fontSize: 24, marginBottom: 16 }}>
                Protocol boundary
              </h2>
              <div style={{ display: 'grid', gap: 16 }}>
                <div style={{ border: '1px solid #334337', borderRadius: 14, padding: 22, background: '#15251c' }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>Private by construction</h3>
                  <p className="muted">
                    Raw terms, prompts, model inputs/outputs, delivery content, evidence,
                    salts, credential IDs, PRF output, seeds, and keys never enter the chain
                    or browser persistence. Only commitments (keccak-256 hashes) are public.
                  </p>
                </div>
                <div style={{ border: '1px solid #334337', borderRadius: 14, padding: 22, background: '#15251c' }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>Buyer-selected attestor trust</h3>
                  <p className="muted">
                    The buyer chooses the attestor. The provider explicitly accepts that choice
                    before funding. The protocol cannot establish objective correctness of the
                    attestor&apos;s private judgment — it only proves who was selected and that
                    a passkey-backed selected attestor resolved the job.
                  </p>
                </div>
                <div style={{ border: '1px solid #334337', borderRadius: 14, padding: 22, background: '#15251c' }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>Final settlement is irreversible</h3>
                  <p className="muted">
                    Once settled (Completed, Rejected, or Expired), the state cannot change.
                    ERC-20 escrow transfer is atomic. There is no cancellation, pause, or
                    administrator rescue after funding.
                  </p>
                </div>
                <div style={{ border: '1px solid #334337', borderRadius: 14, padding: 22, background: '#15251c' }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>Expiry refund scope</h3>
                  <p className="muted">
                    Expiry refund returns only the escrowed reward to the buyer. It does not
                    reverse any delivery already submitted and does not require an attestor
                    verdict. Attestor absence cannot block expiry.
                  </p>
                </div>
              </div>
            </section>
          )}

          {ready && (
            <>
              <section aria-labelledby="buyer-heading" style={{ marginTop: 40 }}>
                <h2 id="buyer-heading" style={{ fontSize: 24, marginBottom: 16 }}>Buyer flow</h2>
                <BuyerJobForm />
              </section>

              <section aria-labelledby="provider-heading" style={{ marginTop: 40 }}>
                <h2 id="provider-heading" style={{ fontSize: 24, marginBottom: 16 }}>Provider flow</h2>
                <ProviderAcceptancePanel />
              </section>

              <section aria-labelledby="attestor-heading" style={{ marginTop: 40 }}>
                <h2 id="attestor-heading" style={{ fontSize: 24, marginBottom: 16 }}>Attestor flow</h2>
                <AttestorPasskeyPanel />
              </section>

              <section aria-labelledby="state-heading" style={{ marginTop: 40 }}>
                <h2 id="state-heading" style={{ fontSize: 24, marginBottom: 16 }}>Job state reader</h2>
                <JobStatePanel />
              </section>

              <section aria-labelledby="expiry-heading" style={{ marginTop: 40 }}>
                <h2 id="expiry-heading" style={{ fontSize: 24, marginBottom: 16 }}>Expiry refund</h2>
                <ExpiryRefundPanel />
              </section>
            </>
          )}
        </>
      )}
    </ProtocolConfigurationGate>
  );
}
