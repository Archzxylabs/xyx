/**
 * Secondary RPC alignment tests.
 *
 * `scripts/claim-refund.ts` records a refund only after TWO independent
 * endpoints observed the same finalized receipt, so the secondary endpoint is a
 * load-bearing input, not a convenience. These tests pin the policy that keeps it
 * load-bearing: the one documented variable name is the only name, every unusable
 * value fails closed with a stable code, and no refusal ever echoes the URL it
 * rejected (a rejected URL is exactly the one that may carry credentials).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ObservationRpcError,
  SECONDARY_RPC_ENV_VAR,
  resolveObservationRpcUrl,
  type ObservationRpcErrorCode,
} from '../src/observation-rpc.js';

const PRIMARY = 'https://testnet-rpc.monad.xyz';
const DISTINCT = 'https://monad-testnet.secondary.example';

/** Only the documented variable is set; every other name is absent. */
function envWith(value: string | undefined): Record<string, string | undefined> {
  return { [SECONDARY_RPC_ENV_VAR]: value, XYX_RPC_URL: PRIMARY };
}

test('the canonical variable is the documented name', () => {
  assert.equal(SECONDARY_RPC_ENV_VAR, 'XYX_SECONDARY_RPC_URL');
});

test('the documented variable is accepted', () => {
  assert.equal(resolveObservationRpcUrl(PRIMARY, envWith(DISTINCT)), DISTINCT);
});

test('a missing canonical variable fails closed', () => {
  for (const missing of [undefined, '', '   ']) {
    assert.throws(
      () => resolveObservationRpcUrl(PRIMARY, envWith(missing)),
      (error: unknown) =>
        error instanceof ObservationRpcError && error.code === 'MISSING_XYX_SECONDARY_RPC_URL',
      `must fail closed for ${JSON.stringify(missing)}`,
    );
  }
});

test('the legacy variable alone does not satisfy the resolver', () => {
  // XYX_RPC_URL_SECONDARY was read by an earlier claim-refund.ts and appears in
  // no documentation. An operator carrying that variable must not get a silent
  // two-endpoint verification that the harness never configured.
  const env: Record<string, string | undefined> = {
    XYX_RPC_URL_SECONDARY: DISTINCT,
    XYX_RPC_URL: PRIMARY,
  };
  assert.throws(
    () => resolveObservationRpcUrl(PRIMARY, env),
    (error: unknown) =>
      error instanceof ObservationRpcError && error.code === 'MISSING_XYX_SECONDARY_RPC_URL',
  );
});

test('the primary RPC alone does not satisfy the resolver', () => {
  assert.throws(
    () => resolveObservationRpcUrl(PRIMARY, { XYX_RPC_URL: PRIMARY }),
    (error: unknown) =>
      error instanceof ObservationRpcError && error.code === 'MISSING_XYX_SECONDARY_RPC_URL',
  );
});

test('a secondary identical to the primary is refused', () => {
  for (const same of [PRIMARY, `${PRIMARY}/`]) {
    assert.throws(
      () => resolveObservationRpcUrl(PRIMARY, envWith(same)),
      (error: unknown) =>
        error instanceof ObservationRpcError && error.code === 'RPC_NOT_DISTINCT',
      `must refuse ${JSON.stringify(same)}`,
    );
  }
});

test('malformed secondary URLs fail closed', () => {
  for (const malformed of [
    'not-a-url',
    'ftp://host.example',
    'testnet-rpc.monad.xyz',
    'wss://host.example',
    '//host.example',
  ]) {
    assert.throws(
      () => resolveObservationRpcUrl(PRIMARY, envWith(malformed)),
      (error: unknown) =>
        error instanceof ObservationRpcError &&
        error.code === 'INVALID_XYX_SECONDARY_RPC_URL',
      `must reject ${JSON.stringify(malformed)}`,
    );
  }
});

test('credential-bearing and query-bearing secondary URLs fail closed', () => {
  const unsafe = [
    'https://user:secret@host.example',
    'https://token@host.example',
    `https://host.example?apikey=${'s'.repeat(32)}`,
    `https://host.example/rpc?key=${'k'.repeat(32)}`,
  ];
  for (const value of unsafe) {
    assert.throws(
      () => resolveObservationRpcUrl(PRIMARY, envWith(value)),
      (error: unknown) =>
        error instanceof ObservationRpcError &&
        error.code === 'UNSAFE_XYX_SECONDARY_RPC_URL',
      `must reject ${JSON.stringify(value)}`,
    );
  }
});

test('every refusal message is the code and nothing else', () => {
  // A failure that named its reason in prose would eventually quote the URL.
  const cases: Array<[string, ObservationRpcErrorCode]> = [
    [PRIMARY, 'RPC_NOT_DISTINCT'],
    ['not-a-url', 'INVALID_XYX_SECONDARY_RPC_URL'],
    ['https://user:secret@host.example', 'UNSAFE_XYX_SECONDARY_RPC_URL'],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => resolveObservationRpcUrl(PRIMARY, envWith(value)),
      (error: unknown) => error instanceof ObservationRpcError && error.message === code,
    );
  }
});

test('no refusal output contains the rejected URL', () => {
  const secrets = ['https://user:hunter2@host.example', `https://host.example?apikey=${'z'.repeat(40)}`];
  for (const value of secrets) {
    let rendered = '';
    try {
      resolveObservationRpcUrl(PRIMARY, envWith(value));
    } catch (error) {
      assert.ok(error instanceof ObservationRpcError);
      rendered = `${error.name} ${error.message} ${error.code} ${String(error)}`;
    }
    assert.ok(rendered.length > 0, 'expected a refusal to render');
    for (const fragment of ['hunter2', 'host.example', 'apikey', value]) {
      assert.ok(!rendered.includes(fragment), `refusal output must never contain ${fragment}`);
    }
  }
});
