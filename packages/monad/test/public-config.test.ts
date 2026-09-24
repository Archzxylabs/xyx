import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, type XYXConfig } from '../src/config';

const config: XYXConfig = {
  chainId: 10143,
  protocolAddress: '0x1111111111111111111111111111111111111111',
  registryAddress: '0x2222222222222222222222222222222222222222',
  p256VerifierAddress: '0x3333333333333333333333333333333333333333',
  paymentTokenAddress: '0x4444444444444444444444444444444444444444',
  rpId: 'app.example.com',
  rpcUrl: 'https://primary.example.com',
  secondaryRpcUrl: 'https://secondary.example.com',
};

test('a syntactically complete public configuration requires two distinct clean endpoints', () => {
  assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
  assert.ok(validateConfig({ ...config, secondaryRpcUrl: 'https://primary.example.com/' }).errors.includes('RPC_ENDPOINTS_NOT_DISTINCT'));
  assert.ok(validateConfig({ ...config, secondaryRpcUrl: undefined }).errors.includes('SECONDARY_RPC_URL_MISSING'));
});

test('public RPC URLs cannot carry credentials or token paths', () => {
  for (const unsafe of [
    'https://user:password@rpc.example.com',
    'https://rpc.example.com/api-key',
    'https://rpc.example.com/?token=secret',
    'http://rpc.example.com',
  ]) {
    assert.ok(validateConfig({ ...config, rpcUrl: unsafe }).errors.includes('UNSAFE_PUBLIC_RPC_URL'));
  }
});

test('wallet product configuration refuses missing token and wrong chain', () => {
  assert.ok(validateConfig({ ...config, paymentTokenAddress: undefined }).errors.includes('PAYMENT_TOKEN_ADDRESS_MISSING_OR_INVALID'));
  assert.ok(validateConfig({ ...config, chainId: 1 }).errors.some(code => code.startsWith('WRONG_NETWORK')));
});
