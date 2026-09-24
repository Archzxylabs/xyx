/**
 * Tests for the non-broadcast deployment-readiness harness (deployment-readiness.ts).
 *
 * Every RPC-dependent test injects a mock probe PAIR — one probe per endpoint,
 * each a distinct object configured independently. Nothing in this file opens a
 * network connection, and the suite must stay runnable with no Testnet access.
 *
 * No mock in this file keys off how many times it has been called. Call-order
 * mocks are what let the previous harness query one endpoint twice and report
 * the result as dual-RPC agreement, so the doubles below are per-endpoint by
 * construction instead.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MAX_GAS_BUFFER_BPS,
  NATIVE_TRANSFER_GAS_LIMIT,
  READINESS_FAILURE_CODES,
  READINESS_STATUS,
  GasBufferError,
  assertReportHasNoSecrets,
  checkGasLimitWithinTxCap,
  isSecretEnvName,
  normalizeEndpoint,
  redactRpcUrl,
  redactUrlsInText,
  resolveGasLimit,
  rpIdToHash,
  runReadiness,
  serializeReadinessReport,
  type ReadinessArtifact,
  type ReadinessEnv,
  type ReadinessRpcProbe,
  type ReadinessRpcProbes,
} from '../src/deployment-readiness';

// ===========================================================================
// Fixtures
// ===========================================================================

const TOKEN = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
const VERIFIER = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';
const PROTOCOL = '0x3333333333333333333333333333333333333333';
const DEPLOYER = '0x4444444444444444444444444444444444444444';
const ATTESTOR = '0x5555555555555555555555555555555555555555';
const RELAYER = '0x6666666666666666666666666666666666666666';

const ZERO = '0x0000000000000000000000000000000000000000';
const LIVE_BYTECODE = '0x6080604052';

const RP_ID = 'monad.xyz';
const RP_ID_HASH = '0x' + 'ab'.repeat(32);

function baseEnv(overrides: Partial<ReadinessEnv> = {}): ReadinessEnv {
  return {
    primaryRpcUrl: 'https://rpc-primary.example.com',
    secondaryRpcUrl: 'https://rpc-secondary.example.com',
    paymentTokenAddress: TOKEN,
    rpId: RP_ID,
    maxVerdictLifetime: 300,
    ...overrides,
  };
}

interface MockProbeOptions {
  /** Chain ID this endpoint reports. Defaults to the Monad Testnet ID. */
  chainId?: number;
  /** Bytecode this endpoint reports, keyed by lowercase address. */
  code?: Record<string, string>;
  /** decimals() this endpoint reports. Defaults to the expected 6. */
  decimals?: number;
  /** Reject every method with this message, as an unreachable endpoint would. */
  failChainId?: boolean;
  failGetCode?: string;
  failCall?: boolean;
}

/**
 * A read-only probe double for ONE endpoint. It records every method it was
 * asked for so tests can assert that nothing outside the read-only surface was
 * ever touched, and it answers from its own configuration rather than from how
 * often it has been called, so two probes built from it genuinely behave as two
 * independent endpoints.
 */
function createMockProbe(
  endpoint: 'primary' | 'secondary',
  options: MockProbeOptions = {},
): ReadinessRpcProbe & { calls: string[]; endpoint: 'primary' | 'secondary' } {
  const calls: string[] = [];
  const chainId = options.chainId ?? 10143;
  const probe: ReadinessRpcProbe & { calls: string[]; endpoint: 'primary' | 'secondary' } = {
    calls,
    endpoint,
    async chainId(): Promise<number> {
      calls.push('chainId');
      if (options.failChainId) throw new Error(`${endpoint} RPC refused: connection refused`);
      return chainId;
    },
    async getCode(address): Promise<`0x${string}`> {
      calls.push(`getCode:${address}`);
      if (options.failGetCode && address.toLowerCase() === options.failGetCode.toLowerCase()) {
        throw new Error('getCode failed');
      }
      const code = options.code?.[address.toLowerCase()];
      return (code ?? LIVE_BYTECODE) as `0x${string}`;
    },
    async call(to, data): Promise<`0x${string}`> {
      calls.push(`call:${to}:${data}`);
      if (options.failCall) throw new Error('call reverted');
      // decimals() -> uint8
      if (data === '0x313ce567') {
        const decimals = options.decimals ?? 6;
        return `0x${decimals.toString(16).padStart(64, '0')}` as `0x${string}`;
      }
      return '0x' as `0x${string}`;
    },
  };
  return probe;
}

/** Two distinct probes answering alike, for the common "both endpoints agree" case. */
function mockProbes(options: MockProbeOptions = {}): ReadinessRpcProbes {
  return {
    primary: createMockProbe('primary', options),
    secondary: createMockProbe('secondary', options),
  };
}

/** Two distinct probes configured independently, for the disagreement cases. */
function mockProbePair(
  primary: MockProbeOptions,
  secondary: MockProbeOptions,
): ReadinessRpcProbes & { primary: ReturnType<typeof createMockProbe>; secondary: ReturnType<typeof createMockProbe> } {
  return {
    primary: createMockProbe('primary', primary),
    secondary: createMockProbe('secondary', secondary),
  };
}

/** How many times a probe was asked for this method. Addresses compare case-insensitively. */
function countCall(calls: readonly string[], method: string): number {
  const want = method.toLowerCase();
  return calls.filter((call) => call.toLowerCase() === want).length;
}

function artifact(contractName: string, bytecode = LIVE_BYTECODE): ReadinessArtifact {  return { path: `out/${contractName}.sol/${contractName}.json`, contractName, bytecode };
}

const ALL_ARTIFACTS = [
  artifact('MonadP256Verifier'),
  artifact('XYXPasskeyRegistry'),
  artifact('XYXDeliveryProtocol'),
];

function codes(report: { failures: readonly string[] }): string[] {
  return [...report.failures];
}

// ===========================================================================
// 1. Wrong chain ID
// ===========================================================================

test('readiness: RPC reporting a chain ID other than 10143 fails with CHAIN_ID_MISMATCH', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbes({ chainId: 1 }) });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('CHAIN_ID_MISMATCH'));
  // The expectation never moves: it is what the harness is built for, not what
  // the endpoint said. The observed value is the one that was wrong.
  assert.equal(report.expectedChainId, 10143, 'the expected chain ID stays 10143');
  assert.equal(report.observedChainIds.primary, 1, 'the observed chain ID is preserved');
  assert.equal(report.observedChainIds.secondary, 1, 'the secondary observation is preserved');
});

test('readiness: RPCs disagreeing on chain ID fails with CHAIN_ID_DISAGREEMENT', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbePair({ chainId: 10143 }, { chainId: 10144 }),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('CHAIN_ID_DISAGREEMENT'));
});

test('readiness: a probe that cannot be reached fails with RPC_PROBE_FAILED, not a crash', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbes({ failChainId: true }) });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RPC_PROBE_FAILED'));
});

test('readiness: an unreachable secondary RPC still fails closed', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbePair({ chainId: 10143 }, { failChainId: true }),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RPC_PROBE_FAILED'));
});

// ===========================================================================
// 2. Identical primary and secondary RPC endpoint
// ===========================================================================

test('readiness: identical primary and secondary endpoints fail with RPC_ENDPOINTS_IDENTICAL', async () => {
  const report = await runReadiness(
    baseEnv({
      primaryRpcUrl: 'https://rpc.example.com/v1/abc',
      secondaryRpcUrl: 'https://rpc.example.com/v1/abc/',
    }),
    { probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RPC_ENDPOINTS_IDENTICAL'));
});

test('readiness: endpoints that differ only by a path or query are still one endpoint', async () => {
  const report = await runReadiness(
    baseEnv({
      primaryRpcUrl: 'https://rpc.example.com/v1/abc?apiKey=secret',
      secondaryRpcUrl: 'https://rpc.example.com/v2/xyz',
    }),
    { probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RPC_ENDPOINTS_IDENTICAL'));
});

test('readiness: genuinely distinct endpoints pass', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.READY);
  assert.deepEqual(codes(report), []);
});

// ===========================================================================
// 2b. Endpoint separation
//
// The failure this section exists to prevent: a run that queries ONE endpoint
// twice and reports the result as "both RPCs agree". Every test below supplies
// the pair per endpoint, so a wire-up that reuses a single probe, supplies half
// a pair, or skips the chain entirely cannot pass.
// ===========================================================================

test('endpoint separation: one probe object supplied for both sides fails with RPC_PROBE_REUSED', async () => {
  const shared = createMockProbe('primary');
  const report = await runReadiness(baseEnv(), { probes: { primary: shared, secondary: shared } });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RPC_PROBE_REUSED'));
  assert.deepEqual(shared.calls, [], 'a reused probe must not be queried at all');
});

test('endpoint separation: a half-supplied pair fails with LIVE_DUAL_RPC_PROBE_REQUIRED', async () => {
  const primary = createMockProbe('primary');
  const report = await runReadiness(baseEnv(), {
    probes: { primary } as unknown as ReadinessRpcProbes,
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.equal(report.authorization, 'NOT_GRANTED');
  assert.ok(codes(report).includes('LIVE_DUAL_RPC_PROBE_REQUIRED'));
  assert.deepEqual(primary.calls, [], 'the one probe that was supplied must not be queried');
});

test('endpoint separation: no probe pair at all fails with LIVE_DUAL_RPC_PROBE_REQUIRED', async () => {
  const report = await runReadiness(baseEnv());
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('LIVE_DUAL_RPC_PROBE_REQUIRED'));
  // Configuration-only checks may still pass; nothing read from a chain may.
  const chainReadChecks = report.checks.filter(
    (check) =>
      check.id === 'chain.id' ||
      check.id === 'chain.agreement' ||
      check.id.startsWith('token.code') ||
      check.id.startsWith('token.decimals'),
  );
  assert.equal(chainReadChecks.some((check) => check.status === 'pass'), false);
});

test('endpoint separation: offline never queries a perfectly good probe pair', async () => {
  const primary = createMockProbe('primary');
  const secondary = createMockProbe('secondary');
  const report = await runReadiness(baseEnv(), { offline: true, probes: { primary, secondary } });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('LIVE_DUAL_RPC_PROBE_REQUIRED'));
  assert.deepEqual(primary.calls, []);
  assert.deepEqual(secondary.calls, []);
});

test('endpoint separation: token bytecode that differs per endpoint fails with TOKEN_CODE_DISAGREEMENT', async () => {
  const probes = mockProbePair({}, { code: { [TOKEN.toLowerCase()]: '0xdeadbeef' } });
  const report = await runReadiness(baseEnv(), { probes });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('TOKEN_CODE_DISAGREEMENT'));
  // Both endpoints were really asked; agreement was computed, not assumed.
  assert.equal(countCall(probes.primary.calls, `getCode:${TOKEN}`), 1);
  assert.equal(countCall(probes.secondary.calls, `getCode:${TOKEN}`), 1);
});

test('endpoint separation: token decimals that differ per endpoint fails with TOKEN_DECIMALS_DISAGREEMENT', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbePair({ decimals: 6 }, { decimals: 18 }) });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('TOKEN_DECIMALS_DISAGREEMENT'));
});

test('endpoint separation: canonical trio bytecode that differs per endpoint fails closed', async () => {
  const probes = mockProbePair({}, { code: { [VERIFIER.toLowerCase()]: '0xdeadbeef' } });
  const report = await runReadiness(
    baseEnv({ p256VerifierAddress: VERIFIER, registryAddress: REGISTRY, protocolAddress: PROTOCOL }),
    { mode: 'post-deploy', probes },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('VERIFIER_CODE_DISAGREEMENT'));
  // The other two canonical contracts still agree, so only the verifier is reported.
  assert.ok(!codes(report).includes('REGISTRY_CODE_DISAGREEMENT'));
  assert.ok(!codes(report).includes('PROTOCOL_CODE_DISAGREEMENT'));
});

test('endpoint separation: each endpoint is queried once, never twice', async () => {
  const probes = mockProbePair({}, {});
  await runReadiness(
    baseEnv({ p256VerifierAddress: VERIFIER, registryAddress: REGISTRY, protocolAddress: PROTOCOL }),
    { mode: 'post-deploy', probes, artifacts: ALL_ARTIFACTS },
  );
  const chainIds = (probe: { calls: string[] }): number =>
    probe.calls.filter((call) => call === 'chainId').length;
  assert.equal(chainIds(probes.primary), 1, 'primary endpoint read exactly once');
  assert.equal(chainIds(probes.secondary), 1, 'secondary endpoint read exactly once');
  // The token address was read once from each endpoint — two reads in total,
  // never one endpoint answering for the other.
  const tokenReads =
    countCall(probes.primary.calls, `getCode:${TOKEN}`) + countCall(probes.secondary.calls, `getCode:${TOKEN}`);
  assert.equal(tokenReads, 2);
});

test('endpoint separation: an RPC error message never leaks a URL into the report', async () => {
  const leaky = 'connect ECONNREFUSED https://user:hunter2@rpc.example.com:8543/v1/key?token=supersecret';
  const probes = mockProbePair({}, {});
  probes.secondary.chainId = async () => {
    probes.secondary.calls.push('chainId');
    throw new Error(leaky);
  };
  const report = await runReadiness(baseEnv(), { probes });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RPC_PROBE_FAILED'));
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('hunter2'), 'userinfo must be redacted');
  assert.ok(!serialized.includes('supersecret'), 'query tokens must be redacted');
  assert.ok(!serialized.includes('/v1/key'), 'the URL path must be redacted');
  assert.ok(!serialized.includes('rpc.example.com:8543/v1'), 'the full URL must be redacted');
  assert.equal(redactUrlsInText(leaky), 'connect ECONNREFUSED https://rpc.example.com:8543');
});

// ===========================================================================
// 3. Missing / malformed / zero addresses and RP ID hash
// ===========================================================================

test('readiness: empty payment token fails with TOKEN_ADDRESS_MISSING', async () => {
  const report = await runReadiness(baseEnv({ paymentTokenAddress: '' }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('TOKEN_ADDRESS_MISSING'));
});

test('readiness: malformed payment token fails with TOKEN_ADDRESS_MALFORMED', async () => {
  const report = await runReadiness(baseEnv({ paymentTokenAddress: '0xnothex' }), {
    probes: mockProbes(),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('TOKEN_ADDRESS_MALFORMED'));
});

test('readiness: zero payment token fails with TOKEN_ADDRESS_ZERO', async () => {
  const report = await runReadiness(baseEnv({ paymentTokenAddress: ZERO }), {
    probes: mockProbes(),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('TOKEN_ADDRESS_ZERO'));
});

test('readiness: zero verifier fails with VERIFIER_ADDRESS_MALFORMED in post-deploy mode', async () => {
  const report = await runReadiness(
    baseEnv({
      p256VerifierAddress: ZERO,
      registryAddress: REGISTRY,
      protocolAddress: PROTOCOL,
    }),
    { mode: 'post-deploy', probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('VERIFIER_ADDRESS_MALFORMED'));
});

test('readiness: malformed registry fails with REGISTRY_ADDRESS_MALFORMED', async () => {
  const report = await runReadiness(
    baseEnv({ registryAddress: 'XYXPasskeyRegistry' }),
    { mode: 'post-deploy', probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('REGISTRY_ADDRESS_MALFORMED'));
});

test('readiness: missing protocol address fails with PROTOCOL_ADDRESS_MISSING in post-deploy mode', async () => {
  const report = await runReadiness(
    baseEnv({ p256VerifierAddress: VERIFIER, registryAddress: REGISTRY, protocolAddress: '' }),
    { mode: 'post-deploy', probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('PROTOCOL_ADDRESS_MISSING'));
});

test('readiness: malformed protocol address fails with PROTOCOL_ADDRESS_MALFORMED', async () => {
  const report = await runReadiness(
    baseEnv({ p256VerifierAddress: VERIFIER, registryAddress: REGISTRY, protocolAddress: '0x1234' }),
    { mode: 'post-deploy', probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('PROTOCOL_ADDRESS_MALFORMED'));
});

test('readiness: canonical addresses are optional and skipped in pre-deploy mode', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbes() });
  const skipped = report.checks.filter((check) => check.status === 'skip').map((check) => check.id);
  assert.ok(skipped.includes('protocol.address'));
  assert.ok(skipped.includes('registry.address'));
  assert.ok(skipped.includes('verifier.address'));
  assert.equal(report.status, READINESS_STATUS.READY);
});

test('readiness: malformed RP ID fails with RP_ID_MALFORMED', async () => {
  const report = await runReadiness(baseEnv({ rpId: 'monad.xyz/some/path' }), {
    probes: mockProbes(),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RP_ID_MALFORMED'));
});

test('readiness: RP ID with a scheme or port fails with RP_ID_MALFORMED', async () => {
  for (const bad of ['https://monad.xyz', 'monad.xyz:8443']) {
    const report = await runReadiness(baseEnv({ rpId: bad }), { probes: mockProbes() });
    assert.equal(report.status, READINESS_STATUS.NOT_READY, `expected ${bad} to be rejected`);
    assert.ok(codes(report).includes('RP_ID_MALFORMED'), `expected ${bad} to be rejected`);
  }
});

test('readiness: empty RP ID fails with RP_ID_MISSING', async () => {
  const report = await runReadiness(baseEnv({ rpId: '' }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RP_ID_MISSING'));
});

test('readiness: malformed RP ID hash fails with RP_ID_HASH_MALFORMED', async () => {
  const report = await runReadiness(baseEnv({ rpIdHash: '0xabcd' }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RP_ID_HASH_MALFORMED'));
});

test('readiness: configured RP ID hash that disagrees with the derived hash fails with RP_ID_HASH_MISMATCH', async () => {
  const report = await runReadiness(baseEnv({ rpIdHash: RP_ID_HASH }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RP_ID_HASH_MISMATCH'));
});

test('readiness: a correct configured RP ID hash passes', async () => {
  const derived = await rpIdToHash(RP_ID);
  const report = await runReadiness(baseEnv({ rpIdHash: derived }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.READY);
  assert.equal(report.failures.length, 0);
});

test('rpIdToHash derives the SHA-256 hash the deploy script computes', async () => {
  const { createHash } = await import('node:crypto');
  const expected = `0x${createHash('sha256').update(RP_ID, 'utf8').digest('hex')}`;
  assert.equal(await rpIdToHash(RP_ID), expected);
  assert.equal((await rpIdToHash(RP_ID)).length, 66);
});

// ===========================================================================
// 4. Wrong token decimals
// ===========================================================================

test('readiness: token reporting the wrong decimals fails with TOKEN_DECIMALS_MISMATCH', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes({ decimals: 18 }),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('TOKEN_DECIMALS_MISMATCH'));
});

test('readiness: token whose decimals() reverts fails with TOKEN_DECIMALS_UNREADABLE', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbes({ failCall: true }) });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('TOKEN_DECIMALS_UNREADABLE'));
});

test('readiness: an explicit expected decimals value is honoured', async () => {
  const report = await runReadiness(baseEnv({ expectedTokenDecimals: 18 }), {
    probes: mockProbes({ decimals: 18 }),
  });
  assert.equal(report.status, READINESS_STATUS.READY);
});

// ===========================================================================
// 5. Missing bytecode
// ===========================================================================

test('readiness: token with no bytecode fails with TOKEN_CODE_MISSING', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes({ code: { [TOKEN.toLowerCase()]: '0x' } }),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('TOKEN_CODE_MISSING'));
});

test('readiness: canonical address with no bytecode fails with *_CODE_MISSING', async () => {
  const report = await runReadiness(
    baseEnv({ p256VerifierAddress: VERIFIER, registryAddress: REGISTRY, protocolAddress: PROTOCOL }),
    { mode: 'post-deploy', probes: mockProbes({ code: { [PROTOCOL.toLowerCase()]: '0x' } }) },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('PROTOCOL_CODE_MISSING'));
});

test('readiness: differing token bytecode across RPCs fails with TOKEN_CODE_DISAGREEMENT', async () => {
  // The two endpoints answer the same request differently. Only a report that
  // queried both of them can notice this.
  const report = await runReadiness(baseEnv(), {
    probes: mockProbePair({}, { code: { [TOKEN.toLowerCase()]: '0xdeadbeef' } }),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('TOKEN_CODE_DISAGREEMENT'));
});

// ===========================================================================
// 6. Actor address collisions
// ===========================================================================

test('readiness: deployer and attestor sharing an address fails with ACTOR_ADDRESS_COLLISION', async () => {
  const report = await runReadiness(
    baseEnv({ deployerAddress: DEPLOYER, attestorAddress: DEPLOYER, relayerAddress: RELAYER }),
    { probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('ACTOR_ADDRESS_COLLISION'));
});

test('readiness: attestor and relayer sharing an address fails with ACTOR_ADDRESS_COLLISION', async () => {
  const report = await runReadiness(
    baseEnv({ deployerAddress: DEPLOYER, attestorAddress: ATTESTOR, relayerAddress: ATTESTOR }),
    { probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('ACTOR_ADDRESS_COLLISION'));
});

test('readiness: distinct actor addresses pass', async () => {
  const report = await runReadiness(
    baseEnv({ deployerAddress: DEPLOYER, attestorAddress: ATTESTOR, relayerAddress: RELAYER }),
    { probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.READY);
});

test('readiness: a zero actor address fails with ACTOR_ADDRESS_ZERO', async () => {
  const report = await runReadiness(
    baseEnv({ deployerAddress: DEPLOYER, attestorAddress: ZERO, relayerAddress: RELAYER }),
    { probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('ACTOR_ADDRESS_ZERO'));
});

test('readiness: a malformed actor address fails with ACTOR_ADDRESS_MALFORMED', async () => {
  const report = await runReadiness(
    baseEnv({ deployerAddress: 'not-an-address', attestorAddress: ATTESTOR }),
    { probes: mockProbes() },
  );
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('ACTOR_ADDRESS_MALFORMED'));
});

// ===========================================================================
// 7. Verdict lifetime
// ===========================================================================

test('readiness: a zero verdict lifetime fails with VERDICT_LIFETIME_INVALID', async () => {
  const report = await runReadiness(baseEnv({ maxVerdictLifetime: 0 }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('VERDICT_LIFETIME_INVALID'));
});

test('readiness: a negative verdict lifetime fails with VERDICT_LIFETIME_INVALID', async () => {
  const report = await runReadiness(baseEnv({ maxVerdictLifetime: -1 }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('VERDICT_LIFETIME_INVALID'));
});

test('readiness: a non-numeric verdict lifetime fails with VERDICT_LIFETIME_INVALID', async () => {
  const report = await runReadiness(baseEnv({ maxVerdictLifetime: 'soon' }), {
    probes: mockProbes(),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('VERDICT_LIFETIME_INVALID'));
});

test('readiness: an empty verdict lifetime fails with VERDICT_LIFETIME_MISSING', async () => {
  const report = await runReadiness(baseEnv({ maxVerdictLifetime: '' }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('VERDICT_LIFETIME_MISSING'));
});

test('readiness: a verdict lifetime above uint64 fails with VERDICT_LIFETIME_OUT_OF_RANGE', async () => {
  const report = await runReadiness(baseEnv({ maxVerdictLifetime: 2n ** 64n }), {
    probes: mockProbes(),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('VERDICT_LIFETIME_OUT_OF_RANGE'));
});

// ===========================================================================
// 8. Artifacts
// ===========================================================================

test('readiness: a missing canonical artifact fails with ARTIFACT_MISSING', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes(),
    artifacts: [artifact('MonadP256Verifier'), artifact('XYXDeliveryProtocol')],
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('ARTIFACT_MISSING'));
});

test('readiness: an artifact declaring the wrong contract name fails with ARTIFACT_NAME_MISMATCH', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes(),
    artifacts: [
      artifact('MonadP256Verifier'),
      // The artifact sits at the canonical Foundry path but declares a
      // different contract name — a stale or hand-edited artifact.
      {
        path: 'out/XYXPasskeyRegistry.sol/XYXPasskeyRegistry.json',
        contractName: 'XYXPasskeyRegistryV2',
        bytecode: LIVE_BYTECODE,
      },
      artifact('XYXDeliveryProtocol'),
    ],
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('ARTIFACT_NAME_MISMATCH'));
});

test('readiness: an artifact with empty bytecode fails with ARTIFACT_BYTECODE_EMPTY', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes(),
    artifacts: [...ALL_ARTIFACTS.slice(0, 2), artifact('XYXDeliveryProtocol', '0x')],
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('ARTIFACT_BYTECODE_EMPTY'));
});

test('readiness: all three canonical artifacts present passes the artifact checks', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbes(), artifacts: ALL_ARTIFACTS });
  assert.equal(report.status, READINESS_STATUS.READY);
});

test('readiness: legacy contract artifacts are not accepted as canonical substitutes', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes(),
    artifacts: [artifact('AgenticCommerce'), artifact('XYXEvaluator'), artifact('Deploy')],
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('ARTIFACT_MISSING'));
});

// ===========================================================================
// 9. Preflight never broadcasts
// ===========================================================================

test('readiness: the probes are only ever asked for read-only methods', async () => {
  const primary = createMockProbe('primary');
  const secondary = createMockProbe('secondary');
  await runReadiness(
    baseEnv({ p256VerifierAddress: VERIFIER, registryAddress: REGISTRY, protocolAddress: PROTOCOL }),
    { mode: 'post-deploy', probes: { primary, secondary }, artifacts: ALL_ARTIFACTS },
  );
  const calls = [...primary.calls, ...secondary.calls];
  const forbidden = ['sendTransaction', 'sendRawTransaction', 'eth_sendTransaction', 'eth_sendRawTransaction'];
  for (const call of calls) {
    for (const method of forbidden) {
      assert.ok(!call.includes(method), `a probe was asked for ${method}`);
    }
  }
  assert.ok(calls.every((call) => call.startsWith('chainId') || call.startsWith('getCode:') || call.startsWith('call:')));
});

/**
 * Strip comments so the source guards below inspect executable code rather
 * than the prose that explains why a call is forbidden.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Tokens that must never appear in executable code in the readiness harness or
 * its CLI. Comments and prose are stripped first, so this inspects real call
 * sites rather than the documentation explaining why they are forbidden.
 */
const FORBIDDEN_CALLS = [
  'sendTransaction(',
  'sendRawTransaction(',
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'cast wallet',
  'faucet',
  'privateKey',
  'private_key',
  'child_process',
  'execSync',
  'spawnSync',
  'wallet import',
];

test('readiness: the harness source contains no state-changing entry point', () => {
  const source = stripComments(
    readFileSync(new URL('../src/deployment-readiness.ts', import.meta.url), 'utf8'),
  );
  for (const forbidden of FORBIDDEN_CALLS) {
    assert.ok(!source.includes(forbidden), `deployment-readiness.ts must not call ${forbidden}`);
  }
});

test('readiness: the CLI source contains no state-changing entry point', () => {
  const source = stripComments(
    readFileSync(new URL('../../../scripts/deployment-readiness.ts', import.meta.url), 'utf8'),
  );
  for (const forbidden of FORBIDDEN_CALLS) {
    assert.ok(!source.includes(forbidden), `scripts/deployment-readiness.ts must not call ${forbidden}`);
  }
});

test('readiness: an offline run can never report READY', async () => {
  // An offline run reads nothing from the chain, so it has no evidence of
  // dual-RPC agreement to report. It must be NOT_READY even when every
  // configuration check passes, and it must say why.
  const report = await runReadiness(baseEnv(), { offline: true });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.equal(report.authorization, 'NOT_GRANTED');
  assert.ok(codes(report).includes('LIVE_DUAL_RPC_PROBE_REQUIRED'));
  const skipped = report.checks.filter((check) => check.status === 'skip').map((check) => check.id);
  assert.ok(skipped.includes('chain.id'));
  assert.ok(skipped.includes('token.code'));
  assert.ok(skipped.includes('token.decimals'));
});

// ===========================================================================
// 10. Gas safety
// ===========================================================================

test('resolveGasLimit: a zero buffer requests exactly the estimate', () => {
  const decision = resolveGasLimit(1_234_567n, 0n);
  assert.equal(decision.requestedGasLimit, 1_234_567n);
  assert.equal(decision.bufferPercent, '0.0%');
});

test('resolveGasLimit: a 10% buffer is the maximum allowed', () => {
  const decision = resolveGasLimit(1_000_000n, MAX_GAS_BUFFER_BPS);
  assert.equal(decision.requestedGasLimit, 1_100_000n);
  assert.equal(decision.bufferPercent, '10.0%');
});

test('resolveGasLimit: a buffer above 10% throws GAS_BUFFER_TOO_LARGE', () => {
  assert.throws(
    () => resolveGasLimit(1_000_000n, MAX_GAS_BUFFER_BPS + 1n),
    (error: unknown) =>
      error instanceof GasBufferError &&
      error.code === READINESS_FAILURE_CODES.GAS_BUFFER_TOO_LARGE,
  );
});

test('resolveGasLimit: an oversized buffer fails the readiness report', async () => {
  const report = await runReadiness(baseEnv({ gasBufferBps: 1500 }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('GAS_BUFFER_TOO_LARGE'));
});

test('resolveGasLimit: a negative buffer throws GAS_BUFFER_INVALID', () => {
  assert.throws(
    () => resolveGasLimit(1_000_000n, -1n),
    (error: unknown) => error instanceof GasBufferError && error.code === 'GAS_BUFFER_INVALID',
  );
});

test('checkGasLimitWithinTxCap: a limit above the Monad transaction cap is rejected', () => {
  assert.equal(checkGasLimitWithinTxCap(30_000_001n), 'GAS_LIMIT_ABOVE_TX_CAP');
  assert.equal(checkGasLimitWithinTxCap(30_000_000n), null);
});

test('NATIVE_TRANSFER_GAS_LIMIT is 21000 and is documented as transfer-only', () => {
  assert.equal(NATIVE_TRANSFER_GAS_LIMIT, 21_000n);
});

test('readiness: a supplied gas estimate is reflected in the reported limit', async () => {
  const report = await runReadiness(baseEnv({ gasBufferBps: 1000, gasEstimate: 2_400_000 }), {
    probes: mockProbes(),
  });
  const detail = report.checks.find((check) => check.id === 'gas.buffer')?.detail ?? '';
  assert.ok(detail.includes('2400000'), detail);
  assert.ok(detail.includes('2640000'), detail);
  assert.equal(report.status, READINESS_STATUS.READY);
});

test('readiness: an estimate above the transaction cap is reported, not silently clamped', async () => {
  const report = await runReadiness(baseEnv({ gasBufferBps: 0, gasEstimate: 30_000_001 }), {
    probes: mockProbes(),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('GAS_LIMIT_ABOVE_TX_CAP'));
});

test('readiness: a non-numeric gas buffer fails with GAS_BUFFER_INVALID', async () => {
  const report = await runReadiness(baseEnv({ gasBufferBps: 'plenty' }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('GAS_BUFFER_INVALID'));
});

test('readiness: a negative gas buffer fails with GAS_BUFFER_INVALID', async () => {
  const report = await runReadiness(baseEnv({ gasBufferBps: -1 }), { probes: mockProbes() });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('GAS_BUFFER_INVALID'));
});

// ===========================================================================
// 11. Secret redaction
// ===========================================================================

test('readiness: a secret-bearing deployment env key fails with SECRET_ENV_KEY_PRESENT', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes(),
    artifacts: ALL_ARTIFACTS,
    rawEnvKeys: ['PATH', 'MONAD_RELAYER_PRIVATE_KEY', 'DEPLOYER_MNEMONIC'],
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('SECRET_ENV_KEY_PRESENT'));
  // The report must say how many, never which.
  const detail = report.checks.find((check) => check.id === 'env.secrets')?.detail ?? '';
  assert.ok(detail.includes('2'));
  assert.ok(!detail.includes('MONAD_RELAYER_PRIVATE_KEY'));
  assert.ok(!detail.includes('DEPLOYER_MNEMONIC'));
});

test('readiness: ambient shell secret-named variables do not fail deployment readiness', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes(),
    artifacts: ALL_ARTIFACTS,
    rawEnvKeys: ['PATH', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK'],
  });
  assert.equal(report.status, READINESS_STATUS.READY);
});

test('readiness: no secret-bearing environment key name appears in the JSON report', async () => {
  const secretKeys = [
    'MONAD_RELAYER_PRIVATE_KEY',
    'DEPLOYER_PRIVATE_KEY',
    'ATTESTOR_MNEMONIC',
    'XYX_PRF_SECRET',
    'MONADSCAN_API_KEY',
    'WEB_AUTH_CREDENTIAL_ID',
    'EVIDENCE_SALT',
  ];
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes(),
    artifacts: ALL_ARTIFACTS,
    rawEnvKeys: ['PATH', 'XYX_RP_ID', ...secretKeys],
  });
  const serialized = serializeReadinessReport(report);
  // The report counts offending keys but never names them, so no
  // credential-bearing variable name can leak into CI logs or a shared report.
  assertReportHasNoSecrets(serialized, secretKeys);
  for (const key of secretKeys) {
    assert.ok(!serialized.includes(key), `report must not contain ${key}`);
  }
});

test('readiness: a clean environment produces a report with no secret keys', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbes(),
    artifacts: ALL_ARTIFACTS,
    rawEnvKeys: ['PATH', 'HOME', 'XYX_RP_ID', 'MONAD_USDC_ADDRESS'],
  });
  assert.equal(report.status, READINESS_STATUS.READY);
  const serialized = serializeReadinessReport(report);
  assertReportHasNoSecrets(serialized, ['MONAD_RELAYER_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY']);
  assert.ok(!serialized.includes('privateKey'));
});

test('readiness: RPC URLs are never printed in the report', async () => {
  const report = await runReadiness(
    baseEnv({
      primaryRpcUrl: 'https://primary.example.com/v2/SECRETAPIKEY',
      secondaryRpcUrl: 'https://secondary.example.com/v2/OTHERKEY',
    }),
    { probes: mockProbes() },
  );
  const serialized = serializeReadinessReport(report);
  assert.ok(!serialized.includes('SECRETAPIKEY'));
  assert.ok(!serialized.includes('OTHERKEY'));
  assert.ok(!serialized.includes('primary.example.com/v2'));
});

test('readiness: a failing report never echoes an address or RP ID verbatim', async () => {
  const report = await runReadiness(baseEnv({ rpId: 'internal.example.com' }), {
    probes: mockProbes({ decimals: 18 }),
  });
  const serialized = serializeReadinessReport(report);
  assert.ok(serialized.includes('TOKEN_DECIMALS_MISMATCH'));
  // RP IDs are public configuration, but a failing report must not become a
  // place where operator-internal hostnames accumulate unnoticed.
  assert.ok(!serialized.includes('internal.example.com'));
});

test('redactRpcUrl drops userinfo, path and query', () => {
  assert.equal(redactRpcUrl('https://user:pass@rpc.example.com/v2/key'), 'https://rpc.example.com');
  assert.equal(redactRpcUrl('http://127.0.0.1:8545'), 'http://127.0.0.1:8545');
  assert.equal(redactRpcUrl('not a url'), '(unparseable endpoint)');
});

test('normalizeEndpoint ignores a trailing slash and case', () => {
  assert.equal(
    normalizeEndpoint('https://RPC.Example.com/v1/abc/'),
    normalizeEndpoint('https://rpc.example.com/v1/abc'),
  );
});

test('isSecretEnvName classifies credential-bearing names', () => {
  for (const name of [
    'MONAD_RELAYER_PRIVATE_KEY',
    'DEPLOYER_MNEMONIC',
    'XYX_PRF_SECRET',
    'MONADSCAN_API_KEY',
    'WEB_AUTH_CREDENTIAL_ID',
    'EVIDENCE_SALT',
    'ATTESTOR_PASSPHRASE',
  ]) {
    assert.equal(isSecretEnvName(name), true, name);
  }
  for (const name of ['XYX_RP_ID', 'MONAD_USDC_ADDRESS', 'XYX_PRIMARY_RPC_URL', 'PATH']) {
    assert.equal(isSecretEnvName(name), false, name);
  }
});

// ===========================================================================
// 12. Report shape
// ===========================================================================

test('serializeReadinessReport emits a stable, parseable document', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbes(), artifacts: ALL_ARTIFACTS });
  const parsed = JSON.parse(serializeReadinessReport(report)) as Record<string, unknown>;
  assert.equal(parsed.schema, 'xyx-deployment-readiness');
  assert.equal(parsed.version, '2');
  assert.equal(parsed.status, READINESS_STATUS.READY);
  assert.equal(parsed.authorization, 'NOT_GRANTED');
  assert.equal(parsed.expectedChainId, 10143);
  assert.deepEqual(parsed.observedChainIds, { primary: 10143, secondary: 10143 });
  assert.equal('chainId' in parsed, false, 'the ambiguous top-level chainId field is gone');
  assert.deepEqual(parsed.failures, []);
  assert.ok(Array.isArray(parsed.checks));
});

test('every failure code in the catalogue is reachable from a report', async () => {
  // Guards against codes that exist in the catalogue but can never be emitted.
  const report = await runReadiness(baseEnv({ rpIdHash: '0xdead' }), { probes: mockProbes() });
  for (const code of report.failures) {
    assert.ok(
      Object.values(READINESS_FAILURE_CODES).includes(code as never),
      `unknown failure code ${code}`,
    );
  }
});

test('a READY report still does not grant authorization', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbes(), artifacts: ALL_ARTIFACTS });
  assert.equal(report.status, 'READY_FOR_EXPLICIT_BROADCAST_AUTHORIZATION');
  assert.equal(report.authorization, 'NOT_GRANTED');
});

// ===========================================================================
// 13. Expected vs observed chain facts
//
// The report used to carry one top-level `chainId` field that meant "what the
// harness expects" on some paths and "what an endpoint returned" on others, so
// an offline run printed the expected 10143 with no observation behind it. The
// field is now split: `expectedChainId` is a constant, `observedChainIds` is
// evidence, and a machine consumer cannot confuse the two.
// ===========================================================================

test('expected vs observed: an offline run reports the expectation and no observation', async () => {
  const report = await runReadiness(baseEnv(), { offline: true });
  assert.equal(report.expectedChainId, 10143, 'the expectation is still stated');
  assert.equal(report.observedChainIds.primary, null, 'the primary endpoint was never queried');
  assert.equal(report.observedChainIds.secondary, null, 'the secondary endpoint was never queried');
});

test('expected vs observed: a READY dual-RPC run observed 10143 on BOTH endpoints', async () => {
  const report = await runReadiness(baseEnv(), { probes: mockProbes(), artifacts: ALL_ARTIFACTS });
  assert.equal(report.status, READINESS_STATUS.READY);
  assert.deepEqual(
    report.observedChainIds,
    { primary: 10143, secondary: 10143 },
    'a READY report must show both live endpoints reporting the expected chain',
  );
});

test('expected vs observed: disagreement keeps each endpoint\'s distinct observed value', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbePair({ chainId: 10143 }, { chainId: 1 }),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('CHAIN_ID_DISAGREEMENT'));
  assert.deepEqual(
    report.observedChainIds,
    { primary: 10143, secondary: 1 },
    'the actually observed values survive the failure; neither is overwritten',
  );
  assert.equal(report.expectedChainId, 10143);
});

test('expected vs observed: a failed secondary probe records secondary as null, not 10143', async () => {
  const report = await runReadiness(baseEnv(), {
    probes: mockProbePair({ chainId: 10143 }, { failChainId: true }),
  });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.ok(codes(report).includes('RPC_PROBE_FAILED'));
  assert.equal(report.observedChainIds.primary, 10143, 'the endpoint that answered is recorded');
  assert.equal(
    report.observedChainIds.secondary,
    null,
    'a probe that threw is null, never the expected chain ID',
  );
});

test('expected vs observed: no ambiguous top-level chainId survives into the JSON', async () => {
  const offline = JSON.parse(
    serializeReadinessReport(await runReadiness(baseEnv(), { offline: true })),
  ) as Record<string, unknown>;
  assert.equal('chainId' in offline, false, 'no top-level chainId key may remain');
  assert.equal('chainId' in (offline.observedChainIds as object), false);
  assert.deepEqual(offline.observedChainIds, { primary: null, secondary: null });

  const ready = JSON.parse(
    serializeReadinessReport(
      await runReadiness(baseEnv(), { probes: mockProbes(), artifacts: ALL_ARTIFACTS }),
    ),
  ) as Record<string, unknown>;
  assert.equal('chainId' in ready, false, 'no top-level chainId key may remain on any path');
  assert.equal(ready.expectedChainId, 10143);

  // The checks themselves must not smuggle an observation back in as an
  // expectation either: check ids carry the truth, never a fabricated number.
  for (const check of ready.checks as Array<{ id: string; detail: string }>) {
    assert.ok(!check.id.includes('chainId'), `${check.id} leaks the retired field name`);
  }
});

test('expected vs observed: serialized JSON leaks no RPC URL, credential, or evidence', async () => {
  // A deliberately leaky endpoint: path, query credential and port. Redaction
  // keeps the scheme+host and drops everything an attacker could use.
  const leakyPrimary = 'https://rpc.example.com:8543/v2/secret-api-key?project=xyx';
  const leakySecondary = 'https://node.example.com:8543/key/another-secret';
  const probes: ReadinessRpcProbes = {
    primary: {
      ...createMockProbe('primary'),
      async chainId(): Promise<number> {
        throw new Error(`connect ECONNREFUSED ${leakyPrimary}`);
      },
    },
    secondary: {
      ...createMockProbe('secondary'),
      async chainId(): Promise<number> {
        throw new Error(`pool failure ${leakySecondary}`);
      },
    },
  };
  const secretKeys = [
    'XYX_PRIVATE_KEY',
    'DEPLOYER_PRIVATE_KEY',
    'BUYER_PRIVATE_KEY',
    'RELAYER_PRIVATE_KEY',
    'MONAD_RPC_API_KEY',
  ];
  const report = await runReadiness(
    baseEnv({ primaryRpcUrl: leakyPrimary, secondaryRpcUrl: leakySecondary }),
    { probes, rawEnvKeys: [...Object.keys(process.env), ...secretKeys] },
  );
  const serialized = serializeReadinessReport(report);

  assertReportHasNoSecrets(serialized, secretKeys);
  // Everything that acts as a credential — path, query string, userinfo — is
  // dropped. The scheme and host survive, which is the documented boundary of
  // redactRpcUrl (it keeps the port too, as the redactRpcUrl test asserts).
  for (const secret of [
    '/v2/secret-api-key',
    'secret-api-key',
    'project=xyx',
    '/key/another-secret',
    'another-secret',
  ]) {
    assert.ok(!serialized.includes(secret), `serialized report leaked ${secret}`);
  }
  for (const keyLike of [/0x[0-9a-fA-F]{64}/, /BEGIN [A-Z ]*PRIVATE KEY/]) {
    assert.ok(!keyLike.test(serialized), `serialized report matches ${keyLike}`);
  }
  for (const sensitive of [
    RP_ID, // Relying Party ID
    RP_ID_HASH,
    TOKEN, // full addresses are not printed
    VERIFIER,
    REGISTRY,
    PROTOCOL,
    'deadbeef',
    'salt',
    'signature',
  ]) {
    if (sensitive === 'salt' || sensitive === 'signature') {
      assert.ok(!serialized.toLowerCase().includes(`${sensitive}=`));
      continue;
    }
    assert.ok(!serialized.includes(sensitive), `serialized report leaked ${sensitive}`);
  }
  // The honest half: a failed probe still records that nothing was observed.
  assert.deepEqual(report.observedChainIds, { primary: null, secondary: null });
  assert.equal(report.status, READINESS_STATUS.NOT_READY);
  assert.equal(report.expectedChainId, 10143);
});
