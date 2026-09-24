/**
 * Canonical secondary RPC resolution (Monad Testnet).
 *
 * `XYX_SECONDARY_RPC_URL` — the variable documented in `.env.example`, which is
 * the source of truth for environment configuration — is the ONLY name that may
 * designate the independent observation endpoint. A second endpoint is what makes
 * "the refund happened" a two-node claim rather than one node's story, so the
 * resolver refuses to guess: it reads this one variable and fails closed with a
 * stable code when the value is absent, malformed, unsafe, or identical to the
 * primary. It never falls back to a legacy variable, to the primary RPC, or to a
 * public default, because a one-endpoint mode cannot be distinguished from an
 * endpoint replaying stale state.
 *
 * @module @xyx/monad/observation-rpc
 */

import { normalizeEndpoint } from './deployment-readiness';

/** The canonical environment variable naming the independent observation RPC. */
export const SECONDARY_RPC_ENV_VAR = 'XYX_SECONDARY_RPC_URL';

/**
 * Stable, machine-readable failure codes. Callers match on these, so they are
 * part of this module's contract and must not be renamed or reworded.
 */
export type ObservationRpcErrorCode =
  | 'MISSING_XYX_SECONDARY_RPC_URL'
  | 'INVALID_XYX_SECONDARY_RPC_URL'
  | 'UNSAFE_XYX_SECONDARY_RPC_URL'
  | 'RPC_NOT_DISTINCT';

/**
 * A resolution refusal.
 *
 * The message is deliberately the code and nothing else: an unsafe URL may carry
 * credentials, so no failure text may ever echo the value that was rejected.
 */
export class ObservationRpcError extends Error {
  readonly code: ObservationRpcErrorCode;
  constructor(code: ObservationRpcErrorCode) {
    super(code);
    this.name = 'ObservationRpcError';
    this.code = code;
  }
}

/**
 * Resolve the independent observation RPC.
 *
 * @param primary the broadcast endpoint the secondary must differ from
 * @param env     environment to read; defaults to `process.env`
 * @returns the secondary endpoint, unmodified
 * @throws {@link ObservationRpcError} with a stable code, never a URL
 */
export function resolveObservationRpcUrl(
  primary: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[SECONDARY_RPC_ENV_VAR];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ObservationRpcError('MISSING_XYX_SECONDARY_RPC_URL');
  }
  if (!/^https?:\/\//.test(value)) {
    throw new ObservationRpcError('INVALID_XYX_SECONDARY_RPC_URL');
  }
  // A URL with embedded credentials or a query token must never be used: the
  // endpoint would travel in logs and process listings with its secret attached.
  if (/^[a-z]+:\/\/[^/]*@/.test(value) || value.includes('?')) {
    throw new ObservationRpcError('UNSAFE_XYX_SECONDARY_RPC_URL');
  }
  // Same normalization the readiness harness uses, so a trailing slash or a
  // scheme/host difference the harness would not treat as two endpoints cannot
  // pass here as "independent" either.
  if (normalizeEndpoint(value) === normalizeEndpoint(primary)) {
    throw new ObservationRpcError('RPC_NOT_DISTINCT');
  }
  return value;
}
