/**
 * Demo-truthfulness tests for the two places a browser can invent an on-chain fact.
 *
 * Item 1 — an explorer link. A MonadVision link asserts "this transaction is on
 * Monad Testnet", so it may only be emitted for a transaction that canonical
 * dual-RPC settlement verification actually verified. These tests drive
 * `canShowVerifiedExplorerTransaction`, the single policy the demo page renders
 * through, over every verification category, over a hash that exists but was
 * never verified, and over a manifest outcome that claims a settlement nothing
 * observed.
 *
 * Item 2 — the buyer proposal builder. `prepareBuyerProposal` is what the buyer
 * browser runs, so its result is exactly where a fabricated hash, receipt, block
 * number, or job ID would come from. These tests assert the result carries none
 * of them, and that {@link canOfferFunding} cannot be satisfied by anything
 * computed locally.
 *
 * @module demo-truthfulness
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import {
  canShowVerifiedExplorerTransaction,
} from '../src/demo-state.js';
import type { VerificationCategory } from '../src/verification.js';
import {
  canOfferFunding,
  FUNDING_UNAVAILABLE_REASON,
  prepareBuyerProposal,
  PREPARED_NOT_BROADCAST_LABEL,
} from '../src/buyer-proposal.js';

const provider = '0x0000000000000000000000000000000000000004' as Address;
const attestor = '0x0000000000000000000000000000000000000005' as Address;
const protocol = '0x0000000000000000000000000000000000000001' as Address;
const registry = '0x0000000000000000000000000000000000000006' as Address;
const p256Verifier = '0x0000000000000000000000000000000000000007' as Address;
const paymentToken = '0x0000000000000000000000000000000000000002' as Address;

const addresses = { protocol, registry, p256Verifier, paymentToken };

const salt = `0x${'ab'.repeat(32)}` as Hex;

/** A fully valid private terms object, with a future expiry and a distinct buyer. */
function terms(overrides: Record<string, unknown> = {}) {
  const future = Math.floor(Date.now() / 1000) + 3600;
  return {
    schema: 'xyx.private-terms',
    chainId: 10143,
    protocol,
    paymentToken,
    buyer: '0x0000000000000000000000000000000000000003',
    provider,
    attestor,
    budgetAtomic: '20000',
    expiresAt: future,
    task: { prompt: 'send 0.01 USDC' },
    acceptancePolicy: { maxRetries: 2 },
    ...overrides,
  } as Parameters<typeof prepareBuyerProposal>[0]['terms'];
}

// ===========================================================================
// Item 1: explorer links require observed verification
// ===========================================================================

test('a transaction explorer link renders only for verified settlement states', () => {
  assert.equal(canShowVerifiedExplorerTransaction('LIVE_VERIFIED', 'COMPLETE'), true);
  assert.equal(canShowVerifiedExplorerTransaction('LIVE_VERIFIED', 'EXPIRED'), true);
  // REJECT is itself a positive canonical rejection verification result, so the
  // transaction that proved the rejection may be linked.
  assert.equal(canShowVerifiedExplorerTransaction('REJECT', 'REJECT'), true);
});

test('no explorer link for unverified, pending, or conflicting verification', () => {
  for (const verification of ['PENDING', 'UNVERIFIED', 'CONFLICT'] as VerificationCategory[]) {
    assert.equal(
      canShowVerifiedExplorerTransaction(verification, 'COMPLETE'),
      false,
      `${verification} must not link`,
    );
    assert.equal(
      canShowVerifiedExplorerTransaction(verification, 'REJECT'),
      false,
      `${verification} must not link`,
    );
    assert.equal(
      canShowVerifiedExplorerTransaction(verification, 'EXPIRED'),
      false,
      `${verification} must not link`,
    );
  }
});

test('no explorer link when verification was never attempted or configuration was missing', () => {
  for (const verification of [undefined] as Array<VerificationCategory | undefined>) {
    for (const outcome of ['COMPLETE', 'REJECT', 'EXPIRED']) {
      assert.equal(canShowVerifiedExplorerTransaction(verification, outcome), false);
    }
  }
});

test('no explorer link for an outcome that is not a canonical settlement', () => {
  for (const outcome of [undefined, '', 'PENDING', 'pending', 'unknown', 'COMPLETE_FORCED', 'complete']) {
    assert.equal(
      canShowVerifiedExplorerTransaction('LIVE_VERIFIED', outcome),
      false,
      `${JSON.stringify(outcome)} is not a verified settlement outcome`,
    );
  }
});

test('a REJECT verification never links an expiry refund transaction', () => {
  // The rejection proof is the resolveJob transaction, not claimExpiryRefund.
  assert.equal(canShowVerifiedExplorerTransaction('REJECT', 'EXPIRED'), false);
});

// ===========================================================================
// Item 2: the builder produces a request, never chain evidence
// ===========================================================================

test('proposal preparation returns a commitment and a request, and nothing chain-shaped', () => {
  const prepared = prepareBuyerProposal({ terms: terms(), salt, addresses });
  assert.match(prepared.termsCommitment, /^0x[0-9a-f]{64}$/);
  assert.equal(prepared.request.functionName, 'proposeJob');
  assert.equal(prepared.request.address, protocol);
});

test('proposal preparation produces no transaction hash, receipt, block, gas, finality, or job ID', () => {
  const prepared = prepareBuyerProposal({ terms: terms(), salt, addresses });
  // Collect every own key anywhere in the result, at any depth. ABI fragments do
  // carry keys like "jobId" (a decoded event input), so a raw substring search
  // would match the contract's own vocabulary rather than an invented field.
  const keys: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        keys.push(key);
        walk(child);
      }
    }
  };
  walk(prepared);
  for (const forbidden of [
    'hash',
    'blockNumber',
    'gasUsed',
    'receipt',
    'finalized',
    'submitted',
    'pending_finality',
    'jobId',
    'id',
    'explorerUrl',
    'confirmation',
    'transactionHash',
    'txHash',
  ]) {
    assert.ok(!keys.includes(forbidden), `must never carry a ${forbidden} field`);
  }
  // A result keyed like a transaction hash would let a caller render one.
  assert.deepEqual(Object.keys(prepared).sort(), ['request', 'termsCommitment']);
});

test('the built request binds the exact commitment and terms', () => {
  const t = terms();
  const prepared = prepareBuyerProposal({ terms: t, salt, addresses });
  const [requestProvider, requestAttestor, requestCommitment, budget, expiresAt] =
    prepared.request.args;
  assert.equal(requestProvider, provider);
  assert.equal(requestAttestor, attestor);
  assert.equal(requestCommitment, prepared.termsCommitment);
  assert.equal(budget, 20000n);
  assert.equal(expiresAt, BigInt(t.expiresAt));
});

test('the commitment is a real keccak commitment over the private terms', () => {
  // Same terms + same salt must be reproducible; a different salt must differ.
  const a = prepareBuyerProposal({ terms: terms(), salt, addresses });
  const b = prepareBuyerProposal({ terms: terms(), salt, addresses });
  assert.equal(a.termsCommitment, b.termsCommitment);
  const other = `0x${'cd'.repeat(32)}` as Hex;
  const c = prepareBuyerProposal({ terms: terms(), salt: other, addresses });
  assert.notEqual(c.termsCommitment, a.termsCommitment);
});

test('invalid terms are refused rather than partially built', () => {
  assert.throws(
    () => prepareBuyerProposal({ terms: terms({ budgetAtomic: '0' }), salt, addresses }),
    /INVALID_BUDGET|budgetAtomic/,
  );
  assert.throws(
    () => prepareBuyerProposal({ terms: terms({ task: {} }), salt, addresses }),
    /task must contain the private instructions/,
  );
  assert.throws(
    () =>
      prepareBuyerProposal({
        terms: terms({ expiresAt: Math.floor(Date.now() / 1000) - 60 }),
        salt,
        addresses,
      }),
    /INVALID_EXPIRY/,
  );
});

test('preparing a proposal cannot unlock encrow funding', () => {
  // The reference builder never broadcasts, so the only job ID it can hold is
  // null. Whatever a prepared request looks like, funding stays unavailable.
  const prepared = prepareBuyerProposal({ terms: terms(), salt, addresses });
  assert.equal(canOfferFunding(null), false);
  assert.equal(canOfferFunding(undefined), false);
  assert.equal(canOfferFunding(0n), false);
  // Nothing in the prepared result can be read as a job ID.
  assert.ok(!('jobId' in prepared));
  assert.ok(!('id' in prepared));
});

test('only a job ID observed from a real broadcast can unlock funding', () => {
  assert.equal(canOfferFunding(1n), true);
  assert.equal(canOfferFunding(42n), true);
});

test('the prepared-not-broadcast label states all three facts', () => {
  assert.equal(PREPARED_NOT_BROADCAST_LABEL, 'REQUEST PREPARED — NOT BROADCAST');
  assert.match(FUNDING_UNAVAILABLE_REASON, /job ID/);
  assert.match(FUNDING_UNAVAILABLE_REASON, /finalized receipt/);
});
