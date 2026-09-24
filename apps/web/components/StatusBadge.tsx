'use client';

/**
 * Shared status badge with accessible text labels.
 * Never uses color alone to convey state.
 */

import type { ReactNode } from 'react';

export type TxLifecycleState =
  | 'idle'
  | 'draft'
  | 'browser_prompt'
  | 'submitted'
  | 'pending_finality'
  | 'finalized'
  | 'user_cancelled'
  | 'reverted'
  | 'conflict'
  | 'failed';

export type StatusState =
  | 'CONFIGURATION_REQUIRED'
  | 'WRONG_NETWORK'
  | 'READY'
  | 'AWAITING_PASSKEY'
  | 'SUBMITTED'
  | 'PENDING_FINALITY'
  | 'FINALIZED'
  | 'UNVERIFIED'
  | 'LIVE_VERIFIED'
  | 'CONFLICT'
  | 'FAILED';

export const STATUS_STYLE: Record<string, { bg: string; border: string; text: string; label: string }> = {
  CONFIGURATION_REQUIRED: { bg: '#1a1520', border: '#5c3d6e', text: '#c9a0dc', label: 'Configuration required' },
  WRONG_NETWORK:        { bg: '#1a1510', border: '#8b6914', text: '#f2d484', label: 'Wrong network' },
  READY:                { bg: '#15251c', border: '#334337', text: '#a8bdab', label: 'Ready' },
  AWAITING_PASSKEY:     { bg: '#152520', border: '#2d5a3d', text: '#6ee89a', label: 'Awaiting passkey' },
  SUBMITTED:            { bg: '#152030', border: '#2a4a7a', text: '#7ab4f2', label: 'Submitted' },
  PENDING_FINALITY:     { bg: '#152030', border: '#2a4a7a', text: '#7ab4f2', label: 'Pending finality' },
  FINALIZED:            { bg: '#15251c', border: '#2d5a3d', text: '#bcfa73', label: 'Finalized' },
  UNVERIFIED:           { bg: '#1a1510', border: '#5c4a2e', text: '#c9a050', label: 'Unverified' },
  CONFLICT:             { bg: '#1a1212', border: '#7a2e2e', text: '#ff9e9e', label: 'Conflict' },
  FAILED:               { bg: '#1a1212', border: '#7a2e2e', text: '#ff9e9e', label: 'Failed' },
};

export function txToStatus(tx: TxLifecycleState): StatusState {
  switch (tx) {
    case 'idle': return 'READY';
    case 'draft': return 'SUBMITTED';
    case 'browser_prompt': return 'SUBMITTED';
    case 'submitted': return 'SUBMITTED';
    case 'pending_finality': return 'PENDING_FINALITY';
    case 'finalized': return 'FINALIZED';
    case 'user_cancelled': return 'FAILED';
    case 'reverted': return 'FAILED';
    case 'conflict': return 'CONFLICT';
    case 'failed': return 'FAILED';
    default: return 'UNVERIFIED';
  }
}

export function StatusBadge({ state, details }: { state: string; details?: string }) {
  const style = STATUS_STYLE[state] ?? STATUS_STYLE.READY;
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 14px',
        borderRadius: 99,
        border: `1px solid ${style.border}`,
        background: style.bg,
        color: style.text,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        letterSpacing: '.04em',
      }}
    >
      <span aria-hidden="true" style={{
        width: 8, height: 8, borderRadius: '50%',
        background: style.text, opacity: 0.7,
      }} />
      {style.label}
      {details && <span style={{ opacity: 0.8 }}>· {details}</span>}
    </span>
  );
}

export function ErrorSummary({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div
      role="alert"
      style={{
        border: '1px solid #7a2e2e',
        borderRadius: 12,
        padding: 18,
        background: '#1a1212',
        color: '#ff9e9e',
      }}
    >
      <strong style={{ display: 'block', marginBottom: 8 }}>Configuration errors:</strong>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {errors.map((e, i) => <li key={i}>{e}</li>)}
      </ul>
    </div>
  );
}

export function DisabledNotice({ reason }: { reason: string }) {
  if (!reason) return null;
  return (
    <p className="muted" style={{ fontSize: 13, marginTop: 6 }} aria-live="polite">
      Disabled: {reason}
    </p>
  );
}

export function ExplorerLink({ hash, label, disabled }: { hash?: string; label: string; disabled?: boolean }) {
  const url = hash ? `https://testnet.monadvision.com/tx/${hash}` : undefined;
  if (!url || !hash || disabled) {
    return <span className="muted mono" style={{ fontSize: 12 }}>{label}: not available</span>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mono"
      style={{ fontSize: 12 }}
      aria-label={`${label} on MonadVision Testnet explorer`}
    >
      {label}: {hash.slice(0, 12)}...{hash.slice(-8)} ↗
    </a>
  );
}

export function SectionCard({ title, eyebrow, children, style: extra }: { title: string; eyebrow?: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <section aria-labelledby={title.replace(/\s/g, '-').toLowerCase()} style={{
      border: '1px solid #334337',
      borderRadius: 14,
      padding: 24,
      background: '#15251c',
      marginBottom: 20,
      ...extra,
    }}>
      {eyebrow && <div className="eyebrow" style={{ marginBottom: 8 }}>{eyebrow}</div>}
      <h2 id={title.replace(/\s/g, '-').toLowerCase()} style={{ margin: '0 0 14px', fontSize: 18 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function FieldPreview({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0' }}>
      <span className="muted">{label}</span>
      <span className="mono" style={{ fontSize: 12 }}>{value}</span>
    </div>
  );
}
