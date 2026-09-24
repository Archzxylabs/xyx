'use client';

/**
 * ProtocolConfigurationGate
 *
 * Parses public env/config, validates syntax, and confirms on-chain readiness.
 * Renders UNVERIFIED state with specific missing prerequisites when config is absent or invalid.
 * Disables sensitive controls and explains why.
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '../hooks/useConfig';
import { StatusBadge, ErrorSummary, SectionCard, DisabledNotice, FieldPreview } from './StatusBadge';
import type { StatusState } from './StatusBadge';

export default function ProtocolConfigurationGate({ children }: { children: (ready: boolean) => React.ReactNode }) {
  const { config, configStatus, verifyOnChain, isReady, paymentTokenConfigured } = useConfig();
  const [verifying, setVerifying] = useState(false);
  const [onChainStatus, setOnChainStatus] = useState(configStatus);

  useEffect(() => {
    setOnChainStatus(configStatus);
  }, [configStatus]);

  const runVerification = useCallback(async () => {
    setVerifying(true);
    try {
      const result = await verifyOnChain();
      setOnChainStatus(result);
    } finally {
      setVerifying(false);
    }
  }, [verifyOnChain]);

  const ready = isReady();

  const configState: StatusState = !config
    ? 'CONFIGURATION_REQUIRED'
    : onChainStatus.errors.some((e: string) => e.includes('chain ID') || e.includes('RPC'))
      ? 'WRONG_NETWORK'
      : ready
        ? 'READY'
        : 'UNVERIFIED';

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '36px 24px 100px' }}>
      <a
        href="#main-content"
        style={{
          position: 'absolute', left: -9999, top: 'auto',
          width: 1, height: 1, overflow: 'hidden',
        }}
      >
        Skip to main content
      </a>

      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 24, marginBottom: 40, flexWrap: 'wrap',
      }}>
        <a href="/" style={{ fontWeight: 900, fontSize: 28, letterSpacing: '-.08em', color: '#ecf4e9' }}>
          XYX
        </a>
        <StatusBadge state={configState} details={ready ? 'Testnet verified' : undefined} />
      </header>

      <SectionCard title="Protocol configuration" eyebrow="PUBLIC CONFIGURATION">
        <p className="muted" style={{ marginBottom: 16 }}>
          XYX requires public protocol, registry, P256 verifier, and RP ID configuration
          before any transaction control is enabled. Every value below is public.
        </p>

        {!config ? (
          <div role="status" aria-live="polite" style={{
            border: '1px solid #5c3d6e', borderRadius: 12, padding: 18, background: '#1a1520',
          }}>
            <strong style={{ color: '#c9a0dc' }}>Configuration required</strong>
            <p className="muted" style={{ marginTop: 8 }}>
              Set the following environment variables to enable the reference flow:
            </p>
            <ul className="mono muted" style={{ margin: '12px 0', paddingLeft: 20, fontSize: 13 }}>
              <li>NEXT_PUBLIC_XYX_CHAIN_ID=10143</li>
              <li>NEXT_PUBLIC_XYX_PROTOCOL_ADDRESS=0x...</li>
              <li>NEXT_PUBLIC_XYX_REGISTRY_ADDRESS=0x...</li>
              <li>NEXT_PUBLIC_XYX_P256_VERIFIER_ADDRESS=0x...</li>
              <li>NEXT_PUBLIC_XYX_RP_ID=app.example.com</li>
              <li>NEXT_PUBLIC_XYX_RPC_URL=https://... (public primary endpoint)</li>
              <li>NEXT_PUBLIC_XYX_SECONDARY_RPC_URL=https://... (independent public endpoint)</li>
              <li>NEXT_PUBLIC_XYX_PAYMENT_TOKEN_ADDRESS=0x... (required)</li>
            </ul>
            <p className="muted" style={{ fontSize: 12 }}>
              All NEXT_PUBLIC_* values are public. Never name a secret with this prefix.
            </p>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
              <FieldPreview label="Chain ID" value={String(onChainStatus.config?.chainId ?? config.chainId)} />
              <FieldPreview label="Protocol" value={config.protocolAddress} />
              <FieldPreview label="Registry" value={config.registryAddress} />
              <FieldPreview label="P256 Verifier" value={config.p256VerifierAddress} />
              <FieldPreview label="RP ID" value={config.rpId} />
              <FieldPreview label="RPC URL" value={config.rpcUrl} />
              <FieldPreview label="Secondary RPC URL" value={config.secondaryRpcUrl ?? 'not configured'} />
              <FieldPreview label="Secondary chain ID" value={onChainStatus.secondaryObservedChainId === null || onChainStatus.secondaryObservedChainId === undefined ? 'not observed' : String(onChainStatus.secondaryObservedChainId)} />
              <FieldPreview label="Payment Token" value={paymentTokenConfigured ? (config.paymentTokenAddress ?? 'not set') : 'not configured'} />
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              <button
                type="button"
                onClick={runVerification}
                disabled={verifying}
                style={{
                  padding: '8px 18px', borderRadius: 8, border: '1px solid #334337',
                  background: '#1a2e22', color: '#a8bdab', cursor: verifying ? 'wait' : 'pointer',
                  fontSize: 14,
                }}
              >
                {verifying ? 'Verifying on-chain...' : 'Verify on Monad Testnet'}
              </button>
            </div>

            <ErrorSummary errors={onChainStatus.errors} />

            {onChainStatus.observedChainId !== null && (
              <DisabledNotice reason={onChainStatus.chainValid ? '' : `Observed chain ID ${onChainStatus.observedChainId ?? 'unknown'}, expected 10143`} />
            )}
          </>
        )}
      </SectionCard>

      <div id="main-content" style={{ marginTop: 8 }}>
        {ready ? children(true) : (
          <SectionCard title="Protocol boundary" eyebrow="READ ONLY">
            <p className="muted" style={{ marginBottom: 12 }}>
              The controls below require verified protocol configuration. Until then,
              this page is read-only.
            </p>
            {children(false)}
          </SectionCard>
        )}
      </div>
    </main>
  );
}
