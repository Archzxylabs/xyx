/**
 * Non-broadcast deployment-readiness harness.
 *
 * This module is the single source of truth for the question "is the canonical
 * XYX deployment configuration ready for an explicit broadcast authorization?".
 * It is deliberately incapable of changing state:
 *
 *   - it never calls `sendTransaction` or `sendRawTransaction`,
 *   - it never invokes `forge script --broadcast`,
 *   - it never imports a wallet or reads a private key,
 *   - it never touches a faucet.
 *
 * Every chain-dependent fact is obtained through an injected pair of
 * {@link ReadinessRpcProbe} objects — one per endpoint. `ReadinessOptions`
 * takes a {@link ReadinessRpcProbes} pair rather than a single probe, so a
 * caller physically cannot report "both RPCs agree" while having queried one
 * endpoint twice. The only probe implementation shipped in this repository is a
 * test double; production wiring must supply a viem-backed probe per endpoint at
 * the call site.
 *
 * Gas note (Monad): users pay `gas_limit * price_per_gas`, i.e. the fee is charged
 * against the LIMIT, not the gas actually used. A requested limit is therefore a
 * real cost decision, which is why {@link resolveGasLimit} refuses any buffer above
 * {@link MAX_GAS_BUFFER_BPS} and why an estimate is never presented as a final fee
 * quote.
 */

import type { Address, Hex } from 'viem';

import { MONAD_TESTNET_CHAIN_ID } from './config';

// ===========================================================================
// Constants
// ===========================================================================

/** The only chain this repository targets. */
export const EXPECTED_CHAIN_ID = MONAD_TESTNET_CHAIN_ID;

/**
 * A plain MON transfer costs exactly 21,000 gas on Monad. This constant is valid
 * ONLY for a genuine native-value transfer with an empty payload; it must never
 * be used as a gas limit for a contract deployment or a contract call.
 */
export const NATIVE_TRANSFER_GAS_LIMIT = 21_000n;

/**
 * Maximum permitted safety buffer over a gas estimate, in basis points.
 * 1000 bps = 10%. Monad charges the limit, so an oversized limit is a direct
 * overpayment; anything above this cap is rejected rather than silently applied.
 */
export const MAX_GAS_BUFFER_BPS = 1_000n;

/** Canonical payment-token decimals for Monad Testnet USDC. */
export const EXPECTED_TOKEN_DECIMALS = 6;

/** Canonical contract artifact names, in deployment order. */
export const CANONICAL_CONTRACTS = [
  'MonadP256Verifier',
  'XYXPasskeyRegistry',
  'XYXDeliveryProtocol',
] as const;

export type CanonicalContractName = (typeof CANONICAL_CONTRACTS)[number];

/** Env var names the harness understands. All of them are public configuration. */
export const READINESS_ENV_KEYS = [
  'XYX_PRIMARY_RPC_URL',
  'XYX_SECONDARY_RPC_URL',
  'XYX_PAYMENT_TOKEN_ADDRESS',
  'XYX_P256_VERIFIER_ADDRESS',
  'XYX_REGISTRY_ADDRESS',
  'XYX_PROTOCOL_ADDRESS',
  'XYX_RP_ID',
  'XYX_RP_ID_HASH',
  'XYX_MAX_VERDICT_LIFETIME',
  'XYX_DEPLOYER_ADDRESS',
  'XYX_ATTESTOR_ADDRESS',
  'XYX_RELAYER_ADDRESS',
  'XYX_EXPECTED_TOKEN_DECIMALS',
  'XYX_GAS_BUFFER_BPS',
] as const;

// ===========================================================================
// Stable failure codes
// ===========================================================================

/**
 * Stable, machine-readable failure codes. These strings are part of the tool's
 * contract: CI and operators match on them, so they must not be renamed or
 * reworded. Every code is emitted at most once per run.
 */
export const READINESS_FAILURE_CODES = {
  CHAIN_ID_MISMATCH: 'CHAIN_ID_MISMATCH',
  CHAIN_ID_DISAGREEMENT: 'CHAIN_ID_DISAGREEMENT',
  RPC_URL_MISSING: 'RPC_URL_MISSING',
  RPC_URL_MALFORMED: 'RPC_URL_MALFORMED',
  RPC_ENDPOINTS_IDENTICAL: 'RPC_ENDPOINTS_IDENTICAL',
  RPC_PROBE_FAILED: 'RPC_PROBE_FAILED',
  /** One side of the probe pair is missing: dual-RPC verification is impossible. */
  RPC_PROBE_PAIR_INCOMPLETE: 'RPC_PROBE_PAIR_INCOMPLETE',
  /** The very same probe object was supplied for both endpoints. */
  RPC_PROBE_REUSED: 'RPC_PROBE_REUSED',
  /** No live two-endpoint probe pair was supplied, so nothing was verified on chain. */
  LIVE_DUAL_RPC_PROBE_REQUIRED: 'LIVE_DUAL_RPC_PROBE_REQUIRED',
  TOKEN_ADDRESS_MISSING: 'TOKEN_ADDRESS_MISSING',
  TOKEN_ADDRESS_MALFORMED: 'TOKEN_ADDRESS_MALFORMED',
  TOKEN_ADDRESS_ZERO: 'TOKEN_ADDRESS_ZERO',
  TOKEN_CODE_MISSING: 'TOKEN_CODE_MISSING',
  TOKEN_CODE_DISAGREEMENT: 'TOKEN_CODE_DISAGREEMENT',
  TOKEN_DECIMALS_MISMATCH: 'TOKEN_DECIMALS_MISMATCH',
  TOKEN_DECIMALS_UNREADABLE: 'TOKEN_DECIMALS_UNREADABLE',
  TOKEN_DECIMALS_DISAGREEMENT: 'TOKEN_DECIMALS_DISAGREEMENT',
  VERIFIER_ADDRESS_MISSING: 'VERIFIER_ADDRESS_MISSING',
  VERIFIER_ADDRESS_MALFORMED: 'VERIFIER_ADDRESS_MALFORMED',
  VERIFIER_CODE_MISSING: 'VERIFIER_CODE_MISSING',
  VERIFIER_CODE_DISAGREEMENT: 'VERIFIER_CODE_DISAGREEMENT',
  REGISTRY_ADDRESS_MISSING: 'REGISTRY_ADDRESS_MISSING',
  REGISTRY_ADDRESS_MALFORMED: 'REGISTRY_ADDRESS_MALFORMED',
  REGISTRY_CODE_MISSING: 'REGISTRY_CODE_MISSING',
  REGISTRY_CODE_DISAGREEMENT: 'REGISTRY_CODE_DISAGREEMENT',
  PROTOCOL_ADDRESS_MISSING: 'PROTOCOL_ADDRESS_MISSING',
  PROTOCOL_ADDRESS_MALFORMED: 'PROTOCOL_ADDRESS_MALFORMED',
  PROTOCOL_CODE_MISSING: 'PROTOCOL_CODE_MISSING',
  PROTOCOL_CODE_DISAGREEMENT: 'PROTOCOL_CODE_DISAGREEMENT',
  RP_ID_MISSING: 'RP_ID_MISSING',
  RP_ID_MALFORMED: 'RP_ID_MALFORMED',
  RP_ID_HASH_MALFORMED: 'RP_ID_HASH_MALFORMED',
  RP_ID_HASH_MISMATCH: 'RP_ID_HASH_MISMATCH',
  VERDICT_LIFETIME_MISSING: 'VERDICT_LIFETIME_MISSING',
  VERDICT_LIFETIME_INVALID: 'VERDICT_LIFETIME_INVALID',
  VERDICT_LIFETIME_OUT_OF_RANGE: 'VERDICT_LIFETIME_OUT_OF_RANGE',
  ACTOR_ADDRESS_MISSING: 'ACTOR_ADDRESS_MISSING',
  ACTOR_ADDRESS_MALFORMED: 'ACTOR_ADDRESS_MALFORMED',
  ACTOR_ADDRESS_ZERO: 'ACTOR_ADDRESS_ZERO',
  ACTOR_ADDRESS_COLLISION: 'ACTOR_ADDRESS_COLLISION',
  ARTIFACT_MISSING: 'ARTIFACT_MISSING',
  ARTIFACT_NAME_MISMATCH: 'ARTIFACT_NAME_MISMATCH',
  ARTIFACT_BYTECODE_EMPTY: 'ARTIFACT_BYTECODE_EMPTY',
  GAS_ESTIMATE_MISSING: 'GAS_ESTIMATE_MISSING',
  GAS_BUFFER_INVALID: 'GAS_BUFFER_INVALID',
  GAS_BUFFER_TOO_LARGE: 'GAS_BUFFER_TOO_LARGE',
  GAS_LIMIT_ABOVE_TX_CAP: 'GAS_LIMIT_ABOVE_TX_CAP',
  SECRET_ENV_KEY_PRESENT: 'SECRET_ENV_KEY_PRESENT',
} as const;

export type ReadinessFailureCode = (typeof READINESS_FAILURE_CODES)[keyof typeof READINESS_FAILURE_CODES];

export const READINESS_STATUS = {
  READY: 'READY_FOR_EXPLICIT_BROADCAST_AUTHORIZATION',
  NOT_READY: 'NOT_READY',
} as const;

export type ReadinessStatus = (typeof READINESS_STATUS)[keyof typeof READINESS_STATUS];

/** Monad Testnet per-transaction gas limit. A deployment above this cannot be mined. */
export const MONAD_TX_GAS_LIMIT_CAP = 30_000_000n;

// ===========================================================================
// Secret handling
// ===========================================================================

/**
 * Env var names matching this pattern are treated as secrets: their values are
 * never read into a report, never printed, and never forwarded to a probe.
 */
export const SECRET_ENV_NAME_PATTERN =
  /(key|secret|mnemonic|seed|prf|password|passphrase|credential|private|token|auth|bearer|jwt|cookie|signature|salt)/i;

/** Returns true when an env var name must be treated as secret-bearing. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAME_PATTERN.test(name);
}

/**
 * Env var prefixes and exact names that belong to the XYX deployment
 * configuration. Only these are inspected for secret-bearing names: the
 * ambient shell environment (XAUTHORITY, DBUS_SESSION_BUS_ADDRESS, …) is
 * unrelated to deployment readiness and must not turn a run red.
 */
const DEPLOYMENT_ENV_PREFIXES = [
  'XYX_',
  'MONAD_',
  'MONADSCAN_',
  'ETHERSCAN_',
  'SOURCIFY_',
  'DEPLOYER_',
  'ATTESTOR_',
  'RELAYER_',
  'EVIDENCE_',
];

/** True when an env var name belongs to the deployment configuration. */
export function isDeploymentEnvName(name: string): boolean {
  return (
    DEPLOYMENT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    name === 'VERDICT_LIFETIME' ||
    name === 'DEPLOY_COMMIT'
  );
}

/**
 * True when a key/value pair can safely appear in a report.
 * Used by the CLI to prove that no secret-bearing key reached the JSON output.
 */
export function isReportableEnvKey(name: string): boolean {
  return !isSecretEnvName(name);
}

// ===========================================================================
// Gas arithmetic
// ===========================================================================

export interface GasLimitDecision {
  estimatedGas: bigint;
  bufferBps: bigint;
  bufferGas: bigint;
  /** The exact gas limit that would be requested. */
  requestedGasLimit: bigint;
  /** Buffer as a human-readable percentage string, e.g. "10.0%". */
  bufferPercent: string;
}

export class GasBufferError extends Error {
  readonly code: ReadinessFailureCode;
  constructor(code: ReadinessFailureCode, message: string) {
    super(message);
    this.name = 'GasBufferError';
    this.code = code;
  }
}

/**
 * Compute the exact gas limit to request for a given estimate and buffer.
 *
 * Throws {@link GasBufferError} with `GAS_BUFFER_INVALID` for a negative buffer
 * and `GAS_BUFFER_TOO_LARGE` for anything above {@link MAX_GAS_BUFFER_BPS}.
 * Monad charges `gas_limit * price_per_gas`, so the requested limit is the
 * actual cost; this function exists to make that limit explicit and bounded.
 */
export function resolveGasLimit(estimatedGas: bigint, bufferBps: bigint = 0n): GasLimitDecision {
  if (estimatedGas < 0n) {
    throw new GasBufferError('GAS_ESTIMATE_MISSING', 'estimatedGas must not be negative');
  }
  if (bufferBps < 0n) {
    throw new GasBufferError('GAS_BUFFER_INVALID', `gas buffer ${bufferBps} bps is negative`);
  }
  if (bufferBps > MAX_GAS_BUFFER_BPS) {
    throw new GasBufferError(
      'GAS_BUFFER_TOO_LARGE',
      `gas buffer ${bufferBps} bps exceeds the ${MAX_GAS_BUFFER_BPS} bps (10%) cap; Monad charges gas_limit * price_per_gas, so an oversized limit is a direct overpayment`,
    );
  }
  const bufferGas = (estimatedGas * bufferBps) / 10_000n;
  return {
    estimatedGas,
    bufferBps,
    bufferGas,
    requestedGasLimit: estimatedGas + bufferGas,
    bufferPercent: `${(Number(bufferBps) / 100).toFixed(1)}%`,
  };
}

/**
 * Validate a requested gas limit against the Monad Testnet transaction cap.
 * Returns the failure code, or null when the limit is acceptable.
 */
export function checkGasLimitWithinTxCap(requestedGasLimit: bigint): ReadinessFailureCode | null {
  return requestedGasLimit > MONAD_TX_GAS_LIMIT_CAP ? 'GAS_LIMIT_ABOVE_TX_CAP' : null;
}

// ===========================================================================
// Injected RPC probe
// ===========================================================================

/**
 * Read-only chain surface the harness needs. Implementations must only ever
 * issue `eth_chainId`, `eth_getCode` and `eth_call`; anything that mutates
 * state is out of contract for this module.
 */
export interface ReadinessRpcProbe {
  /** `eth_chainId`. */
  chainId(): Promise<number>;
  /** `eth_getCode`. Returns "0x" when no contract exists at the address. */
  getCode(address: Address): Promise<Hex>;
  /** `eth_call` with raw calldata, returning raw return data. */
  call(to: Address, data: Hex): Promise<Hex>;
}

/**
 * The two probes a dual-RPC run needs: one per endpoint.
 *
 * This is a pair rather than a single probe so that "both RPCs agree" can only
 * ever mean "two separately reachable nodes returned the same thing". Supplying
 * the same object for both sides is rejected with `RPC_PROBE_REUSED`; supplying
 * only one side is rejected with `RPC_PROBE_PAIR_INCOMPLETE`. There is no
 * production fallback in which one probe silently serves both endpoints.
 */
export interface ReadinessRpcProbes {
  /** Probe bound to `XYX_PRIMARY_RPC_URL` only. */
  primary: ReadinessRpcProbe;
  /** Probe bound to `XYX_SECONDARY_RPC_URL` only. */
  secondary: ReadinessRpcProbe;
}

export interface ReadinessArtifact {
  /** Artifact JSON path as reported by the build. */
  path: string;
  /** Contract name declared by the artifact. */
  contractName: string;
  /** Deployment (creation) bytecode from the artifact, with or without 0x. */
  bytecode: string;
}

// ===========================================================================
// Environment object and schema
// ===========================================================================

export interface ReadinessEnv {
  primaryRpcUrl: string;
  secondaryRpcUrl: string;
  paymentTokenAddress: string;
  /** Optional: only present once the canonical trio has been deployed. */
  p256VerifierAddress?: string;
  registryAddress?: string;
  protocolAddress?: string;
  rpId: string;
  /** Optional configured RP-ID hash; when absent only its shape is validated. */
  rpIdHash?: string;
  /** Seconds. Accepts a raw string so CLI input can be passed through unparsed. */
  maxVerdictLifetime: number | bigint | string;
  deployerAddress?: string;
  attestorAddress?: string;
  relayerAddress?: string;
  expectedTokenDecimals?: number;
  /** Safety buffer over a gas estimate, in basis points. Defaults to 0. */
  gasBufferBps?: number | bigint | string;
  /**
   * Gas estimate to validate the buffer against, in gas units. Optional: when
   * absent the buffer is validated on its own and the reported limit is
   * relative to {@link GAS_CHECK_BASELINE} rather than to a real estimate.
   */
  gasEstimate?: number | bigint | string;
}

/**
 * Baseline estimate used to check the gas arithmetic when the caller supplies
 * no real estimate. It is deliberately small enough that a legal buffer can
 * never push the resolved limit over the Monad transaction gas cap, so the
 * cap check stays meaningful rather than passing by construction.
 */
const GAS_CHECK_BASELINE = 1_000_000n;

export interface ReadinessOptions {
  /**
   * `pre-deploy` validates configuration only (contract addresses optional).
   * `post-deploy` additionally requires the three canonical addresses.
   * @default 'pre-deploy'
   */
  mode?: 'pre-deploy' | 'post-deploy';
  /**
   * The two read-only probes to query, one per endpoint. Omit to run with no
   * chain reads at all, which is reported as NOT_READY with
   * {@link READINESS_FAILURE_CODES.LIVE_DUAL_RPC_PROBE_REQUIRED}: a run that
   * never touched the chain can never be ready for a broadcast.
   */
  probes?: ReadinessRpcProbes;
  /**
   * Set by a CLI `--offline` run. No chain query is performed even when probes
   * are supplied, and the run is reported NOT_READY. Offline runs validate
   * configuration only; they can never establish on-chain agreement.
   */
  offline?: boolean;
  /** Local artifacts to validate. Omit to skip artifact checks. */
  artifacts?: ReadinessArtifact[];
  /**
   * Raw environment, used only to assert that no secret-bearing key was
   * supplied. Values are never read from it.
   */
  rawEnvKeys?: Iterable<string>;
}

export interface ReadinessCheck {
  /** Stable check identifier, e.g. `token.decimals`. */
  id: string;
  status: 'pass' | 'fail' | 'skip';
  /** Failure code, or null when the check passed or was skipped. */
  code: ReadinessFailureCode | null;
  /** Redacted, human-readable detail. Never contains a secret or an RPC URL. */
  detail: string;
}

/**
 * Chain IDs actually returned by the two endpoints.
 *
 * Each field is `null` unless that endpoint's `eth_chainId` call returned a
 * number during this run. There is deliberately no default and no fallback: a
 * run that never queried an endpoint — offline, missing probe, reused probe,
 * incomplete pair, malformed endpoint, timeout, or a failed read — reports
 * `null` for that endpoint rather than the value the harness expected.
 */
export interface ReadinessObservedChainIds {
  /** `eth_chainId` from the primary endpoint, or null when never observed. */
  primary: number | null;
  /** `eth_chainId` from the secondary endpoint, or null when never observed. */
  secondary: number | null;
}

export interface ReadinessReport {
  status: ReadinessStatus;
  /** True only when every non-skipped check passed. */
  ready: boolean;
  mode: 'pre-deploy' | 'post-deploy';
  /**
   * The chain ID this harness is built for. This is the configured expectation,
   * never an observation: it is identical on every execution path, including an
   * offline run that queried no endpoint at all. Observed values live in
   * {@link ReadinessReport.observedChainIds}.
   */
  expectedChainId: number;
  /**
   * What each endpoint actually reported, or null when it was not queried or
   * its read failed. A ready report always shows both endpoints as
   * {@link ReadinessReport.expectedChainId}; an offline report always shows
   * both as null.
   */
  observedChainIds: ReadinessObservedChainIds;
  timestamp: number;
  checks: ReadinessCheck[];
  /** Deduplicated, ordered list of failure codes. */
  failures: ReadinessFailureCode[];
  /** Explicit note that this report is not an authorization. */
  authorization: 'NOT_GRANTED';
}

// ===========================================================================
// Primitive validation helpers
// ===========================================================================

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i;
const RP_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const UINT64_MAX = 18_446_744_073_709_551_615n;

function isAddressLike(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === ZERO_ADDRESS;
}

/** Strip a scheme, credentials, path, query and fragment from a URL for display. */
export function redactRpcUrl(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url.trim());
  if (!match) return '(unparseable endpoint)';
  // Keep only the scheme and the host, dropping any userinfo (API keys often
  // live in the path or query string of a hosted RPC endpoint).
  const host = match[2].split('@').pop() ?? match[2];
  return `${match[1].toLowerCase()}://${host}`;
}

/** Normalise an endpoint for comparison: scheme + host, lowercased, no trailing slash. */
export function normalizeEndpoint(url: string): string {
  return redactRpcUrl(url).replace(/\/+$/, '').toLowerCase();
}

/**
 * Redact every http(s) URL inside a block of text down to scheme + host.
 *
 * Probe errors routinely echo the request URL, and a hosted RPC endpoint keeps
 * its API key in the path or query string, so a raw error message must never
 * reach a report or a log line.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s'"`)\]]+/gi, (match) => redactRpcUrl(match));
}

function hasBytecode(code: string): boolean {
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  return hex.length > 0 && /^[0-9a-fA-F]+$/.test(hex);
}

/** Parse a basis-point value, rejecting negatives rather than clamping. */
function parseNonNegativeBps(value: number | bigint | string): bigint {
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!/^\d+$/.test(text)) return -1n; // out of contract; the buffer check reports it
  return BigInt(text);
}

/** Parse a gas estimate. Returns null when absent or not a non-negative integer. */
function parseGasEstimate(value: number | bigint | string | undefined): bigint | null {
  if (value === undefined) return null;
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
}

/**
 * Parse a lifetime into a uint64 bigint.
 *
 * Returns null for anything that is not a base-10 non-negative integer, and
 * returns the parsed value (even above uint64) so the caller can distinguish
 * "not an integer" from "integer out of range".
 */
function toUint64(value: number | bigint | string): bigint | null {
  try {
    const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
    if (!/^\d+$/.test(text)) return null;
    return BigInt(text);
  } catch {
    return null;
  }
}

/** `keccak256(abi.encodePacked(rpId))`-free derivation: WebAuthn RP-ID hash is SHA-256. */
export async function rpIdToHash(rpId: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return `0x${createHash('sha256').update(rpId, 'utf8').digest('hex')}`;
}

// ===========================================================================
// ABI fragments used for read-only `eth_call` probes
// ===========================================================================

/** `decimals()` -> uint8 */
export const TOKEN_DECIMALS_SELECTOR = '0x313ce567';
/** `symbol()` -> string */
export const TOKEN_SYMBOL_SELECTOR = '0x95d89b41';

function decodeUint8(returnData: string): number | null {
  const hex = returnData.startsWith('0x') ? returnData.slice(2) : returnData;
  if (hex.length < 64) return null;
  const word = hex.slice(-64);
  if (!/^[0-9a-fA-F]{64}$/.test(word)) return null;
  return Number(BigInt(`0x${word}`));
}

// ===========================================================================
// Readiness runner
// ===========================================================================

interface Collector {
  checks: ReadinessCheck[];
  failures: ReadinessFailureCode[];
  record(check: ReadinessCheck): void;
  pass(id: string, detail: string): void;
  fail(id: string, code: ReadinessFailureCode, detail: string): void;
  skip(id: string, detail: string): void;
}

function createCollector(): Collector {
  const checks: ReadinessCheck[] = [];
  const failures: ReadinessFailureCode[] = [];
  return {
    checks,
    failures,
    record(check) {
      checks.push(check);
      if (check.code && !failures.includes(check.code)) failures.push(check.code);
    },
    pass(id, detail) {
      this.record({ id, status: 'pass', code: null, detail });
    },
    fail(id, code, detail) {
      this.record({ id, status: 'fail', code, detail });
    },
    skip(id, detail) {
      this.record({ id, status: 'skip', code: null, detail });
    },
  };
}

/** One endpoint a readiness run is allowed to query, and the probe bound to it. */
interface ResolvedReadinessEndpoint {
  label: 'primary' | 'secondary';
  url: string;
  probe: ReadinessRpcProbe;
}

/**
 * Bind each probe in the pair to the endpoint URL it may query.
 *
 * Returns `null` — after recording a failure — for every wiring that cannot
 * prove that two separately reachable endpoints were read: an offline run, no
 * pair at all, a half-supplied pair, a pair reusing one probe object, or a pair
 * whose endpoint URL is unusable. There is deliberately no fallback that lets a
 * single probe answer for both endpoints, because nothing read from one endpoint
 * twice can ever demonstrate that two nodes agree.
 */
function resolveProbePair(
  probes: ReadinessRpcProbes | undefined,
  primary: string,
  secondary: string,
  offline: boolean,
  collector: Collector,
): ResolvedReadinessEndpoint[] | null {
  if (offline) {
    collector.fail(
      'rpc.probe',
      'LIVE_DUAL_RPC_PROBE_REQUIRED',
      'offline run requested; no RPC endpoint was queried, so dual-RPC agreement is unverified and this run can never be ready for a broadcast',
    );
    return null;
  }

  if (!probes || !probes.primary || !probes.secondary) {
    collector.fail(
      'rpc.probe',
      'LIVE_DUAL_RPC_PROBE_REQUIRED',
      'no live dual-RPC probe pair supplied; a run that never queried the chain cannot report on-chain agreement',
    );
    return null;
  }

  if (probes.primary === probes.secondary) {
    collector.fail(
      'rpc.probe',
      'RPC_PROBE_REUSED',
      'the same probe object was supplied for both RPC endpoints; one endpoint would be queried twice and reported as dual-RPC agreement',
    );
    return null;
  }

  const unusable: string[] = [];
  if (primary === '') unusable.push('primary');
  if (secondary === '') unusable.push('secondary');
  if (unusable.length > 0) {
    collector.fail(
      'rpc.probe',
      'RPC_PROBE_PAIR_INCOMPLETE',
      `the ${unusable.join(' and ')} RPC endpoint is unusable, so the probe pair cannot be bound to two distinct endpoints`,
    );
    return null;
  }

  collector.pass('rpc.probe', 'two distinct probes bound, one per RPC endpoint');
  return [
    { label: 'primary', url: primary, probe: probes.primary },
    { label: 'secondary', url: secondary, probe: probes.secondary },
  ];
}

/** The three canonical contracts and the env field that names each one. */
const DEPLOYED_TARGETS = [
  { name: 'p256Verifier' as const, field: 'p256VerifierAddress' as const, checkId: 'verifier' },
  { name: 'registry' as const, field: 'registryAddress' as const, checkId: 'registry' },
  { name: 'protocol' as const, field: 'protocolAddress' as const, checkId: 'protocol' },
];

/** Failure codes for a missing / malformed / codeless / divergent canonical address. */
const TARGET_CODES: Record<
  (typeof DEPLOYED_TARGETS)[number]['name'],
  {
    missing: ReadinessFailureCode;
    malformed: ReadinessFailureCode;
    codeless: ReadinessFailureCode;
    disagreement: ReadinessFailureCode;
  }
> = {
  p256Verifier: {
    missing: 'VERIFIER_ADDRESS_MISSING',
    malformed: 'VERIFIER_ADDRESS_MALFORMED',
    codeless: 'VERIFIER_CODE_MISSING',
    disagreement: 'VERIFIER_CODE_DISAGREEMENT',
  },
  registry: {
    missing: 'REGISTRY_ADDRESS_MISSING',
    malformed: 'REGISTRY_ADDRESS_MALFORMED',
    codeless: 'REGISTRY_CODE_MISSING',
    disagreement: 'REGISTRY_CODE_DISAGREEMENT',
  },
  protocol: {
    missing: 'PROTOCOL_ADDRESS_MISSING',
    malformed: 'PROTOCOL_ADDRESS_MALFORMED',
    codeless: 'PROTOCOL_CODE_MISSING',
    disagreement: 'PROTOCOL_CODE_DISAGREEMENT',
  },
};

/**
 * Run every deployment-readiness check.
 *
 * Never mutates chain state and never authorizes anything. Returns
 * `READY_FOR_EXPLICIT_BROADCAST_AUTHORIZATION` only when every non-skipped
 * check passed, which additionally requires a live probe pair for two distinct
 * endpoints: a run that never queried the chain is NOT_READY by construction.
 */
export async function runReadiness(
  env: ReadinessEnv,
  options: ReadinessOptions = {},
): Promise<ReadinessReport> {
  const mode = options.mode ?? 'pre-deploy';
  const offline = options.offline === true;
  const collector = createCollector();
  const expectedDecimals = env.expectedTokenDecimals ?? EXPECTED_TOKEN_DECIMALS;

  // ── 0. Secret-bearing env keys ───────────────────────────────────────────
  if (options.rawEnvKeys) {
    // Only the deployment namespace is inspected. The count is reported but
    // never the key names, so the report cannot itself become a place where
    // credential-bearing variable names accumulate.
    let secretCount = 0;
    for (const key of options.rawEnvKeys) {
      if (isDeploymentEnvName(key) && isSecretEnvName(key)) secretCount += 1;
    }
    if (secretCount > 0) {
      collector.fail(
        'env.secrets',
        'SECRET_ENV_KEY_PRESENT',
        `${secretCount} secret-bearing key(s) present in the XYX/MONAD deployment environment; unset them before running any deploy script`,
      );
    } else {
      collector.pass('env.secrets', 'no secret-bearing keys in the deployment environment');
    }
  }

  // ── 1. RPC endpoints ─────────────────────────────────────────────────────
  let primary = '';
  let secondary = '';
  for (const [field, value] of [
    ['primary', env.primaryRpcUrl],
    ['secondary', env.secondaryRpcUrl],
  ] as const) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed === '') {
      collector.fail('rpc.url', 'RPC_URL_MISSING', `${field} RPC URL is empty`);
      continue;
    }
    if (!HTTP_URL_RE.test(trimmed)) {
      collector.fail('rpc.url', 'RPC_URL_MALFORMED', `${field} RPC URL is not an http(s) URL`);
      continue;
    }
    if (field === 'primary') primary = trimmed;
    else secondary = trimmed;
    collector.pass('rpc.url', `${field} RPC endpoint is a well-formed http(s) URL`);
  }

  if (primary && secondary) {
    if (normalizeEndpoint(primary) === normalizeEndpoint(secondary)) {
      collector.fail(
        'rpc.distinct',
        'RPC_ENDPOINTS_IDENTICAL',
        'primary and secondary RPC endpoints resolve to the same host; two independent endpoints are required',
      );
    } else {
      collector.pass('rpc.distinct', 'primary and secondary RPC endpoints are distinct');
    }
  }

  // ── 1b. Probe pair ───────────────────────────────────────────────────────
  // The pair is resolved before any chain read so that a mis-wired caller (one
  // probe serving both endpoints, or a half-supplied pair) fails closed instead
  // of quietly querying a single endpoint twice and calling it agreement.
  const endpoints = resolveProbePair(options.probes, primary, secondary, offline, collector);

  // ── 2. Chain ID ──────────────────────────────────────────────────────────
  // Both fields stay null unless the corresponding endpoint actually answered.
  // The expected chain ID is never used to fill one in, so a report can never
  // imply that a chain was read when it was not.
  const observedChainIds: ReadinessObservedChainIds = { primary: null, secondary: null };
  if (endpoints) {
    const observed: Array<{ endpoint: 'primary' | 'secondary'; id: number | null }> = [];
    for (const { label, url, probe } of endpoints) {
      try {
        const id = await probe.chainId();
        observedChainIds[label] = id;
        observed.push({ endpoint: label, id });
      } catch (error) {
        collector.fail(
          `rpc.probe.chainId.${label}`,
          'RPC_PROBE_FAILED',
          `${label} RPC (${redactRpcUrl(url)}) probe failed: ${describeError(error)}`,
        );
        observed.push({ endpoint: label, id: null });
      }
    }
    const ids = observed.map((entry) => entry.id).filter((id): id is number => id !== null);
    for (const entry of observed) {
      if (entry.id === null) continue;
      if (entry.id !== EXPECTED_CHAIN_ID) {
        collector.fail(
          'chain.id',
          'CHAIN_ID_MISMATCH',
          `${entry.endpoint} RPC reports chain ID ${entry.id}, expected ${EXPECTED_CHAIN_ID}`,
        );
      } else {
        collector.pass('chain.id', `${entry.endpoint} RPC reports chain ID ${EXPECTED_CHAIN_ID}`);
      }
    }
    if (ids.length === 2 && ids[0] !== ids[1]) {
      collector.fail(
        'chain.agreement',
        'CHAIN_ID_DISAGREEMENT',
        `primary and secondary RPCs disagree on chain ID (${ids[0]} vs ${ids[1]})`,
      );
    } else if (ids.length === 2) {
      collector.pass('chain.agreement', 'both RPCs agree on chain ID');
    }
  } else {
    const reason = offline
      ? 'offline run requested'
      : primary && secondary
        ? 'no live dual-RPC probe pair supplied'
        : 'RPC endpoints incomplete; no probe pair resolved';
    collector.skip('chain.id', `${reason}; chain ID not queried`);
    collector.skip('chain.agreement', `${reason}; dual-RPC agreement not queried`);
  }

  // ── 3. Payment token ─────────────────────────────────────────────────────
  const token = typeof env.paymentTokenAddress === 'string' ? env.paymentTokenAddress.trim() : '';
  if (token === '') {
    collector.fail('token.address', 'TOKEN_ADDRESS_MISSING', 'payment token address is empty');
  } else if (!isAddressLike(token)) {
    collector.fail('token.address', 'TOKEN_ADDRESS_MALFORMED', 'payment token address is not 20-byte hex');
  } else if (isZeroAddress(token)) {
    collector.fail('token.address', 'TOKEN_ADDRESS_ZERO', 'payment token address is the zero address');
  } else {
    collector.pass('token.address', 'payment token address is a well-formed non-zero address');
  }

  const tokenCodes: string[] = [];
  if (endpoints && isAddressLike(token) && !isZeroAddress(token)) {
    for (const { label, probe } of endpoints) {
      try {
        const code = await probe.getCode(token as Address);
        if (hasBytecode(code)) {
          tokenCodes.push(code.toLowerCase());
          collector.pass(`token.code.${label}`, `payment token has bytecode on the ${label} RPC`);
        } else {
          collector.fail(
            `token.code.${label}`,
            'TOKEN_CODE_MISSING',
            `payment token has no bytecode on the ${label} RPC`,
          );
        }
      } catch (error) {
        collector.fail(
          `token.code.${label}`,
          'TOKEN_CODE_MISSING',
          `payment token bytecode lookup failed on the ${label} RPC: ${describeError(error)}`,
        );
      }
    }
    if (tokenCodes.length === 2 && tokenCodes[0] !== tokenCodes[1]) {
      collector.fail(
        'token.code.agreement',
        'TOKEN_CODE_DISAGREEMENT',
        'payment token bytecode differs between the two RPCs',
      );
    }
  } else if (!endpoints) {
    collector.skip(
      'token.code',
      offline
        ? 'offline run requested; token bytecode not queried'
        : 'no live dual-RPC probe pair; token bytecode not queried',
    );
  }

  if (endpoints && isAddressLike(token) && !isZeroAddress(token)) {
    // decimals() must be readable, must decode, must equal the expected value on
    // BOTH endpoints, and the two endpoints must agree with each other. A token
    // whose decimals differ per endpoint is not a token this deployment can use.
    const decimalsByEndpoint: Array<{ label: 'primary' | 'secondary'; value: number | null }> = [];
    for (const { label, probe } of endpoints) {
      let value: number | null = null;
      let failure: string | null = null;
      try {
        value = decodeUint8(await probe.call(token as Address, TOKEN_DECIMALS_SELECTOR as Hex));
        if (value === null) failure = 'token decimals() returned no decodable uint8';
      } catch (error) {
        failure = `token decimals() call failed: ${describeError(error)}`;
      }
      if (failure !== null) {
        collector.fail(`token.decimals.${label}`, 'TOKEN_DECIMALS_UNREADABLE', failure);
      } else if (value !== expectedDecimals) {
        collector.fail(
          `token.decimals.${label}`,
          'TOKEN_DECIMALS_MISMATCH',
          `token reports ${value} decimals on the ${label} RPC, expected ${expectedDecimals}`,
        );
      } else {
        collector.pass(
          `token.decimals.${label}`,
          `token reports ${expectedDecimals} decimals on the ${label} RPC`,
        );
      }
      decimalsByEndpoint.push({ label, value });
    }
    const [primaryDecimals, secondaryDecimals] = decimalsByEndpoint;
    if (
      primaryDecimals.value !== null &&
      secondaryDecimals.value !== null &&
      primaryDecimals.value !== secondaryDecimals.value
    ) {
      collector.fail(
        'token.decimals.agreement',
        'TOKEN_DECIMALS_DISAGREEMENT',
        `token decimals disagree between the two RPCs (${primaryDecimals.value} on primary vs ${secondaryDecimals.value} on secondary)`,
      );
    } else if (primaryDecimals.value !== null && secondaryDecimals.value !== null) {
      collector.pass('token.decimals.agreement', 'both RPCs report the same token decimals');
    }
  } else if (!endpoints) {
    collector.skip(
      'token.decimals',
      offline
        ? 'offline run requested; token decimals not queried'
        : 'no live dual-RPC probe pair; token decimals not queried',
    );
  }

  // ── 4. Deployed canonical trio ───────────────────────────────────────────
  for (const target of DEPLOYED_TARGETS) {
    const codes = TARGET_CODES[target.name];
    const value = env[target.field];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed === '') {
      if (mode === 'post-deploy') {
        collector.fail(
          `${target.checkId}.address`,
          codes.missing,
          `${target.name} address is required in post-deploy mode`,
        );
      } else {
        collector.skip(`${target.checkId}.address`, `${target.name} not deployed yet; skipped in pre-deploy mode`);
      }
      continue;
    }
    if (!isAddressLike(trimmed)) {
      collector.fail(
        `${target.checkId}.address`,
        codes.malformed,
        `${target.name} address is not 20-byte hex`,
      );
      continue;
    }
    if (isZeroAddress(trimmed)) {
      collector.fail(
        `${target.checkId}.address`,
        codes.malformed,
        `${target.name} address is the zero address`,
      );
      continue;
    }
    collector.pass(`${target.checkId}.address`, `${target.name} address is well-formed and non-zero`);

    if (endpoints) {
      // The trio's bytecode is read from both endpoints. Two nodes that disagree
      // about what is deployed at a canonical address mean at least one of them
      // is wrong, so the run fails closed rather than picking a winner.
      const codeByEndpoint: Array<{ label: 'primary' | 'secondary'; code: string | null }> = [];
      for (const { label, probe } of endpoints) {
        let code: string | null = null;
        try {
          const observed = await probe.getCode(trimmed as Address);
          if (hasBytecode(observed)) code = observed.toLowerCase();
        } catch (error) {
          code = null;
          collector.fail(
            `${target.checkId}.code.${label}`,
            codes.codeless,
            `${target.name} bytecode lookup failed on the ${label} RPC: ${describeError(error)}`,
          );
          codeByEndpoint.push({ label, code: null });
          continue;
        }
        if (code === null) {
          collector.fail(
            `${target.checkId}.code.${label}`,
            codes.codeless,
            `no bytecode at the ${target.name} address on the ${label} RPC`,
          );
        } else {
          collector.pass(
            `${target.checkId}.code.${label}`,
            `${target.name} has bytecode on the ${label} RPC`,
          );
        }
        codeByEndpoint.push({ label, code });
      }
      const [primaryCode, secondaryCode] = codeByEndpoint;
      if (primaryCode.code !== null && secondaryCode.code !== null) {
        if (primaryCode.code !== secondaryCode.code) {
          collector.fail(
            `${target.checkId}.code.agreement`,
            codes.disagreement,
            `${target.name} bytecode differs between the two RPCs`,
          );
        } else {
          collector.pass(
            `${target.checkId}.code.agreement`,
            `${target.name} bytecode is identical on both RPCs`,
          );
        }
      }
    } else {
      collector.skip(
        `${target.checkId}.code`,
        offline
          ? 'offline run requested; bytecode not queried'
          : 'no live dual-RPC probe pair; bytecode not queried',
      );
    }
  }

  // ── 5. RP ID and RP-ID hash ──────────────────────────────────────────────
  const rpId = typeof env.rpId === 'string' ? env.rpId.trim() : '';
  let derivedHash: string | null = null;
  if (rpId === '') {
    collector.fail('rp.id', 'RP_ID_MISSING', 'RP ID is empty');
  } else if (!RP_ID_RE.test(rpId)) {
    collector.fail('rp.id', 'RP_ID_MALFORMED', 'RP ID must be a bare registrable host (no scheme, path or port)');
  } else {
    derivedHash = await rpIdToHash(rpId);
    collector.pass('rp.id', `RP ID is a bare host; derived SHA-256 hash ${shortHash(derivedHash)}`);
  }

  const configuredHash = typeof env.rpIdHash === 'string' ? env.rpIdHash.trim() : '';
  if (configuredHash !== '') {
    if (!BYTES32_RE.test(configuredHash)) {
      collector.fail('rp.hash', 'RP_ID_HASH_MALFORMED', 'configured RP-ID hash is not 32-byte hex');
    } else if (derivedHash !== null) {
      if (derivedHash.toLowerCase() !== configuredHash.toLowerCase()) {
        collector.fail(
          'rp.hash',
          'RP_ID_HASH_MISMATCH',
          `configured RP-ID hash ${shortHash(configuredHash)} does not match the hash derived from the RP ID`,
        );
      } else {
        collector.pass('rp.hash', 'configured RP-ID hash matches the derived hash');
      }
    } else {
      collector.skip('rp.hash', 'RP ID is invalid; derived hash unavailable for comparison');
    }
  } else {
    collector.skip('rp.hash', 'no configured RP-ID hash supplied; only the derived hash is reported');
  }

  // ── 6. Verdict lifetime ──────────────────────────────────────────────────
  const lifetimeRaw = env.maxVerdictLifetime;
  const lifetimeText = typeof lifetimeRaw === 'string' ? lifetimeRaw.trim() : String(lifetimeRaw ?? '').trim();
  if (lifetimeText === '' || lifetimeText === 'undefined' || lifetimeText === 'null') {
    collector.fail('verdict.lifetime', 'VERDICT_LIFETIME_MISSING', 'max verdict lifetime is empty');
  } else {
    const parsed = toUint64(lifetimeRaw);
    if (parsed === null) {
      collector.fail(
        'verdict.lifetime',
        'VERDICT_LIFETIME_INVALID',
        'max verdict lifetime is not a non-negative integer',
      );
    } else if (parsed === 0n) {
      collector.fail('verdict.lifetime', 'VERDICT_LIFETIME_INVALID', 'max verdict lifetime must be greater than zero');
    } else if (parsed > UINT64_MAX) {
      collector.fail(
        'verdict.lifetime',
        'VERDICT_LIFETIME_OUT_OF_RANGE',
        'max verdict lifetime is a valid integer but exceeds the uint64 range',
      );
    } else {
      collector.pass('verdict.lifetime', `max verdict lifetime is ${parsed} second(s)`);
    }
  }

  // ── 7. Actor distinctness ────────────────────────────────────────────────
  const actors: Array<{ role: string; value: string }> = [];
  for (const [role, value] of [
    ['deployer', env.deployerAddress],
    ['attestor', env.attestorAddress],
    ['relayer', env.relayerAddress],
  ] as const) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed === '') {
      collector.skip(`actor.${role}`, `${role} address not supplied`);
      continue;
    }
    if (!isAddressLike(trimmed)) {
      collector.fail(`actor.${role}`, 'ACTOR_ADDRESS_MALFORMED', `${role} address is not 20-byte hex`);
      continue;
    }
    if (isZeroAddress(trimmed)) {
      collector.fail(`actor.${role}`, 'ACTOR_ADDRESS_ZERO', `${role} address is the zero address`);
      continue;
    }
    actors.push({ role, value: trimmed.toLowerCase() });
    collector.pass(`actor.${role}`, `${role} address is well-formed and non-zero`);
  }
  if (actors.length >= 2) {
    const seen = new Map<string, string>();
    let collision: [string, string] | null = null;
    for (const actor of actors) {
      const previous = seen.get(actor.value);
      if (previous) {
        collision = [previous, actor.role];
        break;
      }
      seen.set(actor.value, actor.role);
    }
    if (collision) {
      collector.fail(
        'actor.distinct',
        'ACTOR_ADDRESS_COLLISION',
        `${collision[0]} and ${collision[1]} share one address; buyer, provider, evaluator and relayer keys must stay separate`,
      );
    } else {
      collector.pass('actor.distinct', 'all supplied actor addresses are distinct');
    }
  } else {
    collector.skip('actor.distinct', 'fewer than two actor addresses supplied; distinctness not evaluable');
  }

  // ── 8. Artifacts ─────────────────────────────────────────────────────────
  const artifacts = options.artifacts;
  if (!artifacts) {
    collector.skip('artifact.presence', 'no artifacts supplied to the harness');
  } else {
    for (const contractName of CANONICAL_CONTRACTS) {
      // Foundry writes out/<File>.sol/<Contract>.json. Match on the declared
      // contract name first, then on the path, so an artifact whose declared
      // name disagrees with where it sits is reported as a mismatch rather
      // than silently accepted as "missing".
      const artifact =
        artifacts.find((candidate) => candidate.contractName === contractName) ??
        artifacts.find((candidate) =>
          candidate.path.replace(/\\/g, '/').endsWith(`/${contractName}.sol/${contractName}.json`),
        );
      if (!artifact) {
        collector.fail(
          `artifact.${contractName}`,
          'ARTIFACT_MISSING',
          `no artifact found for ${contractName} (run the contract build first)`,
        );
        continue;
      }
      if (artifact.contractName !== contractName) {
        collector.fail(
          `artifact.${contractName}`,
          'ARTIFACT_NAME_MISMATCH',
          `artifact at ${artifact.path} declares contract name ${artifact.contractName}, expected ${contractName}`,
        );
        continue;
      }
      if (!hasBytecode(artifact.bytecode)) {
        collector.fail(
          `artifact.${contractName}`,
          'ARTIFACT_BYTECODE_EMPTY',
          `artifact ${contractName} has empty creation bytecode`,
        );
        continue;
      }
      collector.pass(
        `artifact.${contractName}`,
        `${contractName} artifact present with ${bytecodeLength(artifact.bytecode)} bytes of creation bytecode`,
      );
    }
  }

  // ── 9. Gas limit arithmetic ──────────────────────────────────────────────
  const bufferBps = parseNonNegativeBps(env.gasBufferBps ?? 0);
  try {
    const baseline = parseGasEstimate(env.gasEstimate) ?? GAS_CHECK_BASELINE;
    const decision = resolveGasLimit(baseline, bufferBps);
    const capCode = checkGasLimitWithinTxCap(decision.requestedGasLimit);
    if (capCode) {
      collector.fail(
        'gas.buffer',
        capCode,
        `gas limit ${decision.requestedGasLimit} exceeds the Monad transaction gas cap of ${MONAD_TX_GAS_LIMIT_CAP}`,
      );
    } else {
      collector.pass(
        'gas.buffer',
        `gas buffer ${decision.bufferBps} bps (${decision.bufferPercent}) over a ${baseline} estimate requests ${decision.requestedGasLimit} gas, within the ${MAX_GAS_BUFFER_BPS} bps cap and the ${MONAD_TX_GAS_LIMIT_CAP} gas transaction cap`,
      );
    }
  } catch (error) {
    if (error instanceof GasBufferError) {
      collector.fail('gas.buffer', error.code, error.message);
    } else {
      throw error;
    }
  }

  const failures = collector.failures;
  const ready = failures.length === 0;
  return {
    status: ready ? READINESS_STATUS.READY : READINESS_STATUS.NOT_READY,
    ready,
    mode,
    expectedChainId: EXPECTED_CHAIN_ID,
    observedChainIds,
    timestamp: Date.now(),
    checks: collector.checks,
    failures,
    authorization: 'NOT_GRANTED',
  };
}

// ===========================================================================
// Report rendering
// ===========================================================================

/**
 * Render a readiness report as redacted, machine-readable JSON.
 *
 * The output never contains an RPC URL, an API key, a private key, a signed
 * transaction, a credential ID, a salt, PRF output or an evidence payload.
 *
 * `expectedChainId` is the configured expectation and is identical on every
 * execution path; `observedChainIds` holds what each live endpoint actually
 * returned, or null when that endpoint was not queried. The two are never
 * conflated, so a consumer cannot read a chain observation into the expectation.
 */
export function serializeReadinessReport(report: ReadinessReport): string {
  return JSON.stringify(
    {
      schema: 'xyx-deployment-readiness',
      version: '2',
      status: report.status,
      ready: report.ready,
      mode: report.mode,
      expectedChainId: report.expectedChainId,
      observedChainIds: {
        primary: report.observedChainIds.primary,
        secondary: report.observedChainIds.secondary,
      },
      timestamp: report.timestamp,
      authorization: report.authorization,
      failures: report.failures,
      checks: report.checks.map((check) => ({
        id: check.id,
        status: check.status,
        code: check.code,
        detail: check.detail,
      })),
    },
    null,
    2,
  );
}

/**
 * Assert that a serialized report carries no secret-bearing environment key.
 * Throws when a secret-named key appears anywhere in the payload.
 */
export function assertReportHasNoSecrets(serialized: string, secretKeys: readonly string[]): void {
  for (const key of secretKeys) {
    if (serialized.includes(key)) {
      throw new Error(`SECRET_LEAK: serialized report contains secret-bearing key ${key}`);
    }
  }
}

// ===========================================================================
// Small utilities
// ===========================================================================

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Redact any URL the transport echoed before truncating, so an RPC path or
  // query token can never survive into a report or a log line.
  return redactUrlsInText(raw).slice(0, 200);
}

function shortHash(hash: string): string {
  return hash.length <= 18 ? hash : `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function bytecodeLength(bytecode: string): number {
  const hex = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  return Math.floor(hex.length / 2);
}
