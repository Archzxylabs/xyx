import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '36px 24px 100px' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 24,
          marginBottom: 60,
          flexWrap: 'wrap',
        }}
      >
        <Link href="/" style={{ fontWeight: 900, fontSize: 28, letterSpacing: '-.08em', color: '#ecf4e9' }}>
          XYX
        </Link>
        <span className="eyebrow">MONAD TESTNET · CHAIN ID 10143</span>
      </header>

      <div className="eyebrow" style={{ color: '#bcfa73', marginBottom: 12 }}>
        DECENTRALIZED WORKFLOW · EVIDENCE BEFORE SETTLEMENT
      </div>
      <h1
        style={{
          fontSize: 'clamp(38px, 6vw, 76px)',
          lineHeight: 1.04,
          maxWidth: 900,
          letterSpacing: '-.06em',
          margin: '0 0 20px',
        }}
      >
        Settlement without secrets.
      </h1>
      <p style={{ maxWidth: 740, fontSize: 19, color: '#b8c5bb', lineHeight: 1.6, marginBottom: 44 }}>
        Private task execution, on-chain commitments, passkey-authorized attestation, and dual-RPC reconciliation on Monad Testnet.
        Every state transition requires cryptographic proof and two independent RPC observations.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, marginBottom: 48 }}>
        <article
          style={{
            border: '1px solid #334337',
            borderRadius: 16,
            padding: 30,
            background: '#15251c',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div className="eyebrow" style={{ color: '#bcfa73', marginBottom: 10 }}>INTERACTIVE PRODUCT FLOW</div>
            <h2 style={{ fontSize: 26, margin: '0 0 14px' }}>Transaction Hub</h2>
            <p className="muted" style={{ marginBottom: 20 }}>
              Connect your wallet or passkey to interact directly with the protocol without JSON editing or operator CLIs:
            </p>
            <ul className="muted" style={{ paddingLeft: 20, margin: '0 0 24px', fontSize: 14, lineHeight: 1.8 }}>
              <li><strong>Buyer:</strong> Propose jobs with private terms commitments, fund USDC escrow.</li>
              <li><strong>Provider:</strong> Accept jobs, perform ERC-20 task transfers, execute ProviderRunner SDK.</li>
              <li><strong>Attestor:</strong> Register WebAuthn P256 passkey, verify dual-RPC evidence, sign EIP-712 verdicts.</li>
              <li><strong>Expiry Refund:</strong> Permissionless escrow reclamation after job deadline.</li>
            </ul>
          </div>
          <Link
            href="/reference"
            style={{
              display: 'inline-block',
              textAlign: 'center',
              padding: '12px 24px',
              borderRadius: 8,
              background: '#bcfa73',
              color: '#0b1611',
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            Launch Transaction Flow →
          </Link>
        </article>

        <article
          style={{
            border: '1px solid #334337',
            borderRadius: 16,
            padding: 30,
            background: '#15251c',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div className="eyebrow" style={{ color: '#bcfa73', marginBottom: 10 }}>CANONICAL AUDIT</div>
            <h2 style={{ fontSize: 26, margin: '0 0 14px' }}>Public Demo</h2>
            <p className="muted" style={{ marginBottom: 20 }}>
              Read-only public verification surface. No credentials, wallet connection, or operator access required:
            </p>
            <ul className="muted" style={{ paddingLeft: 20, margin: '0 0 24px', fontSize: 14, lineHeight: 1.8 }}>
              <li>Audit canonical testnet runs: <code>COMPLETE</code>, <code>REJECT</code>, and <code>EXPIRED</code>.</li>
              <li>Independent dual-RPC reconciliation for every block and receipt.</li>
              <li>Zero fake receipts or simulated badges — unverified state remains unverified.</li>
              <li>Direct verification links to MonadVision block explorer and IPFS gateway.</li>
            </ul>
          </div>
          <Link
            href="/demo"
            style={{
              display: 'inline-block',
              textAlign: 'center',
              padding: '12px 24px',
              borderRadius: 8,
              background: '#1a2e22',
              border: '1px solid #334337',
              color: '#a8bdab',
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            View Canonical Demo →
          </Link>
        </article>
      </div>

      <section aria-labelledby="boundary-heading">
        <h2 id="boundary-heading" style={{ fontSize: 22, marginBottom: 16 }}>
          Protocol Invariants
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          <div style={{ border: '1px solid #233327', borderRadius: 12, padding: 20, background: '#0e1c14' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#ecf4e9' }}>Private by construction</h3>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              Raw terms, prompts, outputs, and salts never touch chain storage or browser persistence. Only Keccak-256 commitments are public.
            </p>
          </div>
          <div style={{ border: '1px solid #233327', borderRadius: 12, padding: 20, background: '#0e1c14' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#ecf4e9' }}>Dual-RPC reconciliation</h3>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              All finality claims require matching receipts and block states from two independent RPC providers. Disagreement fails closed as CONFLICT.
            </p>
          </div>
          <div style={{ border: '1px solid #233327', borderRadius: 12, padding: 20, background: '#0e1c14' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#ecf4e9' }}>Hardware passkey attestation</h3>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              Attestor resolutions require WebAuthn P-256 passkey signatures verified on-chain via <code>MonadP256Verifier</code>.
            </p>
          </div>
          <div style={{ border: '1px solid #233327', borderRadius: 12, padding: 20, background: '#0e1c14' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#ecf4e9' }}>Atomic non-custodial escrow</h3>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              USDC reward is locked in <code>XYXDeliveryProtocol</code>. Settlement to provider or refund to buyer is final and irreversible.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
