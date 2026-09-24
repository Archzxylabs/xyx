/**
 * Tests for delivery-chain.ts: Monad Testnet guard, request builders, receipt helpers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { keccak256, toHex } from 'viem';

import {
  MONAD_TESTNET_CHAIN_ID,
  createMonadClient,
  validateContractAddresses,
  buildProposalRequest,
  buildAcceptRequest,
  buildCancelProposalRequest,
  buildFundRequest,
  buildSubmitRequest,
  buildResolveRequest,
  buildClaimExpiryRefundRequest,
  extractSettlementEvent,
  readVerdictConsumed,
  computeDomainSeparator,
} from '../src/delivery-chain';

// The exact JSON text a WebAuthn authenticator returns for a `get` assertion.
// `clientDataJSON` is a Solidity `string`, so it reaches the request builder as
// a plain string and must never be Hex-encoded — the registry re-serializes the
// same text when it verifies the P-256 signature.
const REAL_CLIENT_DATA_JSON =
  '{"type":"webauthn.get","challenge":"QUJDRA","origin":"https://xyx.local","crossOrigin":false}';

// ===========================================================================
// Chain ID guard
// ===========================================================================

test('MONAD_TESTNET_CHAIN_ID is 10143', () => {
  assert.strictEqual(MONAD_TESTNET_CHAIN_ID, 10143);
});

// ===========================================================================
// Contract address validation
// ===========================================================================

test('validateContractAddresses accepts valid addresses', () => {
  const result = validateContractAddresses({
    protocol: '0x' + 'ab'.repeat(20),
    registry: '0x' + 'cd'.repeat(20),
    p256Verifier: '0x' + 'ef'.repeat(20),
    paymentToken: '0x' + '01'.repeat(20),
  });
  assert.strictEqual(result.protocol, '0x' + 'ab'.repeat(20));
  assert.strictEqual(result.paymentToken, '0x' + '01'.repeat(20));
});

test('validateContractAddresses handles optional paymentToken', () => {
  const result = validateContractAddresses({
    protocol: '0x' + 'ab'.repeat(20),
    registry: '0x' + 'cd'.repeat(20),
    p256Verifier: '0x' + 'ef'.repeat(20),
  });
  assert.strictEqual(result.paymentToken, undefined);
});

test('validateContractAddresses rejects zero address', () => {
  assert.throws(() =>
    validateContractAddresses({
      protocol: '0x' + '00'.repeat(20),
      registry: '0x' + 'cd'.repeat(20),
      p256Verifier: '0x' + 'ef'.repeat(20),
    })
  );
});

// ===========================================================================
// Request builders
// ===========================================================================

const VALID_ADDRESSES = {
  protocol: '0x' + 'ab'.repeat(20),
  registry: '0x' + 'cd'.repeat(20),
  p256Verifier: '0x' + 'ef'.repeat(20),
};

test('buildProposalRequest returns correct shape', () => {
  const futureExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const req = buildProposalRequest(
    {
      provider: '0x' + '12'.repeat(20),
      attestor: '0x' + '34'.repeat(20),
      budget: 1000n,
      termsCommitment: '0x' + 'ab'.repeat(32),
      expiresAt: futureExpiry,
    },
    VALID_ADDRESSES
  );
  assert.strictEqual(req.functionName, 'proposeJob');
  assert.strictEqual(req.address, VALID_ADDRESSES.protocol);
  assert.deepStrictEqual(req.args, [
    '0x' + '12'.repeat(20),
    '0x' + '34'.repeat(20),
    '0x' + 'ab'.repeat(32),
    1000n,
    futureExpiry,
  ]);
});

test('buildProposalRequest rejects past expiry', () => {
  assert.throws(() =>
    buildProposalRequest(
      {
        provider: '0x' + '12'.repeat(20),
        attestor: '0x' + '34'.repeat(20),
        budget: 1000n,
        termsCommitment: '0x' + 'ab'.repeat(32),
        expiresAt: BigInt(Math.floor(Date.now() / 1000) - 1),
      },
      VALID_ADDRESSES
    )
  );
});

test('buildSubmitRequest returns correct shape', () => {
  const req = buildSubmitRequest(
    {
      jobId: 1n,
      deliveryCommitment: '0x' + 'cd'.repeat(32),
    },
    VALID_ADDRESSES
  );
  assert.strictEqual(req.functionName, 'submitDelivery');
  assert.deepStrictEqual(req.args, [1n, '0x' + 'cd'.repeat(32)]);
});

test('buildResolveRequest returns correct args for complete decision', () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const req = buildResolveRequest(
    {
      jobId: 1n,
      verdict: {
        termsCommitment: '0x' + 'ab'.repeat(32),
        deliveryCommitment: '0x' + 'cd'.repeat(32),
        evidenceCommitment: '0x' + 'ef'.repeat(32),
        reasonCommitment: '0x' + '01'.repeat(32),
        decision: 1,
        issuedAt: now,
        expiresAt: now + 3600n,
        nonce: 0n,
      },
      attestor: '0x' + '99'.repeat(20),
      assertion: {
        authenticatorData: '0x' + 'aa'.repeat(37),
        clientDataJSON: REAL_CLIENT_DATA_JSON,
        challengeIndex: 33,
        typeIndex: 55,
        r: '0x' + 'cc'.repeat(32),
        s: '0x' + 'dd'.repeat(32),
      },
    },
    VALID_ADDRESSES
  );
  assert.strictEqual(req.functionName, 'resolveJob');
  // Canonical API: args = [JobVerdict, WebAuthnAuth] (2-element tuple)
  assert.strictEqual(req.args.length, 2);
  assert.strictEqual(req.args[0].jobId, 1n);
  assert.strictEqual(req.args[0].decision, 1);
  assert.strictEqual(req.args[0].evidenceCommitment, '0x' + 'ef'.repeat(32));
  assert.strictEqual(req.args[1].authenticatorData, '0x' + 'aa'.repeat(37));
  assert.strictEqual(req.args[1].challengeIndex, 33);
  assert.strictEqual(req.args[1].typeIndex, 55);
  assert.strictEqual(req.args[1].clientDataJSON, REAL_CLIENT_DATA_JSON);
  assert.strictEqual(req.from, '0x' + '99'.repeat(20));
});

test('buildResolveRequest rejects decision 3', () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  assert.throws(() =>
    buildResolveRequest(
      {
        jobId: 1n,
        verdict: {
          termsCommitment: '0x' + 'ab'.repeat(32),
          deliveryCommitment: '0x' + 'cd'.repeat(32),
          evidenceCommitment: '0x' + 'ef'.repeat(32),
          reasonCommitment: '0x' + '01'.repeat(32),
          decision: 3,
          issuedAt: now,
          expiresAt: now + 3600n,
          nonce: 0n,
        },
        attestor: '0x' + '99'.repeat(20),
        assertion: {
          authenticatorData: '0x' + 'aa'.repeat(37),
          clientDataJSON: REAL_CLIENT_DATA_JSON,
          challengeIndex: 33,
          typeIndex: 55,
          r: '0x' + 'cc'.repeat(32),
          s: '0x' + 'dd'.repeat(32),
        },
      },
      VALID_ADDRESSES
    )
  );
});

test('buildClaimExpiryRefundRequest returns correct shape', () => {
  const req = buildClaimExpiryRefundRequest({ jobId: 1n }, VALID_ADDRESSES);
  assert.strictEqual(req.functionName, 'claimExpiryRefund');
  assert.deepStrictEqual(req.args, [1n]);
});

// ===========================================================================
// extractSettlementEvent
// ===========================================================================

test('extractSettlementEvent returns null for empty logs', () => {
  const result = extractSettlementEvent({
    blockNumber: 1n,
    transactionHash: '0x' + 'aa'.repeat(32),
    status: 'success',
    gasUsed: 50000n,
    logs: [],
  });
  assert.strictEqual(result, null);
});

test('extractSettlementEvent detects JobResolved event', () => {
  const JobResolvedTopic = keccak256(
    toHex(new TextEncoder().encode('JobResolved(uint256,address,uint8,bytes32,bytes32,bytes32)'))
  );
  const protocolAddr = '0x' + 'ab'.repeat(20);
  const result = extractSettlementEvent(
    {
      blockNumber: 1n,
      transactionHash: '0x' + 'aa'.repeat(32),
      status: 'success',
      gasUsed: 50000n,
      logs: [
        {
          address: protocolAddr,
          topics: [
            JobResolvedTopic,
            '0x' + '00'.repeat(31) + '01', // jobId = 1
            '0x' + '00'.repeat(12) + 'ab'.repeat(20), // attestor
            '0x' + 'cd'.repeat(32), // verdictDigest
          ],
          data: '0x' + '00'.repeat(31) + '01' + 'ab'.repeat(32) + 'cd'.repeat(32), // decision=1, evidenceCommitment, reasonCommitment
        },
      ],
    },
    protocolAddr
  );
  assert.ok(result !== null, 'should detect JobResolved event');
  assert.strictEqual(result!.type, 'JobResolved');
  assert.strictEqual(result!.jobId, 1n);
  assert.strictEqual(result!.decision, 1);
  assert.strictEqual(result!.attestor, '0x' + 'ab'.repeat(20));
  assert.strictEqual(result!.verdictDigest, '0x' + 'cd'.repeat(32));
});

test('extractSettlementEvent detects JobExpired event', () => {
  const JobExpiredTopic = keccak256(
    toHex(new TextEncoder().encode('JobExpired(uint256,address,uint256)'))
  );
  const buyerAddress = '0x' + 'ab'.repeat(20);
  const protocolAddr = '0x' + 'ab'.repeat(20);
  const result = extractSettlementEvent(
    {
      blockNumber: 1n,
      transactionHash: '0x' + 'bb'.repeat(32),
      status: 'success',
      gasUsed: 30000n,
      logs: [
        {
          address: protocolAddr,
          topics: [
            JobExpiredTopic,
            '0x' + '00'.repeat(31) + '02', // jobId = 2
            '0x' + '00'.repeat(12) + buyerAddress.slice(2), // buyer, left-padded address word
          ],
          data: '0x' + '00'.repeat(31) + '64', // budget = 100
        },
      ],
    },
    protocolAddr
  );
  assert.ok(result !== null, 'should detect JobExpired event');
  assert.strictEqual(result!.type, 'JobExpired');
  assert.strictEqual(result!.jobId, 2n);
  assert.strictEqual(result!.buyer, buyerAddress);
  assert.strictEqual(result!.budget, 100n);
});

// ===========================================================================
// EIP-712 domain separator
// ===========================================================================

test('computeDomainSeparator returns bytes32 hash', () => {
  const result = computeDomainSeparator('0x' + 'ab'.repeat(20), 10143);
  assert.strictEqual(result.length, 66);
});

test('computeDomainSeparator uses default chainId 10143', () => {
  const result = computeDomainSeparator('0x' + 'ab'.repeat(20));
  assert.strictEqual(result.length, 66);
});

// ===========================================================================
// resolveJob / WebAuthnAuth canonical tuple shape
//
// The SDK's ABI is a hand-written literal. `buildResolveRequest` used to accept
// a hex `clientDataJSON` and had no `typeIndex`, which produced calldata for a
// `resolveJob` selector that does not exist on the contract. These tests pin the
// real WebAuthn shape so the same mistake cannot pass green again.
// ===========================================================================

const VALID_RESOLVE_PARAMS = () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    jobId: 1n,
    verdict: {
      termsCommitment: '0x' + 'ab'.repeat(32),
      deliveryCommitment: '0x' + 'cd'.repeat(32),
      evidenceCommitment: '0x' + 'ef'.repeat(32),
      reasonCommitment: '0x' + '01'.repeat(32),
      decision: 1 as const,
      issuedAt: now - 60n,
      expiresAt: now + 3600n,
      nonce: 0n,
    },
    attestor: '0x' + '99'.repeat(20),
    assertion: {
      authenticatorData: '0x' + 'aa'.repeat(37),
      clientDataJSON: REAL_CLIENT_DATA_JSON,
      challengeIndex: 33,
      typeIndex: 55,
      r: '0x' + 'cc'.repeat(32),
      s: '0x' + 'dd'.repeat(32),
    },
  };
};

test('buildResolveRequest emits the canonical WebAuthnAuth field order', () => {
  const req = buildResolveRequest(VALID_RESOLVE_PARAMS(), VALID_ADDRESSES);
  const assertion = req.args[1] as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(assertion), [
    'authenticatorData',
    'clientDataJSON',
    'challengeIndex',
    'typeIndex',
    'r',
    's',
  ]);
  // clientDataJSON stays a string; viem UTF-8 encodes it for the Solidity
  // `string` ABI type. It is NOT hex and is not hex-encoded here.
  assert.strictEqual(typeof assertion.clientDataJSON, 'string');
  assert.strictEqual(assertion.clientDataJSON, REAL_CLIENT_DATA_JSON);
  assert.strictEqual(assertion.typeIndex, 55);
  assert.strictEqual(assertion.challengeIndex, 33);
});

test('buildResolveRequest accepts a real ceremony JSON string clientDataJSON', () => {
  const req = buildResolveRequest(VALID_RESOLVE_PARAMS(), VALID_ADDRESSES);
  assert.strictEqual(req.functionName, 'resolveJob');
  assert.strictEqual(req.from, VALID_RESOLVE_PARAMS().attestor);
});

test('buildResolveRequest rejects an assertion missing typeIndex', () => {
  const params = VALID_RESOLVE_PARAMS();
  // Deliberately drop typeIndex, exactly as the pre-fix builder had no such field.
  const { typeIndex: _omitted, ...withoutTypeIndex } = params.assertion;
  assert.throws(
    () => buildResolveRequest({ ...params, assertion: withoutTypeIndex }, VALID_ADDRESSES),
    /INVALID_ASSERTION: typeIndex must be a non-negative safe integer/
  );
});

test('buildResolveRequest rejects a non-bytes32 r', () => {
  const params = VALID_RESOLVE_PARAMS();
  assert.throws(
    () => buildResolveRequest({ ...params, assertion: { ...params.assertion, r: '0xcc' } }, VALID_ADDRESSES),
    /INVALID_ASSERTION: r must be a 32-byte Hex value/
  );
});

test('buildResolveRequest rejects a non-bytes32 s', () => {
  const params = VALID_RESOLVE_PARAMS();
  assert.throws(
    () =>
      buildResolveRequest(
        { ...params, assertion: { ...params.assertion, s: '0xdd'.repeat(31) } },
        VALID_ADDRESSES
      ),
    /INVALID_ASSERTION: s must be a 32-byte Hex value/
  );
});

test('buildResolveRequest rejects a Hex clientDataJSON', () => {
  const params = VALID_RESOLVE_PARAMS();
  // The old input type declared clientDataJSON: Hex. Hex text is not JSON, so
  // it must be refused rather than silently UTF-8 encoded as literal hex text.
  assert.throws(
    () =>
      buildResolveRequest(
        { ...params, assertion: { ...params.assertion, clientDataJSON: '0x' + 'bb'.repeat(64) } },
        VALID_ADDRESSES
      ),
    /INVALID_ASSERTION: clientDataJSON/
  );
});

test('buildResolveRequest rejects a non-JSON string clientDataJSON', () => {
  const params = VALID_RESOLVE_PARAMS();
  assert.throws(
    () =>
      buildResolveRequest(
        { ...params, assertion: { ...params.assertion, clientDataJSON: 'not json at all' } },
        VALID_ADDRESSES
      ),
    /INVALID_ASSERTION: clientDataJSON must be valid JSON text/
  );
});

test('buildResolveRequest rejects a negative or fractional challengeIndex/typeIndex', () => {
  const params = VALID_RESOLVE_PARAMS();
  for (const bad of [-1, 1.5, Number.NaN, '3' as unknown as number]) {
    assert.throws(
      () =>
        buildResolveRequest(
          { ...params, assertion: { ...params.assertion, challengeIndex: bad } },
          VALID_ADDRESSES
        ),
      /INVALID_ASSERTION: challengeIndex/
    );
    assert.throws(
      () =>
        buildResolveRequest(
          { ...params, assertion: { ...params.assertion, typeIndex: bad } },
          VALID_ADDRESSES
        ),
      /INVALID_ASSERTION: typeIndex/
    );
  }
});

test('buildResolveRequest rejects non-bytes32 commitment words', () => {
  const params = VALID_RESOLVE_PARAMS();
  assert.throws(
    () =>
      buildResolveRequest(
        { ...params, verdict: { ...params.verdict, termsCommitment: '0xab' } },
        VALID_ADDRESSES
      ),
    /INVALID_ASSERTION: termsCommitment must be a 32-byte Hex value/
  );
});

// ===========================================================================
// readVerdictConsumed: canonical read over an ABI that contains consumedVerdicts
// ===========================================================================

test('readVerdictConsumed forms a canonical read request over an ABI containing consumedVerdicts', async () => {
  const captured: Record<string, unknown> = {};
  const stubClient = {
    async readContract(request: Record<string, unknown>) {
      Object.assign(captured, request);
      return true;
    },
  };

  const verdictDigest = keccak256(toHex(randomBytes(32)));
  const result = await readVerdictConsumed({
    client: stubClient as unknown as Parameters<typeof readVerdictConsumed>[0]['client'],
    addresses: VALID_ADDRESSES,
    verdictDigest,
  });

  assert.equal(result, true);

  // The SDK must have actually encoded against an ABI entry named consumedVerdicts
  // taking one bytes32 and returning bool; a missing entry throws inside viem.
  const abi = captured.abi as Array<Record<string, unknown>>;
  const entry = abi.find((item) => item.name === 'consumedVerdicts');
  assert.ok(entry, 'deliveryProtocolAbi must expose consumedVerdicts');
  assert.equal(entry?.type, 'function');
  assert.equal(entry?.stateMutability, 'view');
  assert.deepEqual(
    (entry?.inputs as Array<Record<string, unknown>>).map((input) => input.type),
    ['bytes32']
  );
  assert.deepEqual(
    (entry?.outputs as Array<Record<string, unknown>>).map((output) => output.type),
    ['bool']
  );
  assert.equal(captured.functionName, 'consumedVerdicts');
  assert.deepEqual(captured.args, [verdictDigest]);
  assert.equal(captured.address, VALID_ADDRESSES.protocol);
});

test('readVerdictConsumed rejects a malformed verdict digest before any RPC call', async () => {
  let called = false;
  const stubClient = {
    async readContract() {
      called = true;
      return false;
    },
  };

  await assert.rejects(
    () =>
      readVerdictConsumed({
        client: stubClient as unknown as Parameters<typeof readVerdictConsumed>[0]['client'],
        addresses: VALID_ADDRESSES,
        verdictDigest: '0xdeadbeef',
      }),
    /INVALID_VERDICT_DIGEST/
  );
  assert.equal(called, false, 'must fail closed before touching the client');
});
