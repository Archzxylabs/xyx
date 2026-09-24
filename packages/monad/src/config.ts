import type { Address, Hex } from 'viem';

/**
 * Public environment variable names for XYX protocol configuration.
 * Every NEXT_PUBLIC_* value is baked into the client bundle and treated as public.
 * Never name a secret with this prefix.
 */
export const ENV = {
  CHAIN_ID: 'NEXT_PUBLIC_XYX_CHAIN_ID',
  PROTOCOL_ADDRESS: 'NEXT_PUBLIC_XYX_PROTOCOL_ADDRESS',
  REGISTRY_ADDRESS: 'NEXT_PUBLIC_XYX_REGISTRY_ADDRESS',
  P256_VERIFIER_ADDRESS: 'NEXT_PUBLIC_XYX_P256_VERIFIER_ADDRESS',
  PAYMENT_TOKEN_ADDRESS: 'NEXT_PUBLIC_XYX_PAYMENT_TOKEN_ADDRESS',
  RP_ID: 'NEXT_PUBLIC_XYX_RP_ID',
  RPC_URL: 'NEXT_PUBLIC_XYX_RPC_URL',
  SECONDARY_RPC_URL: 'NEXT_PUBLIC_XYX_SECONDARY_RPC_URL',
} as const;

export const MONAD_TESTNET_CHAIN_ID = 10143;

export interface XYXConfig {
  chainId: number;
  protocolAddress: Address;
  registryAddress: Address;
  p256VerifierAddress: Address;
  paymentTokenAddress?: Address;
  rpId: string;
  rpcUrl: string;
  secondaryRpcUrl?: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The only address that can never be a real deployment. */
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// Next.js only inlines NEXT_PUBLIC_* values when the property access is static.
// Dynamic process.env[name] works in Node but silently becomes undefined in a
// browser bundle, leaving an otherwise configured application unusable.
function readPublicEnv(name: string): string | undefined {
  switch (name) {
    case ENV.CHAIN_ID: return process.env.NEXT_PUBLIC_XYX_CHAIN_ID;
    case ENV.PROTOCOL_ADDRESS: return process.env.NEXT_PUBLIC_XYX_PROTOCOL_ADDRESS;
    case ENV.REGISTRY_ADDRESS: return process.env.NEXT_PUBLIC_XYX_REGISTRY_ADDRESS;
    case ENV.P256_VERIFIER_ADDRESS: return process.env.NEXT_PUBLIC_XYX_P256_VERIFIER_ADDRESS;
    case ENV.PAYMENT_TOKEN_ADDRESS: return process.env.NEXT_PUBLIC_XYX_PAYMENT_TOKEN_ADDRESS;
    case ENV.RP_ID: return process.env.NEXT_PUBLIC_XYX_RP_ID;
    case ENV.RPC_URL: return process.env.NEXT_PUBLIC_XYX_RPC_URL;
    case ENV.SECONDARY_RPC_URL: return process.env.NEXT_PUBLIC_XYX_SECONDARY_RPC_URL;
    default: return process.env[name];
  }
}

export function isValidAddress(value: unknown): value is Address {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

/**
 * Shared non-zero address guard.
 *
 * A well-formed but zero address is a misconfigured deployment, not a valid
 * target: RPC reads against it return empty state and the demo would render an
 * "unverified" row that looks like a real run. Every canonical boundary
 * (manifest protocol/token, run protocol/token, environment configuration)
 * uses this one predicate so no path can accept the zero address.
 */
export function isNonZeroAddress(value: unknown): value is Address {
  return isValidAddress(value) && value !== ZERO_ADDRESS;
}

export function isValidRpId(value: unknown): value is string {
  return value === 'localhost' || (typeof value === 'string' && value.length > 0 && value.length <= 253
    && /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/.test(value)
  );
}

export function parseEnvAddress(name: string): Address | undefined {
  const value = readPublicEnv(name);
  if (!value || value === '') return undefined;
  if (!isValidAddress(value)) throw new Error(`INVALID_CONFIG: ${name} is not a valid hex address`);
  return value as Address;
}

export function parseEnvString(name: string): string | undefined {
  const value = readPublicEnv(name);
  if (!value || value === '') return undefined;
  return value;
}

export function parseEnvChainId(name: string): number | undefined {
  const raw = readPublicEnv(name);
  if (!raw || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`INVALID_CONFIG: ${name} must be a positive integer`);
  return parsed;
}

/**
 * Validate and read XYX protocol configuration from environment variables.
 * Returns undefined for optional fields that are absent; throws for malformed required fields.
 */
export function readConfig(): XYXConfig | undefined {
  const chainId = parseEnvChainId(ENV.CHAIN_ID);
  const protocolAddress = parseEnvAddress(ENV.PROTOCOL_ADDRESS);
  const registryAddress = parseEnvAddress(ENV.REGISTRY_ADDRESS);
  const p256VerifierAddress = parseEnvAddress(ENV.P256_VERIFIER_ADDRESS);
  const paymentTokenAddress = parseEnvAddress(ENV.PAYMENT_TOKEN_ADDRESS);
  const rpId = parseEnvString(ENV.RP_ID);
  const rpcUrl = parseEnvString(ENV.RPC_URL);
  const secondaryRpcUrl = parseEnvString(ENV.SECONDARY_RPC_URL);

  if (!chainId && !protocolAddress && !registryAddress && !p256VerifierAddress && !rpId && !rpcUrl) {
    return undefined;
  }

  const missing: string[] = [];
  if (chainId === undefined) missing.push(ENV.CHAIN_ID);
  if (protocolAddress === undefined) missing.push(ENV.PROTOCOL_ADDRESS);
  if (registryAddress === undefined) missing.push(ENV.REGISTRY_ADDRESS);
  if (p256VerifierAddress === undefined) missing.push(ENV.P256_VERIFIER_ADDRESS);
  if (rpId === undefined) missing.push(ENV.RP_ID);
  if (rpcUrl === undefined) missing.push(ENV.RPC_URL);

  if (missing.length > 0) {
    throw new Error(`MISSING_CONFIG: ${missing.join(', ')}`);
  }

  return {
    chainId: chainId!,
    protocolAddress: protocolAddress!,
    registryAddress: registryAddress!,
    p256VerifierAddress: p256VerifierAddress!,
    paymentTokenAddress: paymentTokenAddress ?? undefined,
    rpId: rpId!,
    rpcUrl: rpcUrl!,
    secondaryRpcUrl,
  };
}

/**
 * Validate a complete config object for on-chain consistency.
 * Requires chain ID 10143 and non-zero contract addresses.
 */
export function validateConfig(config: XYXConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (config.chainId !== MONAD_TESTNET_CHAIN_ID) {
    errors.push(`WRONG_NETWORK: chain ID is ${config.chainId}, expected ${MONAD_TESTNET_CHAIN_ID}`);
  }
  if (!isValidAddress(config.protocolAddress) || config.protocolAddress === '0x0000000000000000000000000000000000000000') {
    errors.push('INVALID_PROTOCOL_ADDRESS');
  }
  if (!isValidAddress(config.registryAddress) || config.registryAddress === '0x0000000000000000000000000000000000000000') {
    errors.push('INVALID_REGISTRY_ADDRESS');
  }
  if (!isValidAddress(config.p256VerifierAddress) || config.p256VerifierAddress === '0x0000000000000000000000000000000000000000') {
    errors.push('INVALID_P256_VERIFIER_ADDRESS');
  }
  if (!isValidRpId(config.rpId)) {
    errors.push('INVALID_RP_ID');
  }
  if (!isNonZeroAddress(config.paymentTokenAddress)) {
    errors.push('PAYMENT_TOKEN_ADDRESS_MISSING_OR_INVALID');
  }
  const validatePublicRpc = (value: string | undefined, missingCode: string): string | undefined => {
    if (!value) {
      errors.push(missingCode);
      return undefined;
    }
    try {
      const endpoint = new URL(value);
      if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === 'localhost'))
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
        errors.push('UNSAFE_PUBLIC_RPC_URL');
        return undefined;
      }
      return `${endpoint.protocol}//${endpoint.host}${endpoint.pathname.replace(/\/+$/, '')}`;
    } catch {
      errors.push('INVALID_PUBLIC_RPC_URL');
      return undefined;
    }
  };
  const primary = validatePublicRpc(config.rpcUrl, 'PRIMARY_RPC_URL_MISSING');
  const secondary = validatePublicRpc(config.secondaryRpcUrl, 'SECONDARY_RPC_URL_MISSING');
  if (primary && secondary && primary.toLowerCase() === secondary.toLowerCase()) {
    errors.push('RPC_ENDPOINTS_NOT_DISTINCT');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Format an address for display: first 6 and last 4 chars with ellipsis.
 */
export function formatAddress(address: Address): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/**
 * Format a hash for display.
 */
export function formatHash(hash: Hex): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}
