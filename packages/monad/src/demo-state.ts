/**
 * Demo presentation state.
 *
 * The `/demo` page must never present a manifest claim as an on-chain fact.
 * These helpers hold that invariant in one tested place so the page can stay a
 * thin renderer: a claimed outcome and an observed chain status are separate
 * values, and a terminal observed status is only reachable from a valid
 * finalized observation.
 *
 * @module demo-state
 */

import type { Address } from 'viem';
import { isNonZeroAddress } from './config';
import type { SettlementOutcome, SettlementState } from './settlement';
import type { VerificationCategory } from './verification';

/** Statuses the demo may render as an observed on-chain state. */
export type ObservedStatus = 'Completed' | 'Rejected' | 'Expired' | 'Pending settlement' | 'Unavailable';

/** Rendered whenever no valid finalized observation backs the row. */
export const UNAVAILABLE: ObservedStatus = 'Unavailable';

/** Server configuration the demo needs before it may read the chain at all. */
export interface DemoConfiguration {
  protocol: Address;
  token: Address;
  rpcUrl: string;
}

/**
 * Resolve the demo's server configuration.
 *
 * Missing, malformed, and zero addresses all yield `undefined`, so the caller
 * renders the configuration-required state instead of creating an RPC client
 * that could not produce a meaningful read.
 */
export function resolveDemoConfiguration(
  env: Record<string, string | undefined>,
): DemoConfiguration | undefined {
  const rawProtocol = env.XYX_PROTOCOL_ADDRESS;
  const rawToken = env.XYX_PAYMENT_TOKEN_ADDRESS;
  const rawRpc = env.XYX_RPC_URL;

  const protocol = isNonZeroAddress(rawProtocol) ? rawProtocol : undefined;
  const token = isNonZeroAddress(rawToken) ? rawToken : undefined;
  const rpcUrl = typeof rawRpc === 'string' && rawRpc.trim().length > 0 ? rawRpc : undefined;

  if (!protocol || !token || !rpcUrl) return undefined;
  return { protocol, token, rpcUrl };
}

/**
 * Map a settlement result onto an observed chain status.
 *
 * Terminal labels ('Completed' / 'Rejected' / 'Expired') are reachable only
 * from a state that confirms the outcome on-chain. Every other combination —
 * including a successful read whose outcome does not match — renders as
 * 'Unavailable' rather than inventing a status.
 */
export function observedStatusFor(
  state: SettlementState,
  outcome: SettlementOutcome | undefined,
): ObservedStatus {
  if (state === 'PENDING') return 'Pending settlement';
  if (state === 'REJECT') return 'Rejected';
  if (state === 'LIVE_VERIFIED') {
    if (outcome === 'COMPLETE') return 'Completed';
    if (outcome === 'REJECT') return 'Rejected';
    if (outcome === 'EXPIRED') return 'Expired';
  }
  return UNAVAILABLE;
}

/** A single demo row, keeping the manifest claim apart from chain observation. */
export interface DemoRunRow {
  name: string;
  /** What the published manifest asserts. Never presented as chain state. */
  claimedOutcome: string;
  /** Only ever populated from a valid finalized on-chain observation. */
  observedStatus: ObservedStatus;
  verification: VerificationCategory;
  proof: string;
}

/**
 * Build a row for a run whose verification threw or was never attempted.
 *
 * The claimed outcome survives as a claim; the observed status is forced to
 * 'Unavailable' so no manifest assertion can be promoted into a chain status.
 */
export function unverifiedRunRow(
  name: string,
  claimedOutcome: string,
  verification: VerificationCategory,
  proof: string,
): DemoRunRow {
  return { name, claimedOutcome, observedStatus: UNAVAILABLE, verification, proof };
}

/** Outcomes the canonical manifest schema can produce for a terminal run. */
const CANONICAL_OUTCOMES = ['COMPLETE', 'REJECT', 'EXPIRED'] as const;

/**
 * Whether a run's transaction may be rendered as a live explorer link.
 *
 * The link is only honest when canonical dual-RPC settlement verification has
 * positively verified the transaction itself: `LIVE_VERIFIED` means two
 * independent nodes returned the same finalized receipt and the same
 * commitments, and `REJECT` means the same receipt/event pair proved the
 * protocol's own rejection. Nothing else is a verified transaction — not a hash
 * in a manifest, which is a claim; not `PENDING`, `UNVERIFIED`, or `CONFLICT`;
 * not a missing configuration, a malformed manifest, an RPC error, or a missing
 * receipt.
 *
 * `claimedOutcome` selects which transaction the answer is about. An expiry
 * claim is settled by `claimExpiryRefund`, whose verification only ever returns
 * `LIVE_VERIFIED` — the resolution transaction of a verdict run is not the refund
 * transaction — so a `REJECT` on an expiry claim verifies nothing linkable.
 *
 * @param verification   observed verification state; absent means unverified
 * @param claimedOutcome what the published manifest asserts about the run
 */
export function canShowVerifiedExplorerTransaction(
  verification: VerificationCategory | undefined,
  claimedOutcome: string | undefined,
): boolean {
  if (verification === undefined) return false;
  if (!CANONICAL_OUTCOMES.includes(claimedOutcome as (typeof CANONICAL_OUTCOMES)[number])) return false;
  if (verification === 'LIVE_VERIFIED') return true;
  if (verification === 'REJECT') return claimedOutcome !== 'EXPIRED';
  return false;
}
